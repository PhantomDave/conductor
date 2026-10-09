import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * One MCP tool. Most tools are a thin mapping onto an existing HTTP route
 * (`request`), dispatched in-process through `app.inject()` so behaviour,
 * validation, and the workspace guard are exactly those of the HTTP API.
 * Tools that cannot be expressed as a single route supply `run` instead.
 */
export interface McpToolDef {
  name: string;
  /** Written for an AI agent: what it does and when to use it. */
  description: string;
  /** zod 4 raw shape; `{}` when the tool takes no arguments. */
  input: z.ZodRawShape;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  /**
   * Maps validated tool arguments to a route call. Path parameters must be
   * `encodeURIComponent`-ed by the mapper; `query` is serialised here.
   */
  // oxlint-disable-next-line no-explicit-any -- args are validated by `input` before the mapper runs
  request?: (args: any) => RouteRequest;
  /** Non-route tools (e.g. `process_wait`). */
  // oxlint-disable-next-line no-explicit-any -- args are validated by `input` before `run` is called
  run?: (args: any, ctx: ToolContext) => Promise<CallToolResult>;
}

export interface ToolContext {
  app: FastifyInstance;
  /** Aborted when the client cancels the request or disconnects. */
  signal?: AbortSignal;
}

export interface RouteRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  query?: Record<string, string | number | boolean | undefined>;
  payload?: unknown;
}

type ToolAnnotations = McpToolDef["annotations"];

/** Reads: no state change. */
export const READ: ToolAnnotations = { readOnlyHint: true };
/** Mutations that add or change things without removing or stopping anything. */
export const MUTATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
/** Deletes, stops, closes, imports and prunes: state is lost or interrupted. */
export const DESTROY: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

/** `encodeURIComponent` under a short name, for building route paths. */
export const enc = encodeURIComponent;

/**
 * Typed constructor: `request`/`run` receive the arguments as validated by
 * `input`, so mappers need no casts.
 */
export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  request?: (args: z.infer<z.ZodObject<S>>) => RouteRequest;
  run?: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult>;
}): McpToolDef {
  return def;
}

export function textResult(text: string, isError = false): CallToolResult {
  return isError
    ? { isError: true, content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }] };
}

function withQuery(url: string, query: RouteRequest["query"]): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return url;
  return url + (url.includes("?") ? "&" : "?") + qs;
}

/**
 * Dispatches a route call through `app.inject()` and converts the response:
 * 2xx -> pretty JSON text (empty/204 -> `{"ok":true}`); anything else -> a
 * tool error carrying the API's `error` message, never a protocol error.
 * `redact`, if given, rewrites a successful JSON body before it is returned
 * (used to keep secret values out of the output).
 */
export async function callRoute(
  app: FastifyInstance,
  req: RouteRequest,
  redact?: (body: unknown) => unknown,
): Promise<CallToolResult> {
  const res = await app.inject({
    method: req.method,
    url: withQuery(req.url, req.query),
    ...(req.payload !== undefined ? { payload: req.payload as object } : {}),
  });
  const raw = res.body;
  let parsed: unknown;
  let isJson = false;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
      isJson = true;
    } catch {
      // not JSON: fall through with the raw text
    }
  }

  if (res.statusCode >= 200 && res.statusCode < 300) {
    if (!raw || res.statusCode === 204) return textResult(JSON.stringify({ ok: true }, null, 2));
    return textResult(isJson ? JSON.stringify(redact ? redact(parsed) : parsed, null, 2) : raw);
  }

  const apiError =
    isJson && typeof parsed === "object" && parsed !== null && "error" in parsed
      ? (parsed as { error: unknown }).error
      : undefined;
  const message =
    typeof apiError === "string" ? apiError : raw || `request failed with status ${res.statusCode}`;
  return textResult(message, true);
}
