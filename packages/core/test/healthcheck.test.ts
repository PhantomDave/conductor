import { describe, test, expect } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeOnce, waitForHealthy, HealthcheckError } from "../src/executor/healthcheck";
import type { HealthcheckConfig } from "../src/config/schema";

function healthcheck(overrides: Partial<HealthcheckConfig> = {}): HealthcheckConfig {
  return {
    type: "none",
    interval_ms: 20,
    timeout_ms: 2000,
    retries: 5,
    ...overrides,
  };
}

/** process.env with the `string | undefined` values narrowed to `string`. */
function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * Writes a JS script to a temp file and returns a `bun "<path>"` command
 * string. A command-type healthcheck always runs through a real shell (no
 * shell:false option), and on Windows that shell is `cmd.exe /c` - an
 * inline `bun -e "<script>"` gets its quoting mangled in that round trip
 * (even a single, simple quoted argument), silently turning the probe into
 * a no-op. A single unquoted-content `bun "<path>"` argument survives it.
 */
function writeScript(code: string): { command: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "conductor-healthcheck-script-"));
  const scriptPath = join(dir, "script.js");
  writeFileSync(scriptPath, code);
  return {
    command: `bun "${scriptPath}"`,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Binds to an OS-assigned free port and returns the live server + port. */
async function listenOnFreePort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected an AddressInfo"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

/** Returns a port number that is free at the moment this resolves (server closed). */
async function getClosedPort(): Promise<number> {
  const { server, port } = await listenOnFreePort();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("probeOnce - type: none", () => {
  test("is always healthy", async () => {
    const result = await probeOnce(healthcheck({ type: "none" }), {});
    expect(result.ok).toBe(true);
  });
});

describe("probeOnce - type: port", () => {
  test("succeeds when something is listening", async () => {
    const { server, port } = await listenOnFreePort();
    try {
      const result = await probeOnce(healthcheck({ type: "port", port }), {});
      expect(result.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  test("fails when nothing is listening", async () => {
    const port = await getClosedPort();
    const result = await probeOnce(healthcheck({ type: "port", port }), {});
    expect(result.ok).toBe(false);
  });

  test("fails with a clear detail when port is not configured", async () => {
    const result = await probeOnce(healthcheck({ type: "port" }), {});
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("port is required");
  });
});

describe("probeOnce - type: http", () => {
  test("treats any status below 500 as healthy, including 404", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
    try {
      const result = await probeOnce(
        healthcheck({ type: "http", url: `http://localhost:${server.port}/` }),
        {},
      );
      expect(result.ok).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("treats 5xx as unhealthy", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("oops", { status: 503 }) });
    try {
      const result = await probeOnce(
        healthcheck({ type: "http", url: `http://localhost:${server.port}/` }),
        {},
      );
      expect(result.ok).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("interpolates ${VAR} in the configured URL from env", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const result = await probeOnce(
        healthcheck({ type: "http", url: "http://localhost:${TEST_PORT}/" }),
        { TEST_PORT: String(server.port) },
      );
      expect(result.ok).toBe(true);
      expect(result.detail).toContain(String(server.port));
    } finally {
      server.stop(true);
    }
  });

  test("fails when nothing is reachable at the URL", async () => {
    const port = await getClosedPort();
    const result = await probeOnce(
      healthcheck({ type: "http", url: `http://localhost:${port}/` }),
      {},
    );
    expect(result.ok).toBe(false);
  });
});

describe("probeOnce - type: command", () => {
  test("treats exit code 0 as healthy", async () => {
    const result = await probeOnce(healthcheck({ type: "command", command: "exit 0" }), {});
    expect(result.ok).toBe(true);
  });

  test("treats a non-zero exit code as unhealthy", async () => {
    const result = await probeOnce(healthcheck({ type: "command", command: "exit 1" }), {});
    expect(result.ok).toBe(false);
  });

  test("interpolates ${VAR} in the configured command from env", async () => {
    const result = await probeOnce(healthcheck({ type: "command", command: "exit ${CODE}" }), {
      CODE: "0",
    });
    expect(result.ok).toBe(true);
  });

  test("passes the resolved env through to the spawned probe process itself", async () => {
    // Distinct from the ${VAR} test above: that's Conductor textually
    // substituting into the command string before spawning, which would
    // pass even if the child process's own env were never forwarded. This
    // checks process.env inside the *spawned* probe, which only works if
    // `env` actually reaches Bun.spawn.
    const script = writeScript("process.exit(process.env.PROBE_MARKER === 'expected' ? 0 : 1)");
    try {
      const result = await probeOnce(
        healthcheck({ type: "command", command: script.command }),
        testEnv({ PROBE_MARKER: "expected" }),
      );
      expect(result.ok).toBe(true);
    } finally {
      script.cleanup();
    }
  });
});

describe("waitForHealthy", () => {
  test("resolves immediately when there's no healthcheck configured", async () => {
    await expect(waitForHealthy("test/none", undefined, {})).resolves.toBeUndefined();
  });

  test("resolves immediately for type: none", async () => {
    await expect(
      waitForHealthy("test/none", healthcheck({ type: "none" }), {}),
    ).resolves.toBeUndefined();
  });

  test("succeeds once the probe starts passing, after actually retrying", async () => {
    const port = await getClosedPort();
    let delayedServer: Server | undefined;
    const timer = setTimeout(() => {
      delayedServer = createServer();
      delayedServer.listen(port, "localhost");
    }, 150);

    try {
      const results: boolean[] = [];
      await waitForHealthy(
        "test/delayed",
        healthcheck({ type: "port", port, interval_ms: 40, retries: 30, timeout_ms: 5000 }),
        {},
        { onAttempt: (_i, result) => results.push(result.ok) },
      );
      expect(results.at(-1)).toBe(true);
      expect(results.some((ok) => !ok)).toBe(true); // actually retried, didn't just get lucky
    } finally {
      clearTimeout(timer);
      delayedServer?.close();
    }
  });

  test("throws HealthcheckError after exhausting retries", async () => {
    const port = await getClosedPort();
    await expect(
      waitForHealthy(
        "test/never",
        healthcheck({ type: "port", port, interval_ms: 10, retries: 3, timeout_ms: 5000 }),
        {},
      ),
    ).rejects.toBeInstanceOf(HealthcheckError);
  });

  test("reports every attempt index via onAttempt before giving up", async () => {
    const port = await getClosedPort();
    const attempts: number[] = [];
    await expect(
      waitForHealthy(
        "test/count",
        healthcheck({ type: "port", port, interval_ms: 10, retries: 3, timeout_ms: 5000 }),
        {},
        { onAttempt: (i) => attempts.push(i) },
      ),
    ).rejects.toThrow();
    expect(attempts).toEqual([0, 1, 2]);
  });
});
