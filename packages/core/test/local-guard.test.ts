import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { startMcpHarness, type McpHarness } from "./helpers/mcp-harness";

// The loopback guard used to cover only /mcp, leaving the same command-running
// surface open on /api to cross-site pages and DNS rebinding.
describe("loopback guard on /api", () => {
  let h: McpHarness;

  beforeEach(async () => {
    h = await startMcpHarness();
  });

  afterEach(async () => {
    await h.stop();
  });

  test("a cross-site bodyless POST is refused before the handler runs", async () => {
    const res = await fetch(`${h.baseUrl}/api/workspaces/close`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  test("a DNS-rebound Host is refused", async () => {
    const res = await fetch(`${h.baseUrl}/api/workspaces`, { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
  });

  test("a non-loopback peer is refused", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/health",
      remoteAddress: "10.0.0.5",
    });
    expect(res.statusCode).toBe(403);
  });

  test("same-machine requests, with or without a loopback Origin, pass", async () => {
    expect((await fetch(`${h.baseUrl}/api/health`)).status).toBe(200);
    const fromDevUi = await fetch(`${h.baseUrl}/api/health`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(fromDevUi.status).toBe(200);
  });
});
