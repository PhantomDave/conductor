import { describe, test, expect } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  loadConfig,
  loadConfigFile,
  validateConfig,
  discoverConfigPath,
  createDefaultConfig,
  ConfigError,
} from "../src";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures/sample.conductor.yml");

describe("loadConfig", () => {
  test("loads and validates the sample fixture", () => {
    const config = loadConfig(FIXTURE_PATH);
    expect(config.name).toBe("Conductor Test Fixture");
    expect(config.commands.map((c) => c.id)).toEqual(["hello", "world", "failer", "sleeper"]);
    expect(config.profiles.dev.command_ids).toEqual(["hello", "world"]);
    expect(config.profiles.broken.command_ids).toEqual(["failer"]);
  });

  test("preserves declared deps between commands", () => {
    const config = loadConfig(FIXTURE_PATH);
    const world = config.commands.find((c) => c.id === "world");
    expect(world?.deps).toEqual(["hello"]);
  });

  test("applies schema defaults to fields left unset", () => {
    const config = loadConfig(FIXTURE_PATH);
    const hello = config.commands.find((c) => c.id === "hello");
    expect(hello?.cwd).toBe(".");
    expect(hello?.stop_signal).toBe("SIGTERM");
    expect(hello?.stop_timeout_ms).toBe(5_000);
    const sleeper = config.commands.find((c) => c.id === "sleeper");
    expect(sleeper?.stop_timeout_ms).toBe(2_000);
  });
});

describe("loadConfigFile", () => {
  test("throws ConfigError for a missing file", () => {
    expect(() => loadConfigFile("/nonexistent/path/.conductor.yml")).toThrow(ConfigError);
  });

  test("throws ConfigError for invalid YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-loader-"));
    const badPath = join(dir, ".conductor.yml");
    writeFileSync(badPath, "commands: [\n  - id: unterminated");
    try {
      expect(() => loadConfigFile(badPath)).toThrow(ConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validateConfig - old format migration", () => {
  test("migrates commands nested under profiles to root-level + command_ids", () => {
    const migrated = validateConfig({
      version: "1",
      profiles: {
        dev: {
          commands: [{ id: "a", name: "A", run: "echo a" }],
        },
      },
    });
    expect(migrated.commands.map((c) => c.id)).toEqual(["a"]);
    expect(migrated.profiles.dev.command_ids).toEqual(["a"]);
  });

  test("dedupes a command id shared across profiles", () => {
    const migrated = validateConfig({
      version: "1",
      profiles: {
        dev: { commands: [{ id: "shared", name: "Shared", run: "echo dev" }] },
        prod: { commands: [{ id: "shared", name: "Shared", run: "echo prod" }] },
      },
    });
    expect(migrated.commands.filter((c) => c.id === "shared").length).toBe(1);
  });

  test("leaves an already-new-format config untouched", () => {
    const raw = {
      version: "1",
      commands: [{ id: "a", name: "A", run: "echo a" }],
      profiles: { dev: { command_ids: ["a"] } },
    };
    const migrated = validateConfig(raw);
    expect(migrated.commands.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("discoverConfigPath", () => {
  test("finds .conductor.yml by walking up from a nested directory", () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-discover-"));
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".conductor.yml"), 'version: "1"\nprofiles: {}\n');

    try {
      expect(discoverConfigPath(nested)).toBe(join(root, ".conductor.yml"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null when no config file exists in any ancestor directory", () => {
    // Relies on the OS temp root having no stray .conductor.yml above it,
    // which holds on standard CI runners (ubuntu/macos/windows).
    const root = mkdtempSync(join(tmpdir(), "conductor-discover-none-"));
    try {
      expect(discoverConfigPath(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createDefaultConfig", () => {
  test("produces a valid, minimal config with an empty default profile", () => {
    const config = createDefaultConfig();
    expect(config.profiles.default).toBeDefined();
    expect(config.commands).toEqual([]);
  });
});
