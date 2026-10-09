// Black-box tests for `conductor mcp`: spawn the real binary against a real
// core instance and speak MCP to it over stdio.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findReachableBase, isReachable, resolveBaseUrl } from "../src/commands/mcp";
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
    expect(resolveBaseUrl()).toEqual({ url: "http://localhost:4000", source: "default" });
  });

  test("a live-pid endpoint file is used", () => {
    writeEndpoint(process.pid);
    expect(resolveBaseUrl()).toEqual({ url: "http://127.0.0.1:5555", source: "endpoint-file" });
  });

  test("CONDUCTOR_API_URL wins over a live endpoint file", () => {
    writeEndpoint(process.pid);
    process.env.CONDUCTOR_API_URL = "http://127.0.0.1:6666/";
    expect(resolveBaseUrl()).toEqual({ url: "http://127.0.0.1:6666", source: "env" });
  });

  test("an explicit --url wins over everything", () => {
    writeEndpoint(process.pid);
    process.env.CONDUCTOR_API_URL = "http://127.0.0.1:6666";
    expect(resolveBaseUrl("http://127.0.0.1:7777")).toEqual({
      url: "http://127.0.0.1:7777",
      source: "flag",
    });
  });

  test("empty or whitespace-only values count as unset", () => {
    writeEndpoint(process.pid);
    process.env.CONDUCTOR_API_URL = "  ";
    const fromFile = { url: "http://127.0.0.1:5555", source: "endpoint-file" };
    expect(resolveBaseUrl("")).toEqual(fromFile);
    expect(resolveBaseUrl("   ")).toEqual(fromFile);
    rmSync(file);
    process.env.CONDUCTOR_API_URL = "";
    expect(resolveBaseUrl("")).toEqual({ url: "http://localhost:4000", source: "default" });
  });
});

describe("findReachableBase", () => {
  /** A URL nothing listens on: bind a port, note it, release it. */
  function closedUrl(): string {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const url = `http://127.0.0.1:${server.port}`;
    void server.stop(true);
    return url;
  }

  test("a reachable URL is used without trying the default", async () => {
    const probed: string[] = [];
    const probe = async (u: string) => (probed.push(u), true);
    const r = await findReachableBase(
      { url: "http://a", source: "endpoint-file" },
      probe,
      "http://d",
    );
    expect(r).toEqual({ url: "http://a", tried: ["http://a"], fellBack: false });
    expect(probed).toEqual(["http://a"]);
  });

  test("an unreachable endpoint-file URL falls back to the default", async () => {
    const probe = async (u: string) => u === "http://d";
    const r = await findReachableBase(
      { url: "http://a", source: "endpoint-file" },
      probe,
      "http://d",
    );
    expect(r).toEqual({ url: "http://d", tried: ["http://a", "http://d"], fellBack: true });
  });

  test("both failing reports everything tried", async () => {
    const r = await findReachableBase(
      { url: "http://a", source: "endpoint-file" },
      async () => false,
      "http://d",
    );
    expect(r).toEqual({ url: null, tried: ["http://a", "http://d"], fellBack: false });
  });

  test.each(["flag", "env", "default"] as const)("%s never falls back", async (source) => {
    const probed: string[] = [];
    const probe = async (u: string) => (probed.push(u), false);
    const r = await findReachableBase({ url: "http://a", source }, probe, "http://d");
    expect(r.url).toBeNull();
    expect(probed).toEqual(["http://a"]);
  });

  test("stale endpoint file (live pid, closed port) falls back to a running core", async () => {
    const file = join(tmp, "stale.json");
    writeFileSync(file, JSON.stringify({ url: closedUrl(), pid: process.pid, startedAt: "x" }));
    const saved = {
      file: process.env.CONDUCTOR_ENDPOINT_FILE,
      api: process.env.CONDUCTOR_API_URL,
    };
    process.env.CONDUCTOR_ENDPOINT_FILE = file;
    delete process.env.CONDUCTOR_API_URL;
    try {
      const resolved = resolveBaseUrl();
      expect(resolved.source).toBe("endpoint-file");
      // The real default (:4000) cannot be bound in tests, so the running core stands in for it.
      const r = await findReachableBase(resolved, isReachable, core.url);
      expect(r.url).toBe(core.url);
      expect(r.fellBack).toBe(true);
    } finally {
      if (saved.file === undefined) delete process.env.CONDUCTOR_ENDPOINT_FILE;
      else process.env.CONDUCTOR_ENDPOINT_FILE = saved.file;
      if (saved.api !== undefined) process.env.CONDUCTOR_API_URL = saved.api;
    }
  });

  test("the bridge names both URLs when the endpoint file and the default are unreachable", async () => {
    const file = join(tmp, "stale2.json");
    const stale = closedUrl();
    writeFileSync(file, JSON.stringify({ url: stale, pid: process.pid, startedAt: "x" }));
    const r = await spawnBridge([], { CONDUCTOR_ENDPOINT_FILE: file });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("not reachable");
    expect(r.stderr).toContain(stale);
    expect(r.stderr).toContain("http://localhost:4000");
  });
});

describe("loopback-only hint", () => {
  test("a 403 from /mcp writes one stderr hint, not one per request", async () => {
    const stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname === "/api/health"
          ? new Response("ok")
          : new Response("forbidden", { status: 403 }),
    });
    const base = `http://127.0.0.1:${stub.port}`;
    try {
      const proc = Bun.spawn([process.execPath, BIN, "mcp", "--url", base], {
        env: bridgeEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      for (const id of [1, 2, 3]) {
        void proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })}\n`);
      }
      await proc.stdin.flush();
      void proc.stdin.end();
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      const hint = `conductor mcp: /mcp only accepts loopback hosts (localhost, 127.0.0.1, [::1]); got ${base}`;
      expect(stderr.split(hint).length - 1).toBe(1);
      // Every request still gets an answer, so the client is not left waiting.
      expect(stdout.split("\n").filter(Boolean).length).toBe(3);
    } finally {
      void stub.stop(true);
    }
  });
});
