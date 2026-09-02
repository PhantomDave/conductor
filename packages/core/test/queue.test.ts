import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpawnQueue } from "../src/executor/queue";
import { CommandSchema, type CommandConfig } from "../src/config/schema";

// Same portability note as wrapper.test.ts: every command shells out to
// `bun -e "<script>"` so behavior is identical across the ubuntu/macos/windows
// CI matrix.

function makeCommand(
  overrides: Partial<CommandConfig> & { id: string; name: string; run: string },
): CommandConfig {
  return CommandSchema.parse(overrides);
}

function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

describe("SpawnQueue.startOne - dependency ordering", () => {
  test("starts a dependency before the command that depends on it", async () => {
    const dep = makeCommand({ id: "dep", name: "Dep", run: `bun -e "console.log('dep')"` });
    const child = makeCommand({
      id: "child",
      name: "Child",
      run: `bun -e "console.log('child')"`,
      deps: ["dep"],
    });
    const queue = new SpawnQueue("test", [dep, child], () => testEnv());

    await queue.startOne("child");

    const depSnapshot = queue.getWrapper("dep")?.getSnapshot();
    const childSnapshot = queue.getWrapper("child")?.getSnapshot();
    expect(depSnapshot).toBeDefined();
    expect(childSnapshot).toBeDefined();
    // startedAt is an ISO timestamp string; lexicographic order matches
    // chronological order for that format.
    expect(depSnapshot!.startedAt <= childSnapshot!.startedAt).toBe(true);

    await queue.stopAll();
  });

  test("throws a clear error for an unknown command id", async () => {
    const queue = new SpawnQueue("test", [], () => testEnv());
    await expect(queue.startOne("nope")).rejects.toThrow(/Unknown command "nope"/);
  });
});

describe("SpawnQueue.startAll - circular dependencies", () => {
  test("rejects with a clear error instead of hanging", async () => {
    const a = makeCommand({ id: "a", name: "A", run: `bun -e "1"`, deps: ["b"] });
    const b = makeCommand({ id: "b", name: "B", run: `bun -e "1"`, deps: ["a"] });
    const queue = new SpawnQueue("test", [a, b], () => testEnv());

    await expect(queue.startAll()).rejects.toThrow(/Circular dependency/);
  });
});

describe("SpawnQueue.startOne - dependency failure", () => {
  test("blocks the dependent command when a dependency's healthcheck never passes", async () => {
    const flaky = makeCommand({
      id: "flaky",
      name: "Flaky",
      run: `bun -e "setInterval(() => {}, 1000)"`,
      healthcheck: {
        type: "command",
        command: "exit 1",
        interval_ms: 20,
        timeout_ms: 200,
        retries: 3,
      },
    });
    const dependent = makeCommand({
      id: "dependent",
      name: "Dependent",
      run: `bun -e "console.log('should not run')"`,
      deps: ["flaky"],
    });
    const queue = new SpawnQueue("test", [flaky, dependent], () => testEnv());

    try {
      await expect(queue.startOne("dependent")).rejects.toThrow(/[Dd]ependency/);

      // The failed dependency itself is recorded, and nothing was blocked
      // downstream of "dependent" since nothing depends on it.
      const notifications = queue.listNotifications();
      expect(
        notifications.some((n) => n.type === "healthcheck_failed" && n.commandId === "flaky"),
      ).toBe(true);
    } finally {
      await queue.getWrapper("flaky")?.forceKillAndWait();
    }
  });
});

describe("SpawnQueue.restartOne", () => {
  test("gives the command a new pid", async () => {
    const cmd = makeCommand({
      id: "sleeper",
      name: "Sleeper",
      run: `bun -e "setInterval(() => {}, 1000)"`,
      stop_timeout_ms: 2000,
    });
    const queue = new SpawnQueue("test", [cmd], () => testEnv());

    await queue.startOne("sleeper");
    const firstPid = queue.getWrapper("sleeper")?.pid;
    expect(firstPid).toBeGreaterThan(0);

    await queue.restartOne("sleeper");
    const secondPid = queue.getWrapper("sleeper")?.pid;
    expect(secondPid).toBeGreaterThan(0);
    expect(secondPid).not.toBe(firstPid);

    await queue.stopAll();
  });
});

