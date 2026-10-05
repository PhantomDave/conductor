import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  ConfigError,
  DEFAULT_DB_PATH,
  LogBroadcaster,
  openSession,
  prepareSession,
  resolveWorkspaceDir,
  saveConfig,
  validateConfig,
} from "../src";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conductor-session-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveWorkspaceDir", () => {
  test("expands a leading ~", () => {
    // Bun's os.homedir() reads the real OS home dir, not $HOME, so this
    // creates (and cleans up) a real subdir under it rather than faking HOME.
    const home = homedir();
    const tmpInHome = mkdtempSync(join(home, ".conductor-session-test-"));
    const relative = tmpInHome.slice(home.length + 1);
    try {
      expect(resolveWorkspaceDir(`~/${relative}`)).toBe(join(home, relative));
    } finally {
      rmSync(tmpInHome, { recursive: true, force: true });
    }
  });

  test("accepts a trailing slash or the .conductor.yml path itself", () => {
    expect(resolveWorkspaceDir(`${dir}/`)).toBe(dir);
    expect(resolveWorkspaceDir(join(dir, ".conductor.yml"))).toBe(dir);
  });

  test("throws ConfigError for a missing folder", () => {
    expect(() => resolveWorkspaceDir(join(dir, "does-not-exist"))).toThrow(/Folder not found/);
  });

  test("throws ConfigError for a path that is a regular file, not a directory", () => {
    const filePath = join(dir, "not-a-dir.txt");
    writeFileSync(filePath, "hello");
    expect(() => resolveWorkspaceDir(filePath)).toThrow(/Folder not found/);
  });
});

describe("prepareSession", () => {
  test("creates .conductor.yml (name = basename) and .conductor/.gitignore on an empty dir", () => {
    const { configPath, config } = prepareSession(dir);

    expect(configPath).toBe(join(dir, ".conductor.yml"));
    expect(config.name).toBe(basename(dir));
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(join(dir, ".conductor", ".gitignore"), "utf-8")).toBe("*\n");
  });

  test("invalid YAML throws ConfigError and creates no DB file", () => {
    writeFileSync(join(dir, ".conductor.yml"), "commands: [\n  - id: unterminated");

    expect(() => prepareSession(dir)).toThrow(ConfigError);
    expect(existsSync(join(dir, DEFAULT_DB_PATH))).toBe(false);
  });
});

describe("openSession", () => {
  // `sleep` is POSIX-only; this exercises a real long-running process and
  // its pid, which `bun -e "..."` (the portable idiom elsewhere in this
  // suite) can't give us as directly.
  test.skipIf(process.platform === "win32")(
    "close() stops the managed process and closes the DB",
    async () => {
      const config = validateConfig({
        version: "1",
        name: "Test",
        commands: [
          { id: "sleeper", name: "Sleeper", run: "sleep 30", shell: false, stop_timeout_ms: 500 },
        ],
        profiles: { default: { command_ids: ["sleeper"] } },
      });
      saveConfig(join(dir, ".conductor.yml"), config);

      const session = openSession(dir, { broadcaster: new LogBroadcaster(), dbPath: ":memory:" });
      await session.store.getQueue().startOne("sleeper");
      const [snapshot] = session.store.getQueue().listSnapshots();
      const pid = snapshot!.pid;

      await session.close();

      expect(() => process.kill(pid, 0)).toThrow();
      expect(() => session.queries.listEnvVars("global")).toThrow();
    },
  );

  test("close() still releases the DB when stopping processes fails", async () => {
    const session = openSession(dir, { broadcaster: new LogBroadcaster(), dbPath: ":memory:" });
    session.store.getQueue().stopAll = async () => {
      throw new Error("boom");
    };

    expect(await session.close().catch((err: Error) => err.message)).toBe("boom");
    expect(() => session.queries.listEnvVars("global")).toThrow();
  });
});
