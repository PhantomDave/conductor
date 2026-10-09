import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { TOOLS } from "../src";
import { callJson, startMcpHarness, textOf, type McpHarness } from "./helpers/mcp-harness";

const EXPECTED_TOOLS = [
  "workspace_list",
  "workspace_open",
  "workspace_close",
  "workspace_forget",
  "profile_list",
  "profile_create",
  "profile_update",
  "profile_delete",
  "profile_duplicate",
  "profile_export",
  "command_list",
  "command_create",
  "command_update",
  "command_delete",
  "profile_command_add",
  "profile_command_update",
  "profile_command_sync",
  "profile_command_remove",
  "profile_command_duplicate",
  "profile_command_move",
  "profile_run",
  "profile_stop",
  "command_execute",
  "command_restart",
  "process_list",
  "process_stop",
  "process_metrics",
  "process_wait",
  "notification_list",
  "notification_clear",
  "env_list",
  "env_set",
  "env_delete",
  "env_import",
  "log_query",
  "log_runs",
  "log_prune",
  "config_export",
  "config_import",
  "configure",
  "base_path_get",
  "base_path_set",
  "shell_get",
  "shell_set",
  "log_retention_get",
  "log_retention_set",
  "docker_compose_parse",
].sort();

describe("MCP tool surface", () => {
  let h: McpHarness;
  let client: Client;
  /** Fire-and-forget calls (e.g. a blocking command_execute) to settle after teardown. */
  let pending: Promise<unknown>[];

  beforeEach(async () => {
    h = await startMcpHarness();
    pending = [];
    await h.manager.open(h.dir);
    client = await h.connect();
  });

  afterEach(async () => {
    // Closing the workspace stops every process, which also unblocks pending calls.
    await h.stop();
    await Promise.allSettled(pending);
  });

  test("listTools returns exactly the specified tools, with annotations and input schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    expect(TOOLS.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.env_list!.annotations?.readOnlyHint).toBe(true);
    expect(byName.command_delete!.annotations?.destructiveHint).toBe(true);
    expect(byName.command_create!.annotations?.readOnlyHint).toBe(false);
    expect(byName.command_create!.annotations?.destructiveHint).toBe(false);
    expect(byName.process_wait!.annotations?.readOnlyHint).toBe(true);

    // Every tool is annotated one way, and reads never claim to be destructive.
    for (const tool of tools) {
      const a = tool.annotations;
      expect(a?.readOnlyHint !== undefined || a?.destructiveHint !== undefined).toBe(true);
      if (a?.readOnlyHint) expect(a.destructiveHint).toBeUndefined();
      expect(tool.description!.length).toBeGreaterThan(20);
    }
    // The reused command schema converts to JSON Schema with its required fields.
    expect(byName.command_create!.inputSchema.required).toEqual(
      expect.arrayContaining(["name", "run"]),
    );
  });

  test("command_create then command_list contains it, and an audit entry is written", async () => {
    const created = await callJson(client, "command_create", {
      id: "api",
      name: "API",
      run: "echo api",
    });
    expect(created.command.id).toBe("api");

    const listed = await callJson(client, "command_list");
    expect(listed.commands.map((c: { id: string }) => c.id)).toContain("api");

    const db = (h.manager.current!.queries as unknown as { db: Database }).db;
    const rows = db
      .query("SELECT details FROM audit_log WHERE action = 'add-command-standalone'")
      .all() as Array<{ details: string }>;
    expect(rows.map((r) => r.details)).toContain("api");
  });

  test("a route-rejected input becomes an isError result with the route's message", async () => {
    // A client-side-valid string the route's schema still rejects (the SDK enforces `min(1)` first).
    const res = await client.callTool({
      name: "command_create",
      arguments: { name: "Bad", run: "" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res).length).toBeGreaterThan(0);

    const missing = await client.callTool({
      name: "command_update",
      arguments: { id: "does-not-exist", name: "x" },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("does-not-exist");
  });

  test("env_set with secret: true is filtered in env_list", async () => {
    const set = await callJson(client, "env_set", {
      scope: "global",
      key: "API_TOKEN",
      value: "hunter2",
      secret: true,
    });
    expect(set.var.is_secret).toBe(1);
    expect(set.var.value).toBe("[FILTERED]");

    const listed = await callJson(client, "env_list");
    const row = listed.vars.find((v: { key: string }) => v.key === "API_TOKEN");
    expect(row.value).toBe("[FILTERED]");
    expect(JSON.stringify(listed)).not.toContain("hunter2");

    const plain = await callJson(client, "env_set", { scope: "global", key: "MODE", value: "dev" });
    expect(plain.var.value).toBe("dev");
    const scoped = await callJson(client, "env_list", { scope: "global" });
    expect(scoped.vars.map((v: { key: string }) => v.key)).toEqual(["API_TOKEN", "MODE"]);

    // env_import masks too, both for explicit and heuristic secrets.
    const imported = await callJson(client, "env_import", {
      scope: "global",
      text: "DB_PASSWORD=pw123\nPLAIN=ok\n",
    });
    expect(JSON.stringify(imported)).not.toContain("pw123");
    expect(imported.vars.map((v: { value: string }) => v.value)).toEqual(["[FILTERED]", "ok"]);
    expect(JSON.stringify(await callJson(client, "env_list"))).not.toContain("pw123");
  });

  test("workspace_open on a temp folder succeeds and profile_list works afterwards", async () => {
    const other = mkdtempSync(join(tmpdir(), "conductor-mcp-other-"));
    const opened = await callJson(client, "workspace_open", { path: other });
    expect(opened.path).toBe(other);

    const profiles = await callJson(client, "profile_list");
    expect(profiles.commands).toEqual([]);
    const ws = await callJson(client, "workspace_list");
    expect(ws.current.path).toBe(other);

    await callJson(client, "workspace_close");
    const closed = await client.callTool({ name: "profile_list", arguments: {} });
    expect(closed.isError).toBe(true);
    expect(textOf(closed)).toContain("no workspace open");
  });

  test("command_update with category null clears the category", async () => {
    await callJson(client, "command_create", {
      id: "svc",
      name: "Svc",
      run: "echo svc",
      category: "backend",
    });
    const updated = await callJson(client, "command_update", { id: "svc", category: null });
    expect(updated.command.category).toBeUndefined();
    const kept = await callJson(client, "command_update", { id: "svc", name: "Svc 2" });
    expect(kept.command.name).toBe("Svc 2");
  });

  test("profile and link tools map path parameters and bodies correctly", async () => {
    await callJson(client, "profile_create", { name: "qa", description: "QA" });
    // Path-param keys must not leak into a .strict() body.
    const renamed = await callJson(client, "profile_update", {
      profile: "qa",
      newName: "qa2",
      description: "QA 2",
    });
    expect(renamed.newName).toBe("qa2");

    await callJson(client, "profile_command_sync", { profile: "qa2", add: ["web"] });
    expect((await callJson(client, "profile_list")).profiles.qa2.command_ids).toEqual(["web"]);

    const dup = await callJson(client, "profile_command_duplicate", {
      profile: "qa2",
      id: "web",
      targetProfile: "dev",
    });
    expect(dup.command.id).not.toBe("web");

    await callJson(client, "profile_create", { name: "qa3" });
    await callJson(client, "profile_command_move", {
      profile: "qa2",
      id: "web",
      targetProfile: "qa3",
    });
    const moved = (await callJson(client, "profile_list")).profiles;
    expect(moved.qa2.command_ids).toEqual([]);
    expect(moved.qa3.command_ids).toEqual(["web"]);

    const exported = await callJson(client, "profile_export", { profile: "dev" });
    expect(exported.yaml).toContain("dev");

    // Deleting a command unlinks it from every profile.
    await callJson(client, "command_delete", { id: "web" });
    const after = await callJson(client, "profile_list");
    expect(after.profiles.dev.command_ids).not.toContain("web");
    expect(after.commands.map((c: { id: string }) => c.id)).not.toContain("web");

    await callJson(client, "profile_delete", { profile: "qa2" });
    expect(Object.keys((await callJson(client, "profile_list")).profiles)).not.toContain("qa2");
  });

  test("settings tools round-trip", async () => {
    await callJson(client, "log_retention_set", {
      log_retention_days: 3,
      log_retention_sessions: 2,
    });
    expect(await callJson(client, "log_retention_get")).toEqual({
      log_retention_days: 3,
      log_retention_sessions: 2,
    });

    await callJson(client, "base_path_set", { base_path: h.dir });
    expect((await callJson(client, "base_path_get")).base_path).toBe(h.dir);

    expect((await callJson(client, "shell_get")).available).toBeInstanceOf(Array);

    const exported = await callJson(client, "config_export");
    expect(exported.yaml).toContain("MCP Workspace");
    const parsed = await callJson(client, "docker_compose_parse", {
      yaml: "services:\n  db:\n    image: postgres\n",
    });
    expect(parsed.commands).toBeInstanceOf(Array);
  });

  test("log and notification reads return empty lists on a fresh workspace", async () => {
    expect((await callJson(client, "log_query", { limit: 10, pid: 1 })).logs).toEqual([]);
    expect((await callJson(client, "log_runs", { limit: 5 })).runs).toEqual([]);
    expect(
      (await callJson(client, "notification_list", { limit: 5, offset: 0 })).notifications,
    ).toEqual([]);
    expect(await callJson(client, "notification_clear")).toEqual({ cleared: true });
    expect((await callJson(client, "process_list")).processes).toEqual([]);
  });

  describe("process_wait", () => {
    const posix = process.platform !== "win32";

    async function defineCommand(command: Record<string, unknown>) {
      await callJson(client, "command_create", { shell: false, ...command });
    }

    test.skipIf(!posix)("waits for running, then for exit of a short command", async () => {
      await defineCommand({ id: "nap", name: "Nap", run: "sleep 2" });
      await callJson(client, "command_execute", { id: "nap" });

      const running = await callJson(client, "process_wait", {
        commandId: "nap",
        until: "running",
        timeout_ms: 5000,
      });
      expect(running.status).toBe("running");

      const exited = await callJson(client, "process_wait", {
        pid: running.pid,
        until: "exited",
        timeout_ms: 5000,
      });
      expect(exited.pid).toBe(running.pid);
      expect(exited.status).toBe("completed");
    });

    test.skipIf(!posix)("until stopped succeeds after process_stop", async () => {
      await defineCommand({ id: "long", name: "Long", run: "sleep 30" });
      await callJson(client, "command_execute", { id: "long" });
      const { pid } = await callJson(client, "process_wait", {
        commandId: "long",
        until: "running",
      });
      await callJson(client, "process_stop", { pid });
      const stopped = await callJson(client, "process_wait", {
        commandId: "long",
        until: "stopped",
        timeout_ms: 5000,
      });
      expect(stopped.status).toBe("stopped");
    });

    test.skipIf(!posix)(
      "times out with isError and the last snapshot when never healthy",
      async () => {
        await defineCommand({
          id: "sick",
          name: "Sick",
          run: "sleep 30",
          healthcheck: {
            type: "log_line",
            pattern: "never-printed",
            interval_ms: 100,
            retries: 200,
          },
        });
        // command_execute blocks until the healthcheck settles, so don't await it.
        pending.push(
          client.callTool({ name: "command_execute", arguments: { id: "sick" } }).catch(() => {}),
        );

        const res = await client.callTool({
          name: "process_wait",
          arguments: { commandId: "sick", until: "healthy", timeout_ms: 1000 },
        });
        expect(res.isError).toBe(true);
        expect(textOf(res)).toContain("timed out after 1000 ms");
        expect(textOf(res)).toContain('"commandId": "sick"');
      },
    );

    test("requires exactly one of commandId or pid", async () => {
      for (const args of [{ until: "running" }, { until: "running", commandId: "a", pid: 1 }]) {
        const res = await client.callTool({ name: "process_wait", arguments: args });
        expect(res.isError).toBe(true);
        expect(textOf(res)).toContain("exactly one of commandId or pid");
      }
    });

    test("an unknown command times out reporting no matching process", async () => {
      const res = await client.callTool({
        name: "process_wait",
        arguments: { commandId: "ghost", until: "running", timeout_ms: 600 },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("no matching process");
    });

    test("with no workspace open it returns the guard's error immediately", async () => {
      await callJson(client, "workspace_close");
      const res = await client.callTool({
        name: "process_wait",
        arguments: { commandId: "x", until: "running" },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("no workspace open");
    });
  });
});