describe("SpawnQueue.stopAll", () => {
  test("actually terminates every running process", async () => {
    const a = makeCommand({ id: "a", name: "A", run: `bun -e "setInterval(() => {}, 1000)"` });
    const b = makeCommand({ id: "b", name: "B", run: `bun -e "setInterval(() => {}, 1000)"` });
    const queue = new SpawnQueue("test", [a, b], () => testEnv());

    await queue.startOne("a");
    await queue.startOne("b");
    expect(queue.listSnapshots().filter((s) => s.status === "running")).toHaveLength(2);

    await queue.stopAll();

    const snapshots = queue.listSnapshots();
    expect(snapshots.every((s) => s.status === "stopped")).toBe(true);
  });
});

describe("SpawnQueue.startAll - concurrency", () => {
  test("starts independent commands concurrently instead of one at a time", async () => {
    // Each command's healthcheck itself takes ~200ms to pass (a single
    // successful attempt, so `retries` never matters). Two independent
    // commands run serially would take ~400ms+; run concurrently, close to
    // one 200ms healthcheck.
    const slowHealthcheck = {
      type: "command" as const,
      command: `bun -e "Bun.sleepSync(200)"`,
      interval_ms: 50,
      timeout_ms: 5000,
      retries: 1,
    };
    const a = makeCommand({
      id: "a",
      name: "A",
      run: `bun -e "setInterval(() => {}, 1000)"`,
      healthcheck: slowHealthcheck,
    });
    const b = makeCommand({
      id: "b",
      name: "B",
      run: `bun -e "setInterval(() => {}, 1000)"`,
      healthcheck: slowHealthcheck,
    });
    const queue = new SpawnQueue("test", [a, b], () => testEnv());

    const start = Date.now();
    await queue.startAll();
    const elapsed = Date.now() - start;

    expect(queue.listSnapshots().every((s) => s.status === "running")).toBe(true);
    expect(elapsed).toBeLessThan(350);

    await queue.stopAll();
  });

  test("one branch failing doesn't block an unrelated branch from starting", async () => {
    const broken = makeCommand({
      id: "broken",
      name: "Broken",
      run: `bun -e "setInterval(() => {}, 1000)"`,
      healthcheck: {
        type: "command",
        command: "exit 1",
        interval_ms: 10,
        timeout_ms: 100,
        retries: 2,
      },
    });
    const blockedByBroken = makeCommand({
      id: "blocked-by-broken",
      name: "Blocked By Broken",
      run: `bun -e "1"`,
      deps: ["broken"],
    });
    const independent = makeCommand({
      id: "independent",
      name: "Independent",
      run: `bun -e "setInterval(() => {}, 1000)"`,
    });
    const queue = new SpawnQueue("test", [broken, blockedByBroken, independent], () => testEnv());

    try {
      await queue.startAll();

      expect(queue.getWrapper("independent")?.status).toBe("running");
      expect(queue.getWrapper("broken")?.status).toBe("failed");
      // blocked-by-broken never even got a wrapper: it was blocked before spawning.
      expect(queue.getWrapper("blocked-by-broken")).toBeUndefined();
    } finally {
      await queue.getWrapper("broken")?.forceKillAndWait();
      await queue.stopAll();
    }
  });
});

describe("SpawnQueue - transitive dependency failure", () => {
  test("a failure two levels down blocks the top-level command, fast (not a 60s poll)", async () => {
    const c = makeCommand({
      id: "c",
      name: "C",
      run: `bun -e "setInterval(() => {}, 1000)"`,
      healthcheck: {
        type: "command",
        command: "exit 1",
        interval_ms: 10,
        timeout_ms: 100,
        retries: 2,
      },
    });
    const b = makeCommand({ id: "b", name: "B", run: `bun -e "1"`, deps: ["c"] });
    const a = makeCommand({ id: "a", name: "A", run: `bun -e "1"`, deps: ["b"] });
    const queue = new SpawnQueue("test", [a, b, c], () => testEnv());

    try {
      const start = Date.now();
      await expect(queue.startOne("a")).rejects.toThrow(/[Bb]locked/);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(2000); // well under the 60s per-dependency timeout
      expect(queue.getWrapper("c")?.status).toBe("failed");
      // b never got far enough to spawn: its own dependency (c) failed first.
      expect(queue.getWrapper("b")).toBeUndefined();
    } finally {
      await queue.getWrapper("c")?.forceKillAndWait();
    }
  });
});

