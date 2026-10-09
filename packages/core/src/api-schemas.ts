import { z } from "zod";
import { ConfigFileSchema, HealthcheckSchema } from "./config/schema";

/**
 * Request schemas of the HTTP API. Kept apart from `buildApi` (and re-exported
 * from `./api`) so the MCP tool definitions can reuse them without importing
 * the module that mounts them.
 */

export const CommandInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  category: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value?.trim() || undefined),
  description: z.string().optional(),
  run: z.string().min(1),
  cwd: z.string().optional(),
  shell: z.boolean().optional(),
  deps: z.array(z.string()).optional(),
  env_overrides: z.record(z.string(), z.string()).optional(),
  watch: z.array(z.string()).optional(),
  config_files: z.array(ConfigFileSchema).optional(),
  readonly: z.boolean().optional(),
  stop_signal: z.string().optional(),
  stop_timeout_ms: z.number().optional(),
  stop_command: z.string().min(1).optional(),
  restart: z.enum(["manual", "on_failure", "always"]).optional(),
  healthcheck: HealthcheckSchema.optional(),
});

export const CommandPatchSchema = CommandInputSchema.omit({ id: true }).partial();

export const EnvVarInputSchema = z.object({
  scope: z.enum(["global", "profile"]),
  profile: z.string().nullable().optional(),
  key: z.string().min(1),
  value: z.string(),
  secret: z.boolean().optional(),
});

export const EnvImportSchema = z.object({
  scope: z.enum(["global", "profile"]),
  profile: z.string().nullable().optional(),
  text: z.string(),
  secret: z.boolean().optional(),
});

export const NotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const LogsQuerySchema = z.object({
  pid: z.coerce.number().int().positive().optional(),
  commandId: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  grep: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

export const LogRunsQuerySchema = z.object({
  commandId: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

export const PidParamSchema = z.object({
  pid: z.coerce.number().int().positive(),
});

export const MetricsQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

export const WorkspacePathSchema = z.object({ path: z.string().min(1) });

export const BasePathSchema = z.object({ base_path: z.string().min(1) });

export const DefaultShellSchema = z.object({ default_shell: z.string().min(1).nullable() });

export const LogRetentionSchema = z.object({
  log_retention_days: z.number().int().min(0),
  log_retention_sessions: z.number().int().min(0),
});

export const ConfigureInputSchema = z.object({
  profile: z.string().optional(),
  force: z.boolean().optional(),
  plan: z.boolean().optional(),
});

export const ConfigImportSchema = z.object({
  yaml: z.string().min(1),
});

export const DockerComposeParseSchema = z.object({
  yaml: z.string().min(1),
});

export const ProfileUpdateSchema = z
  .object({ newName: z.string().min(1).optional(), description: z.string().optional() })
  .strict();

export const CommandSyncSchema = z.object({
  add: z.array(z.string().min(1)).optional(),
  remove: z.array(z.string().min(1)).optional(),
});

export const CommandDuplicateSchema = z.object({ targetProfile: z.string().min(1).optional() });

export const CommandMoveSchema = z.object({ targetProfile: z.string().min(1) });
