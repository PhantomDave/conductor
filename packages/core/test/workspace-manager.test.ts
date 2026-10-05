import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  buildApi,
  ConductorQueries,
  DEFAULT_DB_PATH,
  LogBroadcaster,
  openDatabase,
  recordRecent,
  saveConfig,
  validateConfig,
  WorkspaceManager,
  type ApiDependencies,
  type CommandConfig,
} from "../src";

// Portable long-runner (see queue.test.ts): `bun -e`, shell: false, short
// stop timeout so Windows' SIGKILL fallback still fits bun:test's 5s budget.
const LONG_RUNNER = 'bun -e "setInterval(() => {}, 1000)"';

let root: string;
let dirA: string;
let dirB: string;
let manager: WorkspaceManager;
let deps: ApiDependencies;
let app: FastifyInstance;

function writeWorkspace(dir: string, name: string, commands: Partial<CommandConfig>[]) {
  mkdirSync(dir, { recursive: true });
  saveConfig(
    join(dir, ".conductor.yml"),
    validateConfig({
      version: "1",
      name,
      commands: commands.map((c) => ({ shell: false, stop_timeout_ms: 500, ...c })),
      profiles: { dev: { command_ids: commands.map((c) => c.id) } },
    }),
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startA(): Promise<number> {
  await manager.open(dirA);
  await manager.current!.store.getQueue().startOne("a-runner");
  return manager.current!.store.getQueue().listSnapshots()[0]!.pid;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "conductor-manager-"));
  dirA = join(root, "a");
  dirB = join(root, "b");
  writeWorkspace(dirA, "Workspace A", [{ id: "a-runner", name: "A", run: LONG_RUNNER }]);
  writeWorkspace(dirB, "Workspace B", [{ id: "b-runner", name: "B", run: LONG_RUNNER }]);

  const broadcaster = new LogBroadcaster();
  // ponytail: deps fields are unset until a workspace opens; the onRequest guard keeps handlers from running before that
  deps = { broadcaster } as ApiDependencies;
  manager = new WorkspaceManager({
    dataDir: join(root, "data"),
    deps,
    session: { broadcaster, logLevel: "silent" },
  });
  deps.workspaces = manager;
  app = await buildApi(deps);
});

