# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let AI agents (Claude Code, Cursor, …) drive Conductor through MCP with full parity with the HTTP API.

**Architecture:** A Streamable HTTP MCP endpoint `/mcp` mounted inside core's Fastify app (so it runs in `bun run dev:core` and in the Tauri sidecar alike), plus a `conductor mcp` CLI command that bridges stdio ↔ `/mcp` for stdio-only clients. Each MCP tool is a thin declarative wrapper that dispatches to the existing `/api/*` route through `app.inject()` — no handler is reimplemented, so Zod validation, the workspace 409 guard, audit entries and `[FILTERED]` secret masking all come for free.

**Tech Stack:** Bun, TypeScript 7, Fastify 5, zod 4, `@modelcontextprotocol/sdk` (latest), Commander 15, bun:test.

There is no separate spec: the **Design decisions** section below is the spec.

## Design decisions

1. **Dispatch via `app.inject()`.** A tool's handler builds `{ method, url, payload }` and calls `app.inject` on the same Fastify instance. 2xx → `CallToolResult` whose single text content is `JSON.stringify(body, null, 2)` (204/empty body → `{"ok":true}`). Non-2xx → `{ isError: true, content: [{ type: "text", text: body.error ?? rawBody }] }` — a tool error the agent can read (e.g. `no workspace open`), never a JSON-RPC protocol error.
2. **Security on `/mcp` (blocking requirement).** The server listens on `0.0.0.0` (`packages/core/bin/server.ts`) and full parity means arbitrary shell execution (`command_create` + `command_execute`). Before the transport sees anything, `/mcp` returns **403** `{ "error": "forbidden" }` unless ALL hold:
   - `request.socket.remoteAddress` ∈ {`127.0.0.1`, `::1`, `::ffff:127.0.0.1`};
   - the `Host` header's hostname (port stripped, IPv6 brackets handled) ∈ {`localhost`, `127.0.0.1`, `::1`};
   - the `Origin` header, **if present**, parses as `http:`/`https:` with hostname ∈ the same set.
     Every tool carries MCP annotations: `readOnlyHint: true` for reads; `destructiveHint: true` for delete / close / import / prune / stop / forget / clear; `destructiveHint: false` for other mutations.
     The pre-existing exposure of `/api/*` on `0.0.0.0` is out of scope (follow-up).
