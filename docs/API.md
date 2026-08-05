# HTTP API Reference

The Conductor HTTP API runs on port **4000** (configurable via `PORT` env var when started with `bun run server`). It provides endpoints for configuration management, process control, env var maintenance, and log streaming. All mutating operations write to SQLite and record an audit log entry. CORS is scoped to localhost any port by default.

## Base URL / Port

Default: `http://localhost:4000`

## Request Headers

- No auth tokens are implemented yet — the API assumes a local-only trust model (CORS restricted to localhost).
- All JSON bodies use content-type `application/json`.
- The API server is built on Fastify 5.

## Endpoints by Group

### System Health

| Method | Path | Description | Returns |
|---|---|---|---|
| GET | `/api/health` | Pong check for server liveness | `{ status: "ok" }` |

### Profiles (CRUD)

| Method | Path | Body | Description | Returns |
|---|---|---|---|---|
| GET | `/api/profiles` | — | Lists all profiles + root commands | `{ profiles, commands }` |
| POST | `/api/profiles` | `{ name, description? }` | Create a new profile | Profile object |
| PUT | `/api/profiles/:profile` | `{ newName?, description? }` | Update profile metadata | Updated profile |
| DELETE | `/api/profiles/:profile` | — | Delete the profile and remove all command links | `204 No Content` |
| POST | `/api/profiles/:profile/duplicate` | `{ newName }` | Deep-clone a profile (env + command_ids) | New profile object |
| GET | `/api/profiles/:profile/export` | — | Serialise entire profile for sharing/importing | Profile config YAML block as string |

### Commands (root level)

All commands are root-level definitions stored in the config store. They are referenced by ID from profiles (`command_ids`), not embedded there.

| Method | Path | Body | Description | Returns |
|---|---|---|---|---|
| GET | `/api/command` | — | List all root commands | Array of CommandSchema objects |
| POST | `/api/command` | Full CommandSchema | Create a new root command | Created command object |
| PUT | `/api/command/:id` | Partial CommandSchema | Update fields on an existing root command (e.g., update the run target, add healthcheck, modify deps) | Updated command |
| DELETE | `/api/command/:id` | — | Remove a root command by ID (also removes it from **all** profiles that reference it) | `204 No Content` |

### Profile–Command Linking

These endpoints manage the relationship between root commands and profiles. A command can belong to multiple profiles; links are bidirectional in the store.

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/profiles/:profile/commands` | `{ id?, ...commandFields }` | Create a root command **and** link it to this profile (if no `id` is given, a new one is generated). Command data comes from form input or API payload. |
| PUT | `/api/profiles/:profile/commands/:id` | Partial CommandSchema | Update the linked command within this profile's scope (e.g., change its run target without affecting other profiles) |
| POST | `/api/profiles/:profile/commands/sync` | `{ add?: string[], remove?: string[] }` | Bulk add/remove command links from a profile. If `add` contains IDs of commands that don't exist as root-level yet, they are auto-created. |
| DELETE | `/api/profiles/:profile/commands/:id` | — | Remove only the link (keeps root command alive if referenced by other profiles) |
| POST | `/api/profiles/:profile/commands/:id/duplicate` | `{ targetProfile }` | Duplicate a command within another profile's context. Creates a standalone copy in `targetProfile`. Useful for customisation of inherited templates without side-effects. |
| POST | `/api/profiles/:profile/commands/:id/move` | `{ targetProfile }` | Move a root command from this profile to `targetProfile`; the original link is removed but root-level command persists if other profiles still reference it. |

### Processes (running commands)

The process manager (SpawnQueue) tracks active processes and their snapshots. All endpoints hit `/api/processes`.

| Method | Path | Body/Query | Description |
|---|---|---|---|
| GET | `/api/processes` | — | `queue.listSnapshots()` — returns status of all commands in profile (running, healthy, stopped, failed) |
| DELETE | `/api/processes/:pid` | — | `queue.stopByPid(pid)` — force-stop a specific process; returns snapshot post-status |
| GET | `/api/processes/:pid/metrics` | `?from&to` ISO strings or epoch ms | Time-series metrics (CPU %, memory in bytes). **Currently stubbed** — monitor directory is empty. Returns `{ cpu: [], memory: [] }` |
| POST | `/api/profiles/:profile/run` | — | Start a profile's commands via HTTP API (same as `conductor run`) |
| POST | `/api/profiles/:profile/stop` | — | Stop all commands in a profile |

Command execution/restart endpoints:

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/command/:id/execute` | `{ profile?: string }` | Execute command by ID, optionally within a specific profile context (auto-compiles example templates if needed) |
| POST | `/api/command/:id/restart` | `{ profile?: string }` | Restart a command (stops previous instance, relaunches) |

### Notifications

