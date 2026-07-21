import { z } from "zod";

/**
 * Readiness probe for a command. Dependents wait for this to pass
 * before starting, instead of just waiting for the process to spawn.
 */
export const HealthcheckSchema = z.object({
  type: z.enum(["none", "port", "http", "command"]).default("none"),
  port: z.number().int().positive().optional(),
  url: z.string().optional(),
  command: z.string().optional(),
  interval_ms: z.number().int().positive().default(1000),
  timeout_ms: z.number().int().positive().default(30_000),
  retries: z.number().int().positive().default(30),
});

export type HealthcheckConfig = z.infer<typeof HealthcheckSchema>;

/**
 * Schema for a single command within a profile.
 */
export const CommandSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  run: z.string().min(1),
  cwd: z.string().default("."),
  shell: z.boolean().default(true),
  deps: z.array(z.string()).default([]),
  env_overrides: z.record(z.string(), z.string()).default({}),
  watch: z.array(z.string()).default([]),
  readonly: z.boolean().default(false),
  stop_signal: z.string().default("SIGTERM"),
  stop_timeout_ms: z.number().int().positive().default(30_000),
  stop_command: z.string().min(1).optional(),
  healthcheck: HealthcheckSchema.optional(),
});

export type CommandConfig = z.infer<typeof CommandSchema>;

/**
 * Schema for a profile (e.g. dev, staging, prod).
 */
export const ProfileSchema = z.object({
  description: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  commands: z.array(CommandSchema).default([]),
});

export type ProfileConfig = z.infer<typeof ProfileSchema>;

/**
 * Top-level schema for `.conductor.yml`.
 */
export const ConductorConfigSchema = z.object({
  version: z.string().default("1"),
  name: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  env_secrets: z.array(z.string()).default([]),
  // Where the target application(s) are installed on disk. Relative `cwd`
  // values on commands (and relative healthcheck `command`s) resolve
  // against this path rather than wherever the Conductor server happens to
  // be launched from. Relative here means relative to the directory
  // containing this config file; defaults to that directory itself ("."),
  // and is also exposed to every command as the `${BASE_PATH}` env var so
  // it can be referenced when building other paths (e.g. a sibling repo
  // checkout: `${BASE_PATH}/../my-app`).
  base_path: z.string().default("."),
  // Overrides the shell used for `shell: true` commands and command-type
  // healthchecks (a binary path, e.g. "/bin/zsh" or "C:\\...\\pwsh.exe").
  // Falls back to $SHELL/%COMSPEC% when unset - see executor/shell.ts.
  default_shell: z.string().optional(),
  global_env: z.record(z.string(), z.string()).default({}),
  profiles: z.record(z.string(), ProfileSchema),
});

export type ConductorConfig = z.infer<typeof ConductorConfigSchema>;