3. **Stateless transport.** `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`; a fresh `McpServer` + transport per POST (the SDK's stateless pattern), closed when the response closes. GET and DELETE on `/mcp` → 405 with a JSON-RPC error body. Prefer `enableJsonResponse: true` if it simplifies Bun/hijack handling.
4. **Port discovery.** The desktop sidecar gets a random port. After `listen`, core writes `~/.conductor/endpoint.json` = `{ url, pid, startedAt }` (path overridable with `CONDUCTOR_ENDPOINT_FILE`) and removes it on shutdown — only if the file's pid is its own. The bridge resolves the base URL as: `--url` → `CONDUCTOR_API_URL` → `endpoint.json` (only if its pid is alive) → `http://localhost:4000`.

## Global Constraints

- Tooling: TS 7 + oxlint. All of `bun run lint`, `bun run lint:types`, `bun run typecheck`, `bun run format:check`, `bun test` must pass before each commit. No ESLint, no TS 6, no new test frameworks.
- The behaviour of every existing `/api/*` route stays unchanged (the existing test suite must stay green untouched).
- Before every commit run the `run-desktop` check (Dave's standing rule): `bun run --cwd packages/core build:sidecar && bun run --cwd packages/ui build && node .claude/skills/run-desktop/smoke.mjs` must exit 0. This also proves the SDK survives `bun build --compile`.
- Commits: conventional style (`feat(core): …`, `feat(cli): …`, `docs: …`), each message ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `feat/mcp-server`; never push.
- MCP output never reveals more secret data than the HTTP API already does (`[FILTERED]`).
- Tool names are `snake_case`, exactly as listed in Task 2.

## Review Focus

1. A request to `/mcp` from a non-loopback address, or with a foreign `Host`/`Origin`, gets 403 before the MCP transport runs.
2. With no workspace open: `workspace_*` tools work; every other tool returns `isError` with `no workspace open` (no crash, no protocol error).
3. `env_list` never reveals a secret value.
4. The stdio bridge writes nothing to stdout except JSON-RPC messages.
5. A stale `endpoint.json` (dead pid) is ignored by the bridge; shutdown never deletes another instance's file.

---

### Task 1: SDK spike, `/mcp` mount, security guard, dispatch infrastructure

**Files:** Create `packages/core/src/mcp/server.ts`, `packages/core/src/mcp/tools.ts` · Modify `packages/core/src/api.ts` (one `await registerMcp(app)` call + `export` of the zod input schemas Task 2 will reuse), `packages/core/package.json` (dependency), `packages/core/src/index.ts` (export the mcp module) · Test `packages/core/test/mcp.test.ts`.

- [ ] `bun add @modelcontextprotocol/sdk` in `packages/core`. Read the **installed** package's README and `.d.ts` files (do not work from memory) to confirm: the `McpServer.registerTool` signature and how it takes zod schemas; that it works with **zod 4** (core uses `zod ^4.4.3` — if the SDK needs a specific import path such as `zod/v4` or a minimum SDK version, use it); `StreamableHTTPServerTransport` options (`sessionIdGenerator`, `enableJsonResponse`, any built-in DNS-rebinding options). Record what you found in the report.
- [ ] Mount `/mcp` in `buildApi` (call `registerMcp(app)` after all `/api` routes, before the static/SPA block so the not-found handler never swallows it). `/mcp` is not under `/api/`, so the workspace guard must not apply to it — verify.
- [ ] Implement the security check as an exported pure function `checkMcpRequest({ remoteAddress, host, origin }): string | null` plus the route wiring (Design decision 2).
- [ ] Bridge Fastify → SDK transport: `reply.hijack()` then `transport.handleRequest(request.raw, reply.raw, request.body)`. Note the Bun quirk documented in `api.ts` (onRequest hook comment): verify against a **real** listening server (`app.listen({ port: 0, host: "127.0.0.1" })`) with the SDK `Client` + `StreamableHTTPClientTransport`, not only `inject`.
- [ ] In `tools.ts` define the tool-definition type and dispatcher (Design decision 1):
  ```ts
  export interface McpToolDef {
    name: string;
    description: string; // written for an AI agent: what it does, when to use it
    input: z.ZodRawShape; // zod 4 raw shape; {} when no args
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
    request?: (args: any) => {
      method: "GET" | "POST" | "PUT" | "DELETE";
      url: string;
      query?: Record<string, string | number | boolean | undefined>;
      payload?: unknown;
    };
    run?: (args: any, ctx: { app: FastifyInstance }) => Promise<CallToolResult>; // non-route tools (process_wait)
  }
  export const TOOLS: McpToolDef[];
  export async function callRoute(app, req): Promise<CallToolResult>;
  ```
  Path params are `encodeURIComponent`-ed; `query` is serialised with `URLSearchParams`, skipping `undefined`.
- [ ] Ship only three tools in this task to prove the pipeline: `workspace_list` (GET `/api/workspaces`), `profile_list` (GET `/api/profiles`), `command_list` (GET `/api/command`). Task 2 adds the rest.
- [ ] Tests (`packages/core/test/mcp.test.ts`, harness pattern from `packages/core/test/workspace-manager.test.ts`):
  - `checkMcpRequest`: loopback v4/v6/mapped ok; `10.0.0.5` rejected; Host `evil.com` rejected; Host `localhost:4000` ok; Origin `http://evil.com` rejected; Origin `http://localhost:3000` ok; no Origin ok.
  - `app.inject({ method: "POST", url: "/mcp", remoteAddress: "10.0.0.5", … })` → 403.
  - Real listen + SDK client: `listTools` returns the three tools with their annotations; `callTool("profile_list")` returns the profiles JSON.
  - With a `WorkspaceManager` and no workspace open: `workspace_list` succeeds, `profile_list` returns `isError: true` with text containing `no workspace open`.
  - GET `/mcp` → 405.
- [ ] Run the full Global Constraints checks (incl. run-desktop smoke). Additionally, start the compiled sidecar (`packages/core/dist-bin/conductor-server`, `CONDUCTOR_PORT` set to a free port) and confirm an MCP `initialize` POST to `/mcp` succeeds; report the command and output.
- [ ] Commit: `feat(core): mount stateless MCP endpoint at /mcp with loopback guard`.

### Task 2: Full tool surface + `process_wait`

**Files:** Modify `packages/core/src/mcp/tools.ts`, `packages/core/src/api.ts` (only to `export` schemas if not already) · Test `packages/core/test/mcp-tools.test.ts`.

Read every route in `packages/core/src/api.ts` to get the exact params, query and body shapes; each tool's `input` mirrors them (reuse exported zod schemas — `CommandInputSchema`, `CommandPatchSchema`, `EnvVarInputSchema`, `EnvImportSchema`, `LogsQuerySchema`, `LogRunsQuerySchema`, `NotificationsQuerySchema`, `MetricsQuerySchema` — via `.shape`; where the API coerces strings to numbers, the tool takes real numbers).

- [ ] Implement exactly these tools (route in brackets; R = readOnly, D = destructive, M = non-destructive mutation):
  - Workspace: `workspace_list` [GET /api/workspaces] R · `workspace_open` [POST /api/workspaces/open] M · `workspace_close` [POST /api/workspaces/close] D · `workspace_forget` [DELETE /api/workspaces?path=] D
  - Profiles: `profile_list` [GET /api/profiles] R · `profile_create` [POST /api/profiles] M · `profile_update` [PUT /api/profiles/:profile] M · `profile_delete` [DELETE /api/profiles/:profile] D · `profile_duplicate` [POST /api/profiles/:profile/duplicate] M · `profile_export` [GET /api/profiles/:profile/export] R
  - Commands: `command_list` [GET /api/command] R · `command_create` [POST /api/command] M · `command_update` [PUT /api/command/:id] M · `command_delete` [DELETE /api/command/:id] D
  - Profile↔command links: `profile_command_add` [POST /api/profiles/:profile/commands] M · `profile_command_update` [PUT /api/profiles/:profile/commands/:id] M · `profile_command_sync` [POST /api/profiles/:profile/commands/sync] M · `profile_command_remove` [DELETE /api/profiles/:profile/commands/:id] D · `profile_command_duplicate` [POST …/:id/duplicate] M · `profile_command_move` [POST …/:id/move] M
  - Execution: `profile_run` [POST /api/profiles/:profile/run] M · `profile_stop` [POST /api/profiles/:profile/stop] D · `command_execute` [POST /api/commands/:id/execute] M · `command_restart` [POST /api/commands/:id/restart] M · `process_list` [GET /api/processes] R · `process_stop` [DELETE /api/processes/:pid] D · `process_metrics` [GET /api/processes/:pid/metrics] R · `process_wait` (custom, below) R
  - Notifications: `notification_list` [GET /api/notifications] R · `notification_clear` [DELETE /api/notifications] D
  - Env: `env_list` [GET /api/env] R · `env_set` [PUT /api/env] M · `env_delete` [DELETE /api/env/:id] D · `env_import` [POST /api/env/import] M
  - Logs: `log_query` [GET /api/logs] R · `log_runs` [GET /api/logs/runs] R · `log_prune` [POST /api/logs/prune] D
  - Config: `config_export` [GET /api/config/export] R · `config_import` [POST /api/config/import] D · `configure` [POST /api/configure] M · `base_path_get` [GET /api/base-path] R · `base_path_set` [PUT /api/base-path] M · `shell_get` [GET /api/shells] R · `shell_set` [PUT /api/shells] M · `log_retention_get` [GET /api/log-retention] R · `log_retention_set` [PUT /api/log-retention] M · `docker_compose_parse` [POST /api/docker-compose/parse] R
  - Not exposed: `/api/health`, the legacy `/api/docker compose/parse` alias, `/api/logs/stream` (SSE).
- [ ] `process_wait`: input `{ commandId?: string; pid?: number; until: "running" | "healthy" | "stopped" | "exited"; timeout_ms?: number (default 30000, max 120000) }`; exactly one of `commandId`/`pid` required (else `isError`). Polls `GET /api/processes` via inject every 500 ms. Matching: by `pid`, or the newest snapshot (by `startedAt`) whose `commandId` matches. Success when: `running` → status `running`; `healthy` → health `healthy`; `stopped` → status `stopped`; `exited` → status `stopped` or `failed`. Returns `isError` immediately if status becomes `failed` (unless `until` is `exited`), and `isError` with the last snapshot on timeout. Success returns the snapshot JSON.
- [ ] Descriptions are written for an AI agent: one or two sentences on what it does and when to use it; mention side effects (e.g. `command_delete` also unlinks it from every profile; `workspace_open` stops the current workspace's processes).
- [ ] Tests (`packages/core/test/mcp-tools.test.ts`, real listen + SDK client):
  - `listTools` returns exactly the names above (sorted compare) and spot-check annotations (`env_list` R, `command_delete` D, `command_create` M).
  - `command_create` then `command_list` contains it; an `audit_log` entry was written.
  - `env_set` with `secret: true` then `env_list` → value is `[FILTERED]`.
  - `workspace_open` on a temp folder → `profile_list` succeeds afterwards.
  - Invalid input that the route rejects (e.g. `command_create` with empty `run`) → `isError` with the route's 400 message.
  - `process_wait`: a command with `run: "sleep 2"` (healthcheck none) executed via `command_execute` → `until: "running"` succeeds; `until: "exited"` with `timeout_ms: 5000` succeeds; `until: "healthy"` on a `sleep 30` command with a failing healthcheck and `timeout_ms: 1000` → `isError` timeout. Stop processes in `afterEach`. Skip shell-dependent cases on Windows the way `queue.test.ts` does, if it does.
- [ ] Global Constraints checks (incl. run-desktop smoke), then commit: `feat(core): expose the full API as MCP tools`.

### Task 3: Endpoint discovery file + `conductor mcp` stdio bridge

**Files:** Create `packages/core/src/mcp/endpoint-file.ts`, `packages/cli/src/commands/mcp.ts` · Modify `packages/core/bin/server.ts`, `packages/core/src/index.ts`, `packages/cli/bin/conductor.ts`, `packages/cli/package.json` · Test `packages/core/test/mcp-endpoint-file.test.ts`, `packages/cli/test/mcp-bridge.test.ts`.

- [ ] `endpoint-file.ts` (Design decision 4): `endpointFilePath()` (= `process.env.CONDUCTOR_ENDPOINT_FILE ?? join(homedir(), ".conductor", "endpoint.json")`), `writeEndpointFile(url)` (creates the dir; writes `{ url, pid: process.pid, startedAt }`), `readEndpointFile(): { url, pid, startedAt } | null` (null when missing, corrupt, or the pid is not alive — `process.kill(pid, 0)`; `EPERM` counts as alive), `removeEndpointFile()` (removes only if the file's pid === `process.pid`).
- [ ] `bin/server.ts`: after `listen`, `writeEndpointFile(\`http://127.0.0.1:${PORT}\`)`; in the SIGTERM/SIGINT shutdown path, `removeEndpointFile()`. A write failure logs a warning and never stops the server.
- [ ] `conductor mcp [--url <url>]`: resolve the base URL (Design decision 4). Probe `${base}/api/health` with a 2 s timeout; if unreachable, print to **stderr** `Conductor core is not reachable at <base>. Start it with \`bun run dev:core\` or open the desktop app.`and exit 1. Otherwise pipe`StdioServerTransport`↔`StreamableHTTPClientTransport(new URL("/mcp", base))`: messages from one are sent to the other; when either closes, close the other and exit 0; transport errors go to stderr. Nothing but JSON-RPC may reach stdout.
- [ ] Tests:
  - endpoint file: write → read roundtrip; dead pid (e.g. spawn and await a short-lived process, use its pid) → null; corrupt JSON → null; `removeEndpointFile` leaves a file holding a different pid. Use `CONDUCTOR_ENDPOINT_FILE` in a temp dir.
  - bridge: start a test core (`buildApi` + listen on port 0), then SDK `Client` + `StdioClientTransport({ command: process.execPath, args: ["packages/cli/bin/conductor.ts", "mcp", "--url", base] })` (resolve paths robustly) → `listTools` includes `profile_list`, `callTool("profile_list")` works. Unreachable URL → exit code 1, empty stdout, stderr contains `not reachable`.
- [ ] Global Constraints checks (incl. run-desktop smoke), then commit: `feat(cli): add conductor mcp stdio bridge with endpoint discovery`.

### Task 4: Documentation

**Files:** Modify `docs/API.md`, `docs/CLI.md`, `docs/ARCHITECTURE.md`, `README.md`.

- [ ] `docs/API.md`: new "MCP endpoint" section — `/mcp` (Streamable HTTP, stateless), the loopback/Host/Origin 403 rules, tool naming and the full tool → route table from Task 2 (with R/D/M annotation column), `process_wait` semantics, the not-exposed routes, `isError` semantics (e.g. `no workspace open`).
- [ ] `docs/CLI.md`: `conductor mcp [--url]` with the URL resolution order and `endpoint.json` (path, `CONDUCTOR_ENDPOINT_FILE`). Update the "Workspaces" paragraph: the desktop sidecar is now discoverable via `endpoint.json`.
- [ ] `docs/ARCHITECTURE.md`: add `mcp/` (server.ts, tools.ts, endpoint-file.ts) to the repository layout and a short "MCP" subsection (inject dispatch, security, stateless).
- [ ] `README.md`: an "Use with AI agents (MCP)" section with:
  ```bash
  claude mcp add --transport http conductor http://localhost:4000/mcp
  ```
  ```bash
  claude mcp add conductor -- conductor mcp
  ```
  and one line on the desktop app (use the stdio form; it finds the random port via `endpoint.json`).
- [ ] `bun run format:check` passes; run-desktop smoke; commit: `docs: document the MCP endpoint and conductor mcp`.
