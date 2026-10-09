import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import Fastify from "fastify";
import { checkMcpRequest, callRoute } from "../src";
import { startMcpHarness, textOf, type McpHarness } from "./helpers/mcp-harness";

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
  let h: McpHarness;

  beforeEach(async () => {
    h = await startMcpHarness();
  });

  afterEach(async () => {
    await h.stop();
  });

  test("rejects a non-loopback remote address with 403 before the transport runs", async () => {
    const res = await h.app.inject({
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
    const badHost = await fetch(`${h.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "evil.com" },
      body: JSON.stringify(body),
    });
    expect(badHost.status).toBe(403);
    const badOrigin = await fetch(`${h.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.com" },
      body: JSON.stringify(body),
    });
    expect(badOrigin.status).toBe(403);
  });

  test("GET and DELETE return 405 with a JSON-RPC error", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const res = await h.app.inject({ method, url: "/mcp" });
      expect(res.statusCode).toBe(405);
      expect(res.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
    }
  });

  test("listTools returns described tools with annotations over a real connection", async () => {
    const client = await h.connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(3);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(20);
      expect(tool.annotations).toBeDefined();
    }
  });

  test("with no workspace open, workspace_list works and other tools return a tool error", async () => {
    const client = await h.connect();
    const ws = await client.callTool({ name: "workspace_list", arguments: {} });
    expect(ws.isError).toBeFalsy();
    expect(JSON.parse(textOf(ws))).toEqual({ current: null, recent: [] });

    const profiles = await client.callTool({ name: "profile_list", arguments: {} });
    expect(profiles.isError).toBe(true);
    expect(textOf(profiles)).toContain("no workspace open");
  });

  test("profile_list and command_list return the open workspace's data", async () => {
    await h.manager.open(h.dir);
    const client = await h.connect();

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

describe("callRoute", () => {
  async function stubApp() {
    const app = Fastify({ logger: false });
    app.get("/ok", async () => ({ hello: "world" }));
    app.get("/empty", async (_req, reply) => reply.status(204).send());
    app.get("/text", async (_req, reply) => reply.type("text/plain").send("plain words"));
    app.get("/boom", async (_req, reply) => reply.status(500).type("text/plain").send("kaput"));
    app.get("/api-error", async (_req, reply) => reply.status(400).send({ error: "bad input" }));
    app.get("/other-error", async (_req, reply) => reply.status(418).send({ message: "teapot" }));
    app.get("/query", async (req) => req.query);
    app.get<{ Params: { id: string } }>("/item/:id", async (req) => ({ id: req.params.id }));
    app.post("/echo", async (req) => ({ body: req.body }));
    await app.ready();
    return app;
  }

  test("returns pretty JSON for a 2xx body", async () => {
    const app = await stubApp();
    const res = await callRoute(app, { method: "GET", url: "/ok" });
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).toBe(
      JSON.stringify({ hello: "world" }, null, 2),
    );
    await app.close();
  });

  test('maps 204 to {"ok":true}', async () => {
    const app = await stubApp();
    const res = await callRoute(app, { method: "GET", url: "/empty" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ ok: true });
    await app.close();
  });

  test("passes a non-JSON 2xx body through raw", async () => {
    const app = await stubApp();
    const res = await callRoute(app, { method: "GET", url: "/text" });
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).toBe("plain words");
    await app.close();
  });

  test("uses the API's error message for a JSON error body", async () => {
    const app = await stubApp();
    const res = await callRoute(app, { method: "GET", url: "/api-error" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe("bad input");
    await app.close();
  });

  test("passes a non-JSON error body through raw", async () => {
    const app = await stubApp();
    const res = await callRoute(app, { method: "GET", url: "/boom" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe("kaput");
    await app.close();
  });

  test("uses the raw body when a JSON error has no error key", async () => {
    const app = await stubApp();
    const res = await callRoute(app, { method: "GET", url: "/other-error" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe(JSON.stringify({ message: "teapot" }));
    await app.close();
  });

  test("skips undefined query values and stringifies the rest", async () => {
    const app = await stubApp();
    const res = await callRoute(app, {
      method: "GET",
      url: "/query",
      query: { a: 1, skipped: undefined, flag: true, s: "x y" },
    });
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({
      a: "1",
      flag: "true",
      s: "x y",
    });
    await app.close();
  });

  test("appends with ? or & depending on the url, and adds nothing for an empty query", async () => {
    const app = await stubApp();
    const fresh = await callRoute(app, { method: "GET", url: "/query", query: { a: "1" } });
    expect(JSON.parse((fresh.content[0] as { text: string }).text)).toEqual({ a: "1" });
    const existing = await callRoute(app, { method: "GET", url: "/query?x=0", query: { a: "1" } });
    expect(JSON.parse((existing.content[0] as { text: string }).text)).toEqual({ x: "0", a: "1" });
    const none = await callRoute(app, { method: "GET", url: "/query", query: { a: undefined } });
    expect(JSON.parse((none.content[0] as { text: string }).text)).toEqual({});
    await app.close();
  });

  test("an already-encoded path parameter reaches the handler decoded", async () => {
    const app = await stubApp();
    const res = await callRoute(app, {
      method: "GET",
      url: `/item/${encodeURIComponent("a/b c?d")}`,
    });
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ id: "a/b c?d" });
    await app.close();
  });

  test("sends the payload as the JSON body", async () => {
    const app = await stubApp();
    const res = await callRoute(app, { method: "POST", url: "/echo", payload: { n: 1 } });
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ body: { n: 1 } });
    await app.close();
  });
});
