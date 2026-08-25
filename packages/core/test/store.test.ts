import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src";
import { ConfigError, validateConfig } from "../src";

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

    expect(() =>
      store.importConfig({ commands: [{}], profiles: { dev: { command_ids: [] } } }),
    ).toThrow(ConfigError);

    // Nothing changed - same reference, same profiles.
    expect(store.getConfig()).toBe(before);
    expect(store.getQueue("dev")).toBeDefined();
  });
});

describe("ConfigStore.duplicateProfile", () => {
  test("duplicates a profile and references same command IDs (not creating new commands)", () => {
    const initial = validateConfig({
      version: "1",
      commands: [
        { id: "api", name: "API", run: "npm run api" },
        { id: "db", name: "Database", run: "docker run postgres" },
      ],
      profiles: {
        dev: {
          command_ids: ["api", "db"],
          env: { DEBUG: "true" },
        },
      },
    });
    const store = new ConfigStore(configPath, initial);

    // Duplicate the profile
    const duplicate = store.duplicateProfile("dev", "dev-copy");

    // Verify the duplicated profile references the same command IDs
    expect(duplicate.command_ids).toEqual(["api", "db"]);
    expect(duplicate.env).toEqual({ DEBUG: "true" });
    expect(duplicate.description).toBeUndefined();

    // Verify no new commands were created
    const config = store.getConfig();
    expect(config.commands.length).toBe(2); // Still only the original 2 commands
    expect(config.commands[0].id).toBe("api");
    expect(config.commands[1].id).toBe("db");

    // Verify both profiles exist and reference the same commands
    expect(config.profiles.dev.command_ids).toEqual(["api", "db"]);
    expect(config.profiles["dev-copy"].command_ids).toEqual(["api", "db"]);
  });

  test("duplicates profile description with (copy) suffix", () => {
    const initial = validateConfig({
      version: "1",
      commands: [{ id: "hello", name: "Hello", run: "echo hi" }],
      profiles: {
        production: {
          command_ids: ["hello"],
          description: "Production environment",
        },
      },
    });
    const store = new ConfigStore(configPath, initial);

    const duplicate = store.duplicateProfile("production", "prod-backup");

    expect(duplicate.description).toBe("Production environment (copy)");
  });

  test("throws if source profile does not exist", () => {
    const store = makeStore();

    expect(() => store.duplicateProfile("nonexistent", "copy")).toThrow(
      /Unknown profile "nonexistent"/,
    );
  });

  test("throws if target profile already exists", () => {
    const store = makeStore();

    expect(() => store.duplicateProfile("dev", "dev")).toThrow(/Profile "dev" already exists/);
  });

  test("persists duplicated profile to disk", () => {
    const initial = validateConfig({
      version: "1",
      commands: [{ id: "test", name: "Test", run: "npm test" }],
      profiles: {
        dev: { command_ids: ["test"] },
      },
    });
    const store = new ConfigStore(configPath, initial);

    store.duplicateProfile("dev", "dev-staging");

    const onDisk = readFileSync(configPath, "utf-8");
    expect(onDisk).toContain("dev-staging");
    expect(onDisk).toContain("test");
  });
});

describe("ConfigStore command categories", () => {
  test("omits category when adding a command with an empty category", () => {
    const store = makeStore();

    const command = store.addCommand({ name: "Build", run: "npm run build", category: "" });

    expect(command.category).toBeUndefined();
    expect(store.getCommand(command.id)?.category).toBeUndefined();
    expect(readFileSync(configPath, "utf-8")).not.toContain("category:");
  });

  test("preserves category when updating a command without category in the patch", () => {
    const store = makeStore();
    const command = store.addCommand({ name: "API", run: "npm run api", category: "backend" });

    const updated = store.updateCommand(command.id, { run: "npm run api:dev" });

    expect(updated.category).toBe("backend");
  });

  test("removes category when update patch explicitly clears it", () => {
    const store = makeStore();
    const command = store.addCommand({ name: "UI", run: "npm run ui", category: "frontend" });

    const updated = store.updateCommand(command.id, { category: undefined });

    expect(updated.category).toBeUndefined();
    expect(readFileSync(configPath, "utf-8")).not.toContain("category:");
  });
});
