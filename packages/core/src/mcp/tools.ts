import { configTools } from "./tools/config";
import { envLogTools } from "./tools/env-logs";
import { executionTools } from "./tools/execution";
import { profileTools } from "./tools/profiles";
import { workspaceTools } from "./tools/workspace";
import type { McpToolDef } from "./route";

export { callRoute, type McpToolDef, type RouteRequest, type ToolContext } from "./route";

/**
 * Every MCP tool, in presentation order. Each is a thin mapping onto an
 * `/api/*` route (or, for `process_wait`, a poll of one); definitions live in
 * `./tools/<domain>.ts`. Not exposed: `/api/health`, the legacy
 * `/api/docker compose/parse` alias and the `/api/logs/stream` SSE feed.
 */
export const TOOLS: McpToolDef[] = [
  ...workspaceTools,
  ...profileTools,
  ...executionTools,
  ...envLogTools,
  ...configTools,
];
