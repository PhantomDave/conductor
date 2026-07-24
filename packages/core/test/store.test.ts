import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config/store";
import { ConfigError, validateConfig } from "../src/config/loader";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conductor-store-"));
  configPath = join(dir, ".conductor.yml");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeStore() {
  const initial = validateConfig({
    version: "1",
    profiles: {
      dev: { commands: [{ id: "hello", name: "Hello", run: "echo hi" }] },
    },
  });
  return new ConfigStore(configPath, initial);
}

describe("ConfigStore.importConfig", () => {
  test("replaces the whole config, persists to disk, and rebuilds queues", () => {
    const store = makeStore();
    const initialQueue = store.getQueue();
    expect(initialQueue).toBeDefined();
    expect(initialQueue.listCommands().length).toBe(1); // hello from dev

    const imported = store.importConfig({
      version: "1",
      name: "Imported project",
      profiles: {
        staging: { commands: [{ id: "deploy", name: "Deploy", run: "echo deploying" }] },
      },
    });

    expect(imported.name).toBe("Imported project");
    expect(imported.profiles.staging).toBeDefined();
    expect(imported.profiles.dev).toBeUndefined();

    // The global queue now contains commands from the new config
    const newQueue = store.getQueue();
    expect(newQueue).toBeDefined();
    expect(newQueue.listCommands().length).toBe(1); // deploy from staging
    const deployCmd = newQueue.listCommands()[0];
    expect(deployCmd.id).toBe("deploy");

    // And it's actually been written to disk, not just held in memory.
    const onDisk = readFileSync(configPath, "utf-8");
    expect(onDisk).toContain("Imported project");
    expect(onDisk).toContain("staging");
  });

  test("rejects an invalid import and leaves the current config untouched", () => {
    const store = makeStore();
    const before = store.getConfig();

    expect(() => store.importConfig({ profiles: { dev: { commands: [{}] } } })).toThrow(
      ConfigError,
    );

    // Nothing changed - same reference, same profiles.
    expect(store.getConfig()).toBe(before);
    expect(store.getQueue("dev")).toBeDefined();
  });
});