afterEach(async () => {
  await manager.close().catch(() => {});
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceManager + API", () => {
  test("with no workspace open, /api/* is 409 but /api/health is 200", async () => {
    const profiles = await app.inject({ method: "GET", url: "/api/profiles" });
    expect(profiles.statusCode).toBe(409);
    expect(profiles.json()).toEqual({ error: "no workspace open" });
    expect((await app.inject({ method: "GET", url: "/%61pi/profiles" })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/nope" })).statusCode).toBe(404);

    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/workspaces" })).json()).toEqual({
      current: null,
      recent: [],
    });
  });

  test("open A then open B stops A's process and serves B's config", async () => {
    const pid = await startA();
    expect(isAlive(pid)).toBe(true);

    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces/open",
      payload: { path: dirB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: dirB, name: "Workspace B" });

    expect(isAlive(pid)).toBe(false);
    const profiles = await app.inject({ method: "GET", url: "/api/profiles" });
    expect(profiles.json().commands.map((c: CommandConfig) => c.id)).toEqual(["b-runner"]);

    const list = manager.list();
    expect(list.current).toEqual({ path: dirB, name: "Workspace B" });
    expect(list.recent.map((r) => r.path)).toEqual([dirB, dirA]);
  });

  test("open B with invalid YAML → 400, A stays current and keeps running", async () => {
    const pid = await startA();
    const sessionA = manager.current;
    writeFileSync(join(dirB, ".conductor.yml"), "commands: [\n  - id: unterminated");

    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces/open",
      payload: { path: dirB },
    });
    expect(res.statusCode).toBe(400);
    expect(manager.current).toBe(sessionA);
    expect(isAlive(pid)).toBe(true);
  });

  test("a switch still succeeds when the recent list can't be written", async () => {
    writeFileSync(join(root, "data"), "not a directory");
    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces/open",
      payload: { path: dirB },
    });
    expect(res.statusCode).toBe(200);
    expect(manager.current!.dir).toBe(dirB);
  });

  test("open(current) is a no-op", async () => {
    const pid = await startA();
    const sessionA = manager.current;

    expect(await manager.open(`${dirA}/`)).toBe(sessionA!);
    expect(manager.current).toBe(sessionA);
    expect(isAlive(pid)).toBe(true);
  });

  // `trap` needs a POSIX shell.
  test.skipIf(process.platform === "win32")(
    "requests during a slow switch get 409 workspace switch in progress",
    async () => {
      writeWorkspace(dirA, "Workspace A", [
        {
          id: "stubborn",
          name: "Stubborn",
          run: "trap '' TERM; echo ready; sleep 30",
          shell: true,
          stop_timeout_ms: 1500,
        },
      ]);
      await manager.open(dirA);
      const ready = new Promise<void>((resolve) => {
        const unsubscribe = deps.broadcaster.subscribe((row) => {
          if (row.message.includes("ready")) {
            unsubscribe();
            resolve();
          }
        });
      });
      await manager.current!.store.getQueue().startOne("stubborn", deps.onLog);
      await ready;

      const switching = manager.open(dirB);
      try {
        expect(manager.switching).toBe(true);
        const open = await app.inject({
          method: "POST",
          url: "/api/workspaces/open",
          payload: { path: dirB },
        });
        expect(open.statusCode).toBe(409);
        expect(open.json()).toEqual({ error: "workspace switch in progress" });

        const run = await app.inject({ method: "POST", url: "/api/profiles/dev/run" });
        expect(run.statusCode).toBe(409);
        expect(run.json()).toEqual({ error: "workspace switch in progress" });
        // Shutdown waits the switch out instead of exiting mid-stop.
        await manager.idle();
        expect(manager.switching).toBe(false);
      } finally {
        await switching;
      }
      expect(manager.current!.dir).toBe(dirB);
    },
  );

  // The dependency exits 0 on SIGTERM like a graceful server, which reads as
  // "ready" to its waiting dependent once the switch has stopped it.
  test.skipIf(process.platform === "win32")(
    "a run waiting on a dependency during a switch never spawns into the closed workspace",
    async () => {
      writeWorkspace(dirA, "Workspace A", [
        {
          id: "db",
          name: "DB",
          run: `bun -e "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"`,
          healthcheck: {
            type: "log_line",
            pattern: "never printed",
            interval_ms: 100,
            timeout_ms: 1000,
            retries: 100,
          },
        },
        { id: "app", name: "App", run: LONG_RUNNER, deps: ["db"] },
      ]);
      await manager.open(dirA);
      const queueA = manager.current!.store.getQueue();
      const run = app.inject({ method: "POST", url: "/api/profiles/dev/run" });
      let appPid: number | undefined;
      try {
        while (!queueA.listSnapshots().some((s) => s.commandId === "db" && s.pid > 0)) {
          await Bun.sleep(20);
        }
        await manager.open(dirB);
        await run;
        await Bun.sleep(300); // past waitForDependency's 100ms poll
        appPid = queueA.listSnapshots().find((s) => s.commandId === "app")?.pid;
        expect(appPid === undefined || !isAlive(appPid)).toBe(true);
      } finally {
        if (appPid !== undefined && isAlive(appPid)) process.kill(appPid, "SIGKILL");
      }
    },
  );

  test("a deleted folder in recent is missing, fails to open, and can be removed", async () => {
    const gone = join(root, "gone");
    recordRecent(join(root, "data"), { path: gone, name: "Gone" });

    expect(manager.list().recent).toEqual([
      expect.objectContaining({ path: gone, name: "Gone", missing: true }),
    ]);

    const open = await app.inject({
      method: "POST",
      url: "/api/workspaces/open",
      payload: { path: gone },
    });
    expect(open.statusCode).toBe(400);
    expect(open.json().error).toMatch(/Folder not found/);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/workspaces?path=${encodeURIComponent(gone)}`,
    });
    expect(del.statusCode).toBe(200);
    expect(manager.list().recent).toEqual([]);
  });

  test("a malformed recent entry is dropped, not thrown", () => {
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "workspaces.json"), JSON.stringify([{ foo: 1 }]));

    expect(manager.list().recent).toEqual([]);
  });

  test("after switching to B, a log line lands in B's DB, not A's", async () => {
    await manager.open(dirA);
    await manager.open(dirB);

    deps.onLog({
      commandId: "b-runner",
      commandName: "B",
      profile: "dev",
      pid: 1,
      stream: "stdout",
      message: "hello-from-b",
      timestamp: new Date().toISOString(),
    });
    expect(manager.current!.queries.queryLogs({ grep: "hello-from-b" })).toHaveLength(1);

    await manager.close();
    const dbA = openDatabase(join(dirA, DEFAULT_DB_PATH));
    try {
      expect(new ConductorQueries(dbA).queryLogs({ grep: "hello-from-b" })).toHaveLength(0);
    } finally {
      dbA.close();
    }
  });

  test("close() clears current and the guard returns 409 again", async () => {
    await manager.open(dirA);
    expect((await app.inject({ method: "GET", url: "/api/profiles" })).statusCode).toBe(200);

    const res = await app.inject({ method: "POST", url: "/api/workspaces/close" });
    expect(res.statusCode).toBe(200);
    expect(manager.current).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/profiles" })).json()).toEqual({
      error: "no workspace open",
    });
  });

  test("a failing close during a switch never leaves the manager locked", async () => {
    const sessionA = await manager.open(dirA);
    const realClose = sessionA.close.bind(sessionA);
    sessionA.close = async () => {
      await realClose();
      throw new Error("boom");
    };

    expect(await manager.open(dirB).catch((err: Error) => err.message)).toBe("boom");
    expect(manager.switching).toBe(false);
    expect(manager.current).toBeNull();

    await manager.open(dirB);
    expect(manager.current!.dir).toBe(dirB);
  });
});
