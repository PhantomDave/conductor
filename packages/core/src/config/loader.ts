import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as yaml from "js-yaml";
import { ConductorConfigSchema, type ConductorConfig } from "./schema";

export class ConfigError extends Error {}

/**
 * Checks if a config uses the old format (commands nested in profiles).
 */
function usesOldFormat(profiles: Record<string, any> | undefined): boolean {
  if (!profiles || typeof profiles !== "object") return false;
  return Object.values(profiles).some(
    (profile) => profile && typeof profile === "object" && Array.isArray(profile.commands),
  );
}

/**
 * Extracts commands from old-format profiles and deduplicates by ID.
 */
function extractCommandsFromProfiles(profiles: Record<string, any>): Map<string, any> {
  const commandMap = new Map<string, any>();
  for (const profile of Object.values(profiles)) {
    if (profile && Array.isArray(profile.commands)) {
      for (const cmd of profile.commands) {
        if (cmd && typeof cmd === "object" && cmd.id) {
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
function migrateProfiles(profiles: Record<string, any>): Record<string, any> {
  const migratedProfiles: Record<string, any> = {};
  for (const [profileName, profile] of Object.entries(profiles)) {
    if (!profile || typeof profile !== "object") continue;
    const commands = (profile as Record<string, any>).commands || [];
    const command_ids = Array.isArray(commands)
      ? commands.filter((c): c is any => c && typeof c === "object" && c.id).map((c) => c.id)
      : [];
    migratedProfiles[profileName] = {
      description: (profile as Record<string, any>).description,
      env: ((profile as Record<string, any>).env as Record<string, string>) || {},
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
  if (typeof raw !== "object" || raw === null) {
    return raw;
  }

  const config = raw as Record<string, unknown>;
  const profiles = config.profiles as Record<string, any> | undefined;

  if (!profiles || !usesOldFormat(profiles)) {
    return raw;
  }

  const commandMap = extractCommandsFromProfiles(profiles);
  const migratedProfiles = migrateProfiles(profiles);

  return {
    ...config,
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
