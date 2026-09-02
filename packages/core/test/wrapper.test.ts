import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessWrapper } from "../src/executor/wrapper";
import { CommandSchema, type CommandConfig } from "../src/config/schema";

// Every spawned command below shells out to `bun -e "<script>"` rather than
// platform builtins (echo/sleep/etc.) so these tests behave identically on
// Linux/macOS/Windows in CI. `-e`'s argument always uses double quotes with
// single-quoted JS string literals inside, which parses correctly under both
// POSIX sh -c and Windows cmd.exe /c.

function makeCommand(
  overrides: Partial<CommandConfig> & { id: string; name: string; run: string },
): CommandConfig {
  return CommandSchema.parse(overrides);
}

/** process.env with the `string | undefined` values narrowed to `string`. */
function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Starts the wrapper and resolves with the exit code once it terminates. */
function runToExit(wrapper: ProcessWrapper): Promise<number> {
  return new Promise((resolve) => {
    wrapper.onExit(resolve);
    wrapper.start().catch(() => {});
  });
}

describe("ProcessWrapper.start", () => {
  test("spawns the process and reports a pid immediately", async () => {
    const cmd = makeCommand({ id: "quick", name: "Quick", run: `bun -e "console.log(1)"` });
    const wrapper = new ProcessWrapper(cmd, "test", testEnv());
    await wrapper.start();
    expect(wrapper.pid).toBeGreaterThan(0);
    expect(wrapper.status).toBe("starting");
  });

  test("transitions to stopped with exit code 0 on a clean exit", async () => {
    const cmd = makeCommand({
      id: "clean-exit",
      name: "Clean Exit",
      run: `bun -e "process.exit(0)"`,
    });
    const wrapper = new ProcessWrapper(cmd, "test", testEnv());
    const exitCode = await runToExit(wrapper);
    expect(exitCode).toBe(0);
    expect(wrapper.status).toBe("stopped");
    expect(wrapper.getSnapshot()?.exitCode).toBe(0);
  });

  test("transitions to failed with the real exit code on a non-zero exit", async () => {
    const cmd = makeCommand({ id: "bad-exit", name: "Bad Exit", run: `bun -e "process.exit(7)"` });
    const wrapper = new ProcessWrapper(cmd, "test", testEnv());
    const exitCode = await runToExit(wrapper);
    expect(exitCode).toBe(7);
    expect(wrapper.status).toBe("failed");
    expect(wrapper.getSnapshot()?.exitCode).toBe(7);
  });

  test("streams stdout line-by-line, flushing a final unterminated line on exit", async () => {
    const cmd = makeCommand({
      id: "multiline",
      name: "Multiline",
      run: `bun -e "console.log('a'); console.log('b'); process.stdout.write('c')"`,
    });
    const wrapper = new ProcessWrapper(cmd, "test", testEnv());
    const lines: string[] = [];
    wrapper.onLog((entry) => {
      if (entry.stream === "stdout") lines.push(entry.message);
    });
    await runToExit(wrapper);
    expect(lines).toEqual(["a", "b", "c"]);
  });

  test("tags every log entry with the spawned pid, command id, and profile", async () => {
    const cmd = makeCommand({ id: "tagged", name: "Tagged", run: `bun -e "console.log('hi')"` });
    const wrapper = new ProcessWrapper(cmd, "my-profile", testEnv());
    const entries: Array<{ pid: number; commandId: string; profile: string }> = [];
    wrapper.onLog((entry) => entries.push(entry));
    await runToExit(wrapper);
    expect(entries).toHaveLength(1);
    expect(entries[0].commandId).toBe("tagged");
    expect(entries[0].profile).toBe("my-profile");
    expect(entries[0].pid).toBe(wrapper.pid);
  });

  test("resolves a relative cwd against BASE_PATH rather than the server's own cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-wrapper-cwd-"));
    try {
      const cmd = makeCommand({
        id: "pwd",
        name: "Pwd",
        run: `bun -e "console.log(process.cwd())"`,
        cwd: ".",
      });
      const wrapper = new ProcessWrapper(cmd, "test", testEnv({ BASE_PATH: dir }));
      const lines: string[] = [];
      wrapper.onLog((entry) => lines.push(entry.message));
      await runToExit(wrapper);
      // realpath both sides: on macOS /tmp is itself a symlink to /private/tmp.
      expect(realpathSync(lines[0])).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shell: false correctly tokenizes a quoted argument containing spaces", async () => {
    // Regression test for the naive `run.split(/\s+/)` this replaced, which
    // would have torn "hello world" into two separate argv entries.
    const cmd = makeCommand({
      id: "argv-check",
      name: "Argv Check",
      shell: false,
      run: `bun -e "console.log(process.argv.slice(1).join('|'))" "hello world" second`,
    });
    const wrapper = new ProcessWrapper(cmd, "test", testEnv());
    const lines: string[] = [];
    wrapper.onLog((entry) => lines.push(entry.message));
    await runToExit(wrapper);
    expect(lines).toEqual(["hello world|second"]);
  });

  test("kills a stale subprocess from a previous lifecycle before spawning a new one", async () => {
    const cmd = makeCommand({
      id: "restartable",
      name: "Restartable",
      run: `bun -e "setInterval(() => {}, 1000)"`,
    });
    const wrapper = new ProcessWrapper(cmd, "test", testEnv());
    await wrapper.start();
    const firstPid = wrapper.pid;
    expect(firstPid).toBeGreaterThan(0);

    await wrapper.start(); // second start() must clean up the first process
    const secondPid = wrapper.pid;
    expect(secondPid).toBeGreaterThan(0);
    expect(secondPid).not.toBe(firstPid);

    await wrapper.stop();
  });
});