describe("SpawnQueue - dangling dependency reference", () => {
  test("fails fast instead of polling for 60s when a dep id doesn't exist in the profile", async () => {
    const cmd = makeCommand({ id: "a", name: "A", run: `bun -e "1"`, deps: ["nonexistent"] });
    const queue = new SpawnQueue("test", [cmd], () => testEnv());

    const start = Date.now();
    await expect(queue.startOne("a")).rejects.toThrow(/not a known command/);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("SpawnQueue - notification affectedDownstream", () => {
  test("records every transitive dependent of the command that actually failed", async () => {
    const root = makeCommand({
      id: "root",
      name: "Root",
      run: `bun -e "setInterval(() => {}, 1000)"`,
      healthcheck: {
        type: "command",
        command: "exit 1",
        interval_ms: 10,
        timeout_ms: 100,
        retries: 2,
      },
    });
    const mid = makeCommand({ id: "mid", name: "Mid", run: `bun -e "1"`, deps: ["root"] });
    const leaf = makeCommand({ id: "leaf", name: "Leaf", run: `bun -e "1"`, deps: ["mid"] });
    const queue = new SpawnQueue("test", [root, mid, leaf], () => testEnv());

    try {
      await queue.startOne("leaf").catch(() => {});

      const rootFailure = queue
        .listNotifications()
        .find((n) => n.type === "healthcheck_failed" && n.commandId === "root");
      expect(rootFailure).toBeDefined();
      expect(new Set(rootFailure!.affectedDownstream)).toEqual(new Set(["mid", "leaf"]));
    } finally {
      await queue.getWrapper("root")?.forceKillAndWait();
    }
  });
});

describe("SpawnQueue.restartOne - recovery notification", () => {
  test("does not claim recovery when restarting an already-healthy service", async () => {
    const cmd = makeCommand({
      id: "healthy",
      name: "Healthy",
      run: `bun -e "setInterval(() => {}, 1000)"`,
      stop_timeout_ms: 2000,
    });
    const queue = new SpawnQueue("test", [cmd], () => testEnv());

    await queue.startOne("healthy");
    await queue.restartOne("healthy");

    expect(queue.listNotifications().some((n) => n.type === "recovered")).toBe(false);

    await queue.stopAll();
  });
});

describe("SpawnQueue - single-flight starts", () => {
  test("concurrent startOne calls for the same command only spawn one process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-queue-singleflight-"));
    const logPath = join(dir, "spawns.log");
    try {
      const cmd = makeCommand({
        id: "solo",
        name: "Solo",
        run: `bun -e "require('fs').appendFileSync(process.env.SPAWN_LOG, process.pid + '\\n'); setInterval(() => {}, 1000)"`,
      });
      const queue = new SpawnQueue("test", [cmd], () => testEnv({ SPAWN_LOG: logPath }));

      await Promise.all([queue.startOne("solo"), queue.startOne("solo")]);
      await new Promise((r) => setTimeout(r, 100)); // let any stray second spawn's write land

      const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);

      await queue.stopAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SpawnQueue.startMany", () => {
  test("only starts the given command ids, not every command in the queue", async () => {
    // Mirrors how the store's single global queue holds every command from
    // every profile — "run profile" must be able to start just its own
    // command_ids, not startAll's entire queue.
    const a = makeCommand({ id: "a", name: "A", run: `bun -e "setInterval(() => {}, 1000)"` });
    const b = makeCommand({ id: "b", name: "B", run: `bun -e "setInterval(() => {}, 1000)"` });
    const c = makeCommand({ id: "c", name: "C", run: `bun -e "setInterval(() => {}, 1000)"` });
    const queue = new SpawnQueue("test", [a, b, c], () => testEnv());

    await queue.startMany(["a", "b"]);

    expect(queue.getWrapper("a")?.status).toBe("running");
    expect(queue.getWrapper("b")?.status).toBe("running");
    expect(queue.getWrapper("c")).toBeUndefined();

    await queue.stopAll();
  });
});
