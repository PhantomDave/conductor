import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as yaml from "js-yaml";
import { ConductorConfigSchema, type ConductorConfig } from "./schema";

export class ConfigError extends Error {}

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null;
}

/** Old-format commands are identified by a truthy `id`; the schema validates the rest. */
function hasId(value: unknown): value is RawRecord & { id: unknown } {
  return isRecord(value) && Boolean(value.id);
}

/**
 * Checks if a config uses the old format (commands nested in profiles).
 */
function usesOldFormat(profiles: RawRecord): boolean {
  return Object.values(profiles).some(
    (profile) => isRecord(profile) && Array.isArray(profile.commands),
  );
}

/**
 * Extracts commands from old-format profiles and deduplicates by ID.
 */
function extractCommandsFromProfiles(profiles: RawRecord): Map<unknown, RawRecord> {
  const commandMap = new Map<unknown, RawRecord>();
  for (const profile of Object.values(profiles)) {
    if (isRecord(profile) && Array.isArray(profile.commands)) {
      for (const cmd of profile.commands) {
        if (hasId(cmd)) {
          commandMap.set(cmd.id, cmd);
        }
      }
    }
  }
  return commandMap;
}

/**
 * Converts old-format profiles to new format (with command_ids instead of commands).
 */
function migrateProfiles(profiles: RawRecord): Record<string, RawRecord> {
  const migratedProfiles: Record<string, RawRecord> = {};
  for (const [profileName, profile] of Object.entries(profiles)) {
    if (!isRecord(profile)) continue;
    const commands = profile.commands || [];
    const command_ids = Array.isArray(commands) ? commands.filter(hasId).map((c) => c.id) : [];
    migratedProfiles[profileName] = {
      description: profile.description,
      env: profile.env || {},
      command_ids,
    };
  }
  return migratedProfiles;
}

/**
 * Migrates old config format (commands nested in profiles) to new format
 * (commands at root level, profiles reference via command_ids).
 * This enables backward compatibility with existing .conductor.yml files.
 */
function migrateConfigFormat(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return raw;
  }

  const profiles = isRecord(raw.profiles) ? raw.profiles : undefined;

  if (!profiles || !usesOldFormat(profiles)) {
    return raw;
  }

  const commandMap = extractCommandsFromProfiles(profiles);
  const migratedProfiles = migrateProfiles(profiles);

  return {
    ...raw,
    commands: Array.from(commandMap.values()),
    profiles: migratedProfiles,
  };
}

/**
 * Loads and parses a `.conductor.yml` file from an absolute or relative path.
 * Throws ConfigError on missing file or invalid YAML.
 */
export function loadConfigFile(filePath: string): unknown {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) {
    throw new ConfigError(`Config file not found: ${absolutePath}`);
  }

  const raw = readFileSync(absolutePath, "utf-8");
  try {
    return yaml.load(raw);
  } catch (err) {
    throw new ConfigError(`Failed to parse YAML in ${absolutePath}: ${(err as Error).message}`);
  }
}

/**
 * Validates a raw parsed object against the Conductor config schema.
 * Automatically migrates old config format to new format.
 * Throws ConfigError with a readable message on validation failure.
 */
export function validateConfig(raw: unknown): ConductorConfig {
  // Migrate old format to new format if needed
  const migrated = migrateConfigFormat(raw);

  const result = ConductorConfigSchema.safeParse(migrated);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid Conductor config:\n${issues}`);
  }
  return result.data;
}

/**
 * Loads and validates a `.conductor.yml` file in one step.
 */
export function loadConfig(filePath: string): ConductorConfig {
  const raw = loadConfigFile(filePath);
  return validateConfig(raw);
}

/**
 * Auto-discovers `.conductor.yml` by walking up from `startDir` to the
 * filesystem root, similar to ESLint config resolution.
 */
export function discoverConfigPath(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);

  while (true) {
    const candidate = join(dir, ".conductor.yml");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * A minimal but valid config used to bootstrap a brand-new workspace so
 * the API/UI have something to persist into on first run.
 */
export function createDefaultConfig(): ConductorConfig {
  return validateConfig({
    version: "1",
    name: "My Conductor Workspace",
    profiles: {
      default: {
        description: "Add your first command from the UI or this file",
        commands: [],
      },
    },
  });
}