describe("ProcessWrapper.stop", () => {
  test("stops a long-running process within its timeout budget", async () => {
    const cmd = makeCommand({
      id: "sleeper",
      name: "Sleeper",
      run: `bun -e "setInterval(() => {}, 1000)"`,
      stop_timeout_ms: 3000,
    });
    const wrapper = new ProcessWrapper(cmd, "test", testEnv());
    await wrapper.start();
    expect(wrapper.pid).toBeGreaterThan(0);

    await wrapper.stop();
    expect(wrapper.status).toBe("stopped");
  });

  test("is a no-op when the process was never started", async () => {
    const cmd = makeCommand({ id: "never-started", name: "Never Started", run: `bun -e "1"` });
    const wrapper = new ProcessWrapper(cmd, "test", testEnv());
    await expect(wrapper.stop()).resolves.toBeUndefined();
  });

  test("forceKillAndWait reports an intentional kill as stopped, not failed", async () => {
    // SIGKILL usually produces a non-zero/null exit code, which the exit
    // handler would otherwise read as a crash. forceKillAndWait is always a
    // deliberate teardown (orphan cleanup, restart) and should never surface
    // as "failed".
    const cmd = makeCommand({
      id: "kill-me",
      name: "Kill Me",
      run: `bun -e "setInterval(() => {}, 1000)"`,
    });
    const wrapper = new ProcessWrapper(cmd, "test", testEnv());
    await wrapper.start();

    await wrapper.forceKillAndWait();

    expect(wrapper.status).toBe("stopped");
  });

  test("runs a custom stop_command instead of signalling the process directly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-wrapper-stopcmd-"));
    const markerPath = join(dir, "stopped.txt");
    try {
      const cmd = makeCommand({
        id: "sleeper2",
        name: "Sleeper2",
        run: `bun -e "setInterval(() => {}, 1000)"`,
        stop_command: `bun -e "require('fs').writeFileSync(process.env.MARKER_PATH, 'ok')"`,
        stop_timeout_ms: 3000,
      });
      const wrapper = new ProcessWrapper(cmd, "test", testEnv({ MARKER_PATH: markerPath }));
      await wrapper.start();
      await wrapper.stop();

      expect(await Bun.file(markerPath).exists()).toBe(true);
      expect(wrapper.status).toBe("stopped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
