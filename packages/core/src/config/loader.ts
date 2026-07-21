import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as yaml from "js-yaml";
import { ConductorConfigSchema, type ConductorConfig } from "./schema";

export class ConfigError extends Error {}

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
 * Throws ConfigError with a readable message on validation failure.
 */
export function validateConfig(raw: unknown): ConductorConfig {
  const result = ConductorConfigSchema.safeParse(raw);
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
