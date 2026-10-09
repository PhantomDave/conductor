import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  buildApi,
  checkMcpRequest,
  LogBroadcaster,
  saveConfig,
  validateConfig,
  WorkspaceManager,
  type ApiDependencies,
} from "../src";

describe("checkMcpRequest", () => {
  const ok = { remoteAddress: "127.0.0.1", host: "localhost:4000", origin: undefined };

  test("accepts loopback IPv4, IPv6 and v4-mapped remote addresses", () => {
    for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(checkMcpRequest({ ...ok, remoteAddress })).toBeNull();
    }
  });

  test("rejects a non-loopback or missing remote address", () => {
    expect(checkMcpRequest({ ...ok, remoteAddress: "10.0.0.5" })).not.toBeNull();
    expect(checkMcpRequest({ ...ok, remoteAddress: undefined })).not.toBeNull();
  });

  test("checks the Host header hostname", () => {
    expect(checkMcpRequest({ ...ok, host: "evil.com" })).not.toBeNull();
    expect(checkMcpRequest({ ...ok, host: "evil.com:4000" })).not.toBeNull();
    expect(checkMcpRequest({ ...ok, host: "localhost@evil.com" })).not.toBeNull();
    expect(checkMcpRequest({ ...ok, host: undefined })).not.toBeNull();
    for (const host of ["localhost:4000", "localhost", "127.0.0.1:4000", "[::1]:4000", "[::1]"]) {
      expect(checkMcpRequest({ ...ok, host })).toBeNull();
    }
  });

  test("checks the Origin header only when present", () => {
    expect(checkMcpRequest({ ...ok, origin: "http://evil.com" })).not.toBeNull();
    expect(checkMcpRequest({ ...ok, origin: "null" })).not.toBeNull();
    expect(checkMcpRequest({ ...ok, origin: "file://localhost" })).not.toBeNull();
    expect(checkMcpRequest({ ...ok, origin: "http://localhost:3000" })).toBeNull();
    expect(checkMcpRequest({ ...ok, origin: "http://[::1]:3000" })).toBeNull();
    expect(checkMcpRequest(ok)).toBeNull();
  });
});

describe("/mcp endpoint", () => {
  let root: string;
  let manager: WorkspaceManager;
  let app: FastifyInstance;
  let baseUrl: string;
  let clients: Client[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "conductor-mcp-"));
    const dir = join(root, "ws");
    mkdirSync(dir, { recursive: true });
    saveConfig(
      join(dir, ".conductor.yml"),
      validateConfig({
        version: "1",
        name: "MCP Workspace",
        commands: [{ id: "web", name: "Web", run: "echo hi", shell: false }],
        profiles: { dev: { command_ids: ["web"] } },
      }),
    );
    const broadcaster = new LogBroadcaster();
    const deps = { broadcaster } as ApiDependencies;
    manager = new WorkspaceManager({
      dataDir: join(root, "data"),
      deps,
      session: { broadcaster, logLevel: "silent" },
    });
    deps.workspaces = manager;
    app = await buildApi(deps);
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await manager.close().catch(() => {});
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function connect(): Promise<Client> {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    clients.push(client);
    return client;
  }

  function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
    const content = result.content as Array<{ type: string; text?: string }>;
    return content[0]?.text ?? "";
  }

  test("rejects a non-loopback remote address with 403 before the transport runs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      remoteAddress: "10.0.0.5",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
  });

  test("rejects a foreign Host or Origin with 403", async () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const badHost = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "evil.com" },
      body: JSON.stringify(body),
    });
    expect(badHost.status).toBe(403);
    const badOrigin = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.com" },
      body: JSON.stringify(body),
    });
    expect(badOrigin.status).toBe(403);
  });

  test("GET and DELETE return 405 with a JSON-RPC error", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/mcp" });
      expect(res.statusCode).toBe(405);
      expect(res.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
    }
  });

  test("listTools returns the tools with annotations over a real connection", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["command_list", "profile_list", "workspace_list"]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description?.length).toBeGreaterThan(20);
    }
  });

  test("with no workspace open, workspace_list works and other tools return a tool error", async () => {
    const client = await connect();
    const ws = await client.callTool({ name: "workspace_list", arguments: {} });
    expect(ws.isError).toBeFalsy();
    expect(JSON.parse(textOf(ws))).toBeDefined();

    const profiles = await client.callTool({ name: "profile_list", arguments: {} });
    expect(profiles.isError).toBe(true);
    expect(textOf(profiles)).toContain("no workspace open");
  });

  test("profile_list and command_list return the open workspace's data", async () => {
    await manager.open(join(root, "ws"));
    const client = await connect();

    const profiles = JSON.parse(
      textOf(await client.callTool({ name: "profile_list", arguments: {} })),
    );
    expect(profiles.profiles.dev.command_ids).toEqual(["web"]);

    const commands = JSON.parse(
      textOf(await client.callTool({ name: "command_list", arguments: {} })),
    );
    expect(commands.commands.map((c: { id: string }) => c.id)).toEqual(["web"]);
  });
});
