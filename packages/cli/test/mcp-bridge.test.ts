// Black-box tests for `conductor mcp`: spawn the real binary against a real
// core instance and speak MCP to it over stdio.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveBaseUrl } from "../src/commands/mcp";
import { startCore } from "../../core/test/fixtures/api-harness";

const BIN = join(import.meta.dir, "..", "bin", "conductor.ts");
let core: Awaited<ReturnType<typeof startCore>>;
let tmp: string;

/** Env for a spawned bridge that can never read or write the real ~/.conductor. */
function bridgeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "CONDUCTOR_API_URL") env[k] = v;
  }
  return { ...env, NO_COLOR: "1", CONDUCTOR_ENDPOINT_FILE: join(tmp, "none.json"), ...extra };
}

async function spawnBridge(args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, BIN, "mcp", ...args], {
    env: bridgeEnv(extra),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function connect(args: string[], extra: Record<string, string> = {}) {
  const client = new Client({ name: "bridge-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "mcp", ...args],
      env: bridgeEnv(extra),
      stderr: "pipe",
    }),
  );
  return client;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "conductor-bridge-"));
  core = await startCore();
});

afterAll(async () => {
  await core.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("conductor mcp", () => {
  test("relays tools/list and tools/call through --url", async () => {
    const client = await connect(["--url", core.url]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("profile_list");
      const result = await client.callTool({ name: "profile_list", arguments: {} });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text?: string }>;
      const profiles = JSON.parse(content[0]?.text ?? "");
      expect(Array.isArray(profiles.commands)).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("falls back to CONDUCTOR_API_URL", async () => {
    const client = await connect([], { CONDUCTOR_API_URL: core.url });
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  test("discovers core through the endpoint file", async () => {
    const file = join(tmp, "endpoint.json");
    writeFileSync(file, JSON.stringify({ url: core.url, pid: process.pid, startedAt: "x" }));
    const client = await connect([], { CONDUCTOR_ENDPOINT_FILE: file });
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  test("unreachable core exits 1 with empty stdout and a stderr hint", async () => {
    const r = await spawnBridge(["--url", "http://127.0.0.1:1"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("not reachable");
  });

  test("exits 0 when stdin closes", async () => {
    const proc = Bun.spawn([process.execPath, BIN, "mcp", "--url", core.url], {
      env: bridgeEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
  });

  test("writes only JSON-RPC lines to stdout", async () => {
    const proc = Bun.spawn([process.execPath, BIN, "mcp", "--url", core.url], {
      env: bridgeEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (msg: unknown) => {
      void proc.stdin.write(`${JSON.stringify(msg)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await proc.stdin.flush();
    void proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    for (const line of lines) expect(JSON.parse(line).jsonrpc).toBe("2.0");
  });
});

describe("resolveBaseUrl", () => {
  const KEYS = ["CONDUCTOR_ENDPOINT_FILE", "CONDUCTOR_API_URL"] as const;
  let saved: Record<string, string | undefined>;
  let file: string;

  const writeEndpoint = (pid: number) =>
    writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:5555", pid, startedAt: "x" }));

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    file = join(tmp, "resolve.json");
    process.env.CONDUCTOR_ENDPOINT_FILE = file;
    delete process.env.CONDUCTOR_API_URL;
    rmSync(file, { force: true });
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("a dead-pid endpoint file is ignored", async () => {
    const dead = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await dead.exited;
    writeEndpoint(dead.pid);
    expect(resolveBaseUrl()).toBe("http://localhost:4000");
  });

  test("a live-pid endpoint file is used", () => {
    writeEndpoint(process.pid);
    expect(resolveBaseUrl()).toBe("http://127.0.0.1:5555");
  });

  test("CONDUCTOR_API_URL wins over a live endpoint file", () => {
    writeEndpoint(process.pid);
    process.env.CONDUCTOR_API_URL = "http://127.0.0.1:6666/";
    expect(resolveBaseUrl()).toBe("http://127.0.0.1:6666");
  });

  test("an explicit --url wins over everything", () => {
    writeEndpoint(process.pid);
    process.env.CONDUCTOR_API_URL = "http://127.0.0.1:6666";
    expect(resolveBaseUrl("http://127.0.0.1:7777")).toBe("http://127.0.0.1:7777");
  });

  test("empty or whitespace-only values count as unset", () => {
    writeEndpoint(process.pid);
    process.env.CONDUCTOR_API_URL = "  ";
    expect(resolveBaseUrl("")).toBe("http://127.0.0.1:5555");
    expect(resolveBaseUrl("   ")).toBe("http://127.0.0.1:5555");
    rmSync(file);
    process.env.CONDUCTOR_API_URL = "";
    expect(resolveBaseUrl("")).toBe("http://localhost:4000");
  });
});