Events emitted during process lifecycle (spawned, healthy, stopped, failed).

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/api/notifications` | `?limit&offset` | Returns newest notification events (bounded by limit); offset for pagination; most recent is last in the array |

### Environment Variables

All env vars are stored in SQLite's `env_vars` table. The API supports per-scope management and import/export.

| Method | Path | Body/Query | Description |
|---|---|---|---|
| GET | `/api/env` | `?scope=global\|profile&profile=&key=` | Query env vars with optional scoping; returns an array of env objects `{ id, scope, profile, key, value, secret }`. When a var name matches `env_secrets`, the value field is `[FILTERED]` in API responses. |
| PUT | `/api/env` | `{ scope: "global"\|"profile", profile?, key, value, secret? }` | Upsert an env var. For `profile` scope, writes to `.env.<profile>.local`; for all scopes, the CLI also writes the corresponding local file. |
| DELETE | `/api/env/:id` | — | Delete a single env var entry by ID |
| POST | `/api/env/import` | `{ scope, profile?, text, secret? }` | Batch-import vars from dotenv-formatted text (`.env` format). Auto-detects `looksSecret` on variable names during bulk processing. Parses `.env`-style syntax with single/double/quoting support and inline comments. |

### Logs

Log querying returns the latest entries in reverse chronological order, capped at 500 lines per PID. The SSE stream replays those last 500 lines first (so the UI doesn't start empty), then tails new lines in real-time with 15-second heartbeats for connection health checking.

| Method | Path | Query Params | Description |
|---|---|---|---|
| GET | `/api/logs` | `?pid&commandId&profile&limit` | Returns `{ logs: [...reversed...] }` — query filtered by PID, command ID, or profile name; limit defaults to 500. Use the browser's EventSource API for real-time updates. |
| GET | `/api/logs/stream/:pid` | SSE (Server-Sent Events) | `EventSource("http://localhost:4000/api/logs/stream/{pid}")` replays up to last-500 lines immediately, then tails live log lines as they arrive via the broadcaster. Heartbeat pings every 15 seconds keep the connection alive through proxies/load balancers. |

### Configuration Management

Config and schema-level operations include import/export of `.conductor.yml` files and Docker Compose parsing for auto-suggestion.

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/configure` | `{ profile?: string, force?: boolean }` | Auto-generate config from `.example` templates (`.env`, `appsettings.json`). If `profile` is provided, populate vars for that specific profile scope. If `force` is true, overwrite existing files without prompting. |
| POST | `/api/config/import` | `{ yaml }` | Import a full Conductor YAML config blob — merges with current store, writes `.conductor.yml`; useful for migrating from another Conductor instance or sharing templates via paste/API. |
| GET | `/api/config/export` | — | Serialise current config to YAML string ready for export/sharing (`export` endpoint) |
| GET | `/api/base-path` | — | Current base path for config resolution |
| PUT | `/api/base-path` | `{ value: string }` | Change `base_path` at runtime (no reload) |
| GET | `/api/shells` | — | Return available shell info (POSIX `$SHELL` or Windows `%COMSPEC%`) |
| PUT | `/api/shells` | `{ default: string }` | Override the system shell for spawned subprocesses |
| POST | `/api/docker compose/parse` | `{ yaml }` | Parse docker-compose YAML → suggest matching `commands[]` array (one command per service, with healthchecks auto-generated as `port` or `http` based on exposed port ranges) |

## WebSocket Note

Conductor's documentation mentions a WebSocket feature for real-time updates. The actual implementation today uses Server-Sent Events (SSE) via `/api/logs/stream/:pid`. There is no WebSocket endpoint currently implemented — the SSE approach replaces it and is built into Fastify without extra dependencies. In future versions, we expect the API to add optional WSS support with automatic fallback from HTTP to WSS.

## SPA / Static Assets Serving

In Electron's desktop shell mode, if `CONDUCTOR_UI_DIST` env variable is set, Conductor serves static assets from that directory with a fallback-to-index.html strategy (SPA routing). This achieves same-origin API/HTML serving for distributable builds. The UI is built by running the Vite build step (`bun run --cwd packages/ui build`) and then setting the environment variable to point at the output directory.

### Example SPA Flow:
1. `bun run --cwd packages/ui build` → outputs to `packages/ui/dist/`
2. Start core server: `CONDUCTOR_UI_DIST=./packages/ui/dist bun run server.ts` (from `packages/core`) — serves UI on same port as API at root `/`.

## CORS Behaviour

- Enabled for localhost on any port via `cors({ origin: /localhost/ })`: so the dev-mode React dashboard at `http://localhost:3000` can make cross-origin AJAX/fetch requests against the API server running on `4000`.
- No authentication or token mechanisms are implemented; trust model is that Conductor only binds to localhost by default. When used in Electron, the port and CORS restrictions are irrelevant as everything runs on the same origin.

## Audit Log

Every mutating operation (command creation/update/deletion, profile changes, env var changes) writes an audit entry to SQLite's `audit_log` table. Fields include: timestamp, action (`create`, `update`, `delete`), actor (profile name or "anonymous"), and details (the changed field names). Audit entries are not exposed via the HTTP API at this time but are queryable through ConductorQueries directly.
