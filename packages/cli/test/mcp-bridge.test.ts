// Black-box tests for `conductor mcp`: spawn the real binary against a real
// core instance and speak MCP to it over stdio.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

  test("ignores an endpoint file whose pid is dead", async () => {
    const dead = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await dead.exited;
    const file = join(tmp, "stale.json");
    writeFileSync(file, JSON.stringify({ url: core.url, pid: dead.pid, startedAt: "x" }));
    // Falls through to http://localhost:4000, which is not served here.
    const r = await spawnBridge(["--url", "http://127.0.0.1:1"], { CONDUCTOR_ENDPOINT_FILE: file });
    expect(r.code).toBe(1);
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
