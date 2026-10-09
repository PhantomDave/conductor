import { z } from "zod";
import {
  EnvImportSchema,
  EnvVarInputSchema,
  LogRunsQuerySchema,
  LogsQuerySchema,
} from "../../api-schemas";
import { DESTROY, MUTATE, READ, callRoute, defineTool, enc, type McpToolDef } from "../route";

const FILTERED = "[FILTERED]";

function redactVar(row: unknown): unknown {
  if (typeof row !== "object" || row === null) return row;
  return (row as { is_secret?: unknown }).is_secret ? { ...row, value: FILTERED } : row;
}

/**
 * The HTTP API returns env values as stored and leaves masking to the UI.
 * Tool output goes into an agent's context, so secret values never leave here:
 * every env row flagged `is_secret` has its value replaced with `[FILTERED]`.
 */
export function redactEnvBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const { vars, var: single, ...rest } = body as { vars?: unknown; var?: unknown };
  return {
    ...rest,
    ...(vars !== undefined ? { vars: Array.isArray(vars) ? vars.map(redactVar) : vars } : {}),
    ...(single !== undefined ? { var: redactVar(single) } : {}),
  };
}

// The API coerces these from query strings; tools take real numbers.
const limit = (max: number) => z.number().int().min(1).max(max).optional();

export const envLogTools: McpToolDef[] = [
  defineTool({
    name: "env_list",
    description:
      "List environment variables stored in Conductor (global and per-profile) that are injected into started commands. Secret values are always shown as [FILTERED]. Pass scope (and profile) to narrow the list.",
    input: {
      scope: z.enum(["global", "profile"]).optional(),
      profile: z
        .string()
        .min(1)
        .optional()
        .describe("Profile name; only used with scope 'profile'"),
    },
    annotations: READ,
    run: (query, { app }) =>
      callRoute(app, { method: "GET", url: "/api/env", query }, redactEnvBody),
  }),
  defineTool({
    name: "env_set",
    description:
      "Create or overwrite one environment variable. scope 'profile' requires a profile. Keys that look like secrets (TOKEN, PASSWORD, ...) are marked secret automatically; set secret explicitly to override. Running processes need command_restart to see the change.",
    input: EnvVarInputSchema.shape,
    annotations: MUTATE,
    run: (args, { app }) =>
      callRoute(app, { method: "PUT", url: "/api/env", payload: args }, redactEnvBody),
  }),
  defineTool({
    name: "env_delete",
    description: "Delete an environment variable by its numeric id (from env_list).",
    input: { id: z.number().int().positive().describe("Variable id from env_list") },
    annotations: DESTROY,
    request: ({ id }) => ({ method: "DELETE", url: `/api/env/${enc(String(id))}` }),
  }),
  defineTool({
    name: "env_import",
    description:
      "Bulk-set environment variables from .env-style text (KEY=VALUE per line; # comments and blank lines ignored). Existing keys are overwritten. scope 'profile' requires a profile.",
    input: EnvImportSchema.shape,
    annotations: MUTATE,
    run: (args, { app }) =>
      callRoute(app, { method: "POST", url: "/api/env/import", payload: args }, redactEnvBody),
  }),

  defineTool({
    name: "log_query",
    description:
      "Search stored process output. Filter by pid, commandId, profile, level and a substring (grep); returns up to limit lines (oldest first). Use after a failure to read what a command printed.",
    input: {
      ...LogsQuerySchema.shape,
      pid: z.number().int().positive().optional().describe("Only logs of this process id"),
      limit: limit(2000).describe("Maximum lines to return"),
    },
    annotations: READ,
    request: (query) => ({ method: "GET", url: "/api/logs", query }),
  }),
  defineTool({
    name: "log_runs",
    description:
      "List past runs (one per pid) that still have logs stored, newest first. Use to find the pid of an earlier run before calling log_query.",
    input: {
      ...LogRunsQuerySchema.shape,
      limit: limit(2000).describe("Maximum runs to return"),
    },
    annotations: READ,
    request: (query) => ({ method: "GET", url: "/api/logs/runs", query }),
  }),
  defineTool({
    name: "log_prune",
    description:
      "Delete stored logs now according to the configured retention (age and per-profile session count) instead of waiting for the periodic sweep. Deleted logs cannot be recovered.",
    input: {},
    annotations: DESTROY,
    request: () => ({ method: "POST", url: "/api/logs/prune" }),
  }),
];
