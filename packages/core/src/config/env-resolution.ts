import { dirname, resolve, isAbsolute } from "node:path";
import type { ConductorConfig, CommandConfig, ProfileConfig } from "./schema";
import { mergeEnv, interpolateEnv } from "../env/masker";

/**
 * Resolves `config.base_path` to an absolute directory. A relative
 * `base_path` (including the default ".") is resolved against the
 * directory containing the config file itself, not the process's cwd -
 * this is what lets `cwd`/env vars stay portable regardless of where
 * `conductor`/the server binary happens to be launched from.
 */
export function resolveBasePath(configFilePath: string, basePath: string): string {
  return isAbsolute(basePath) ? basePath : resolve(dirname(configFilePath), basePath);
}

export interface BuildEnvParams {
  configFilePath: string;
  config: ConductorConfig;
  profile: ProfileConfig | undefined;
  /** Extra env layers sourced from SQLite, in priority order. */
  dbGlobalEnv?: Record<string, string>;
  dbProfileEnv?: Record<string, string>;
}

export interface BuildCommandEnvParams extends BuildEnvParams {
  cmd: CommandConfig;
}

function baseLayers(params: BuildEnvParams): Array<Record<string, string> | undefined> {
  const { configFilePath, config, profile, dbGlobalEnv, dbProfileEnv } = params;
  return [
    process.env as Record<string, string>,
    { BASE_PATH: resolveBasePath(configFilePath, config.base_path) },
    config.global_env,
    dbGlobalEnv,
    profile?.env,
    dbProfileEnv,
  ];
}

/**
 * Computes the fully-resolved environment for a profile (or the whole
 * project, if `profile` is omitted): process.env, then `BASE_PATH`
 * (derived from `config.base_path`), then global_env, then any DB-stored
 * global vars, then the profile's env, then any DB-stored profile vars -
 * each layer can override the last, and `${VAR}` references are
 * interpolated last so they can reach across every layer.
 *
 * This is the same resolution `buildCommandEnv` does minus the
 * command-specific `env_overrides` layer, for use by anything that isn't
 * tied to one command - e.g. the config-example compiler, which fills in
 * `.env`/`appsettings.json` files for a whole profile at once.
 */
export function buildProfileEnv(params: BuildEnvParams): Record<string, string> {
  return interpolateEnv(mergeEnv(...baseLayers(params)));
}

/**
 * Computes a command's fully-resolved environment: everything
 * `buildProfileEnv` resolves, plus the command's own `env_overrides` on
 * top.
 *
 * Shared between the server (`ConfigStore`) and the CLI's `run` command so
 * both resolve env identically.
 */
export function buildCommandEnv(params: BuildCommandEnvParams): Record<string, string> {
  return interpolateEnv(mergeEnv(...baseLayers(params), params.cmd.env_overrides));
}
