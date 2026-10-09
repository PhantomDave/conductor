# HTTP API Reference

The Conductor HTTP API runs on port **4000** (configurable via `CONDUCTOR_PORT` env var when started with `bun run server`). It provides endpoints for configuration management, process control, env var maintenance, and log streaming. All mutating operations write to SQLite and record an audit log entry. CORS is scoped to localhost any port by default.

## Base URL / Port

Default: `http://localhost:4000`

## Request Headers

- No auth tokens are implemented yet — the API assumes a local-only trust model (CORS restricted to localhost).
- All JSON bodies use content-type `application/json`.
- The API server is built on Fastify 5.

## Endpoints by Group

### System Health

| Method | Path          | Description                    | Returns            |
| ------ | ------------- | ------------------------------ | ------------------ |
| GET    | `/api/health` | Pong check for server liveness | `{ status: "ok" }` |

### Workspaces

A workspace is one folder with its own `<folder>/.conductor.yml`; the sidecar has at most one open at a time (see [ARCHITECTURE.md](./ARCHITECTURE.md#workspaces-session--manager)). While none is open, or while a switch is running, every other `/api/*` route except `/api/health` returns **409** `{ error: "no workspace open" }` or `{ error: "workspace switch in progress" }`.

| Method | Path                    | Body / Query | Description                                                                                                                                                                                                                                                                                                                                                                                                                    | Returns                                                                              |
| ------ | ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| GET    | `/api/workspaces`       | —            | The open workspace and the recent list (newest first, max 20, stored in `<CONDUCTOR_DATA_DIR>/workspaces.json`). `missing` is true when the folder no longer exists.                                                                                                                                                                                                                                                           | `{ current: { path, name } \| null, recent: [{ path, name, lastOpened, missing }] }` |
| POST   | `/api/workspaces/open`  | `{ path }`   | Validates (or creates) `<path>/.conductor.yml`, stops the current workspace's processes, then opens it. `~` and a path to the `.conductor.yml` itself are accepted; re-opening the current workspace is a no-op. 400 on a missing folder or invalid config: a config error leaves the current workspace running, but a failure after the old workspace closed leaves no workspace open (`current: null`). 409 while switching. | `{ path, name }`                                                                     |
| POST   | `/api/workspaces/close` | —            | Stops every process and closes the current workspace. 409 while switching.                                                                                                                                                                                                                                                                                                                                                     | `{}`                                                                                 |
| DELETE | `/api/workspaces`       | `?path=`     | Removes the entry from the recent list only — never touches files.                                                                                                                                                                                                                                                                                                                                                             | `{}`                                                                                 |

### Profiles (CRUD)

| Method | Path                               | Body                         | Description                                     | Returns                             |
| ------ | ---------------------------------- | ---------------------------- | ----------------------------------------------- | ----------------------------------- |
| GET    | `/api/profiles`                    | —                            | Lists all profiles + root commands              | `{ profiles, commands }`            |
| POST   | `/api/profiles`                    | `{ name, description? }`     | Create a new profile                            | Profile object                      |
| PUT    | `/api/profiles/:profile`           | `{ newName?, description? }` | Update profile metadata                         | Updated profile                     |
| DELETE | `/api/profiles/:profile`           | —                            | Delete the profile and remove all command links | `204 No Content`                    |
| POST   | `/api/profiles/:profile/duplicate` | `{ newName }`                | Deep-clone a profile (env + command_ids)        | New profile object                  |
| GET    | `/api/profiles/:profile/export`    | —                            | Serialise entire profile for sharing/importing  | Profile config YAML block as string |

### Commands (root level)

All commands are root-level definitions stored in the config store. They are referenced by ID from profiles (`command_ids`), not embedded there.

| Method | Path               | Body                  | Description                                                                                           | Returns                        |
| ------ | ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------ |
| GET    | `/api/command`     | —                     | List all root commands                                                                                | Array of CommandSchema objects |
| POST   | `/api/command`     | Full CommandSchema    | Create a new root command                                                                             | Created command object         |
| PUT    | `/api/command/:id` | Partial CommandSchema | Update fields on an existing root command (e.g., update the run target, add healthcheck, modify deps) | Updated command                |
| DELETE | `/api/command/:id` | —                     | Remove a root command by ID (also removes it from **all** profiles that reference it)                 | `204 No Content`               |

### Profile–Command Linking

These endpoints manage the relationship between root commands and profiles. A command can belong to multiple profiles; links are bidirectional in the store.

| Method | Path                                            | Body                                    | Description                                                                                                                                                               |
| ------ | ----------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/profiles/:profile/commands`               | `{ id?, ...commandFields }`             | Create a root command **and** link it to this profile (if no `id` is given, a new one is generated). Command data comes from form input or API payload.                   |
| PUT    | `/api/profiles/:profile/commands/:id`           | Partial CommandSchema                   | Update the linked command within this profile's scope (e.g., change its run target without affecting other profiles)                                                      |
| POST   | `/api/profiles/:profile/commands/sync`          | `{ add?: string[], remove?: string[] }` | Bulk add/remove command links from a profile. If `add` contains IDs of commands that don't exist as root-level yet, they are auto-created.                                |
| DELETE | `/api/profiles/:profile/commands/:id`           | —                                       | Remove only the link (keeps root command alive if referenced by other profiles)                                                                                           |
| POST   | `/api/profiles/:profile/commands/:id/duplicate` | `{ targetProfile }`                     | Duplicate a command within another profile's context. Creates a standalone copy in `targetProfile`. Useful for customisation of inherited templates without side-effects. |
| POST   | `/api/profiles/:profile/commands/:id/move`      | `{ targetProfile }`                     | Move a root command from this profile to `targetProfile`; the original link is removed but root-level command persists if other profiles still reference it.              |

### Processes (running commands)

The process manager (SpawnQueue) tracks active processes and their snapshots. All endpoints hit `/api/processes`.

| Method | Path                          | Body/Query                         | Description                                                                                                                                                             |
| ------ | ----------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/processes`              | —                                  | `queue.listSnapshots()` — returns status of all commands in profile (`status`: `starting\|running\|stopping\|stopped\|failed`; `health`: `unknown\|healthy\|unhealthy`) |
| DELETE | `/api/processes/:pid`         | —                                  | `queue.stopByPid(pid)` — force-stop a specific process; returns `{ stopped: true, pid }` or 404                                                                         |
| GET    | `/api/processes/:pid/metrics` | `?from&to` ISO strings or epoch ms | Time-series metrics (CPU %, memory in bytes). Sampled every 5s by `MetricCollector`; returns real `{ cpu: [...], memory: [...] }` history. No UI chart consumes it yet. |
| POST   | `/api/profiles/:profile/run`  | —                                  | Start a profile's commands via HTTP API (same as `conductor run`)                                                                                                       |
| POST   | `/api/profiles/:profile/stop` | —                                  | Stop all commands in a profile                                                                                                                                          |

Command execution/restart endpoints:

| Method | Path                        | Body                   | Description                                                                                                     |
| ------ | --------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/commands/:id/execute` | `{ profile?: string }` | Execute command by ID, optionally within a specific profile context (auto-compiles example templates if needed) |
| POST   | `/api/commands/:id/restart` | `{ profile?: string }` | Restart a command (stops previous instance, relaunches)                                                         |

### Notifications

Events emitted during process lifecycle (spawned, healthy, stopped, failed).

| Method | Path                 | Query           | Description                                                                                                    |
| ------ | -------------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/notifications` | `?limit&offset` | Returns newest notification events (bounded by limit); offset for pagination; most recent is last in the array |

### Environment Variables

All env vars are stored in SQLite's `env_vars` table. The API supports per-scope management and import/export.

| Method | Path              | Body/Query                                                      | Description                                                                                                                                                                                                                                                                                          |
| ------ | ----------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/env`        | `?scope=global\|profile&profile=&key=`                          | Query env vars with optional scoping; returns `{ vars: [...] }`, each `{ id, scope, profile, key, value, is_secret }`. Values are returned as stored, secrets included; masking is done by the UI only. The MCP tools `env_list`, `env_set` and `env_import` do mask them (see [Secrets](#secrets)). |
| PUT    | `/api/env`        | `{ scope: "global"\|"profile", profile?, key, value, secret? }` | Upsert an env var; returns `{ var }` (the stored row). For `profile` scope, writes to `.env.<profile>.local`; for all scopes, the CLI also writes the corresponding local file.                                                                                                                      |
| DELETE | `/api/env/:id`    | —                                                               | Delete a single env var entry by ID                                                                                                                                                                                                                                                                  |
| POST   | `/api/env/import` | `{ scope, profile?, text, secret? }`                            | Batch-import vars (returns `{ imported, vars }`: the count and the stored rows) from dotenv-formatted text (`.env` format). Auto-detects `looksSecret` on variable names during bulk processing. Parses `.env`-style syntax with single/double/quoting support and inline comments.                  |

### Logs

Log querying returns the latest entries in reverse chronological order, capped at 500 lines per PID. The SSE stream replays those last 500 lines first (so the UI doesn't start empty), then tails new lines in real-time with 15-second heartbeats for connection health checking.

| Method | Path               | Query Params                              | Description                                                                                                                                                                                                                              |
| ------ | ------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/logs`        | `?pid&commandId&profile&level&grep&limit` | Returns `{ logs: [...] }` filtered by PID, command ID, profile, level, and/or grep substring; invalid numeric params return 400.                                                                                                         |
| GET    | `/api/logs/runs`   | `?commandId&profile&limit`                | Returns `{ runs: [...] }`, one per past run (distinct pid), newest first, with `started_at`, `last_at`, `lines`, `stderr_lines`.                                                                                                         |
| GET    | `/api/logs/stream` | SSE (Server-Sent Events)                  | `EventSource("http://localhost:4000/api/logs/stream?pid=123")` replays recent history first (default 500, configurable via `limit`) and then tails live log events; supports `pid`, `commandId`, `profile`, `level`, and `grep` filters. |

### Configuration Management

Config and schema-level operations include import/export of `.conductor.yml` files and Docker Compose parsing for auto-suggestion.

| Method | Path                        | Body                                                             | Description                                                                                                                                                                                                           |
| ------ | --------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/configure`            | `{ profile?: string, force?: boolean }`                          | Auto-generate config from `.example` templates (`.env`, `appsettings.json`). If `profile` is provided, populate vars for that specific profile scope. If `force` is true, overwrite existing files without prompting. |
| POST   | `/api/config/import`        | `{ yaml }`                                                       | Import a full Conductor YAML config blob — merges with current store, writes `.conductor.yml`; useful for migrating from another Conductor instance or sharing templates via paste/API.                               |
| GET    | `/api/config/export`        | —                                                                | Serialise current config to YAML string ready for export/sharing (`export` endpoint)                                                                                                                                  |
| GET    | `/api/base-path`            | —                                                                | Current base path for config resolution                                                                                                                                                                               |
| PUT    | `/api/base-path`            | `{ value: string }`                                              | Change `base_path` at runtime (no reload)                                                                                                                                                                             |
| GET    | `/api/shells`               | —                                                                | Return available shell info (POSIX `$SHELL` or Windows `%COMSPEC%`)                                                                                                                                                   |
| PUT    | `/api/shells`               | `{ default: string }`                                            | Override the system shell for spawned subprocesses                                                                                                                                                                    |
| GET    | `/api/log-retention`        | —                                                                | Current `log_retention_days` / `log_retention_sessions`                                                                                                                                                               |
| PUT    | `/api/log-retention`        | `{ log_retention_days: number, log_retention_sessions: number }` | Update log retention; swept hourly (days) and on each profile run (sessions) — see [CONFIG.md](./CONFIG.md)                                                                                                           |
| POST   | `/api/docker-compose/parse` | `{ yaml }`                                                       | Parse docker-compose YAML → suggest matching `commands[]` array (one command per service, with healthchecks auto-generated as `port` or `http` based on exposed port ranges)                                          |
| POST   | `/api/docker compose/parse` | `{ yaml }`                                                       | Legacy alias for backward compatibility (use `/api/docker-compose/parse` for new clients)                                                                                                                             |

## WebSocket Note

Conductor's documentation mentions a WebSocket feature for real-time updates. The actual implementation today uses Server-Sent Events (SSE) via `/api/logs/stream`. There is no WebSocket endpoint currently implemented — the SSE approach replaces it and is built into Fastify without extra dependencies. In future versions, we expect the API to add optional WSS support with automatic fallback from HTTP to WSS.

## SPA / Static Assets Serving

In the desktop shell (Tauri; the Rust host sets `CONDUCTOR_UI_DIST` on the sidecar it spawns), Conductor serves static assets from that directory with a fallback-to-index.html strategy (SPA routing). This achieves same-origin API/HTML serving for distributable builds. The UI is built by running the Vite build step (`bun run --cwd packages/ui build`) and then setting the environment variable to point at the output directory.

### Example SPA Flow:

1. `bun run --cwd packages/ui build` → outputs to `packages/ui/dist/`
2. Start core server: `CONDUCTOR_UI_DIST=./packages/ui/dist bun run server.ts` (from `packages/core`) — serves UI on same port as API at root `/`.

## CORS Behaviour

- Enabled for localhost on any port via `cors({ origin: /localhost/ })`: so the dev-mode React dashboard at `http://localhost:3000` can make cross-origin AJAX/fetch requests against the API server running on `4000`.
- No authentication or token mechanisms are implemented; trust model is that Conductor only binds to localhost by default. When used inside the Tauri desktop shell, the port and CORS restrictions are irrelevant as everything runs on the same origin.

## MCP Endpoint

The core also serves a [Model Context Protocol](https://modelcontextprotocol.io) server at `/mcp` (Streamable HTTP, JSON responses, stateless). Each POST is self-contained: no `Mcp-Session-Id` is issued and no state is kept between requests. Agents normally reach it through the `conductor mcp` stdio bridge (see [CLI.md](./CLI.md#conductor-mcp)); an HTTP client can post to `http://localhost:4000/mcp` directly.

### Access rules

The server listens on all interfaces and the tools can run shell commands, so `/mcp` checks each request before the MCP layer sees it. It answers **403** `{ "error": "forbidden" }` unless all of these hold:

- the TCP peer is loopback: `127.0.0.1`, `::1` or `::ffff:127.0.0.1`;
- the `Host` header's hostname (port ignored) is `localhost`, `127.0.0.1` or `::1`, which blocks DNS rebinding;
- if an `Origin` header is sent, it parses as `http:` or `https:` with one of the same hostnames, which blocks cross-site browser requests.

`GET` and `DELETE` on `/mcp` return **405** with a JSON-RPC error. Only `POST` carries messages.

### Tools

Each tool is a thin mapping onto one of the routes below. The request is dispatched in-process through Fastify's `inject()`, so validation, the workspace guard and the audit log behave exactly as they do over HTTP. Tool names are `snake_case` as `<area>_<action>`.

The last column is the MCP annotation: **R** is read-only (`readOnlyHint`), **D** is destructive (`destructiveHint`: deletes, stops, closes and prunes, plus `config_import`, which overwrites the config), and **M** is any other mutation.

| Tool                        | Method + route                                       | R/D/M |
| --------------------------- | ---------------------------------------------------- | ----- |
| `workspace_list`            | GET `/api/workspaces`                                | R     |
| `workspace_open`            | POST `/api/workspaces/open`                          | M     |
| `workspace_close`           | POST `/api/workspaces/close`                         | D     |
| `workspace_forget`          | DELETE `/api/workspaces?path=`                       | D     |
| `profile_list`              | GET `/api/profiles`                                  | R     |
| `profile_create`            | POST `/api/profiles`                                 | M     |
| `profile_update`            | PUT `/api/profiles/:profile`                         | M     |
| `profile_delete`            | DELETE `/api/profiles/:profile`                      | D     |
| `profile_duplicate`         | POST `/api/profiles/:profile/duplicate`              | M     |
| `profile_export`            | GET `/api/profiles/:profile/export`                  | R     |
| `command_list`              | GET `/api/command`                                   | R     |
| `command_create`            | POST `/api/command`                                  | M     |
| `command_update`            | PUT `/api/command/:id`                               | M     |
| `command_delete`            | DELETE `/api/command/:id`                            | D     |
| `profile_command_add`       | POST `/api/profiles/:profile/commands`               | M     |
| `profile_command_update`    | PUT `/api/profiles/:profile/commands/:id`            | M     |
| `profile_command_sync`      | POST `/api/profiles/:profile/commands/sync`          | M     |
| `profile_command_remove`    | DELETE `/api/profiles/:profile/commands/:id`         | D     |
| `profile_command_duplicate` | POST `/api/profiles/:profile/commands/:id/duplicate` | M     |
| `profile_command_move`      | POST `/api/profiles/:profile/commands/:id/move`      | M     |
| `profile_run`               | POST `/api/profiles/:profile/run`                    | M     |
| `profile_stop`              | POST `/api/profiles/:profile/stop`                   | D     |
| `command_execute`           | POST `/api/commands/:id/execute`                     | M     |
| `command_restart`           | POST `/api/commands/:id/restart`                     | M     |
| `process_list`              | GET `/api/processes`                                 | R     |
| `process_stop`              | DELETE `/api/processes/:pid`                         | D     |
| `process_metrics`           | GET `/api/processes/:pid/metrics`                    | R     |
| `process_wait`              | polls GET `/api/processes` (see below)               | R     |
| `notification_list`         | GET `/api/notifications`                             | R     |
| `notification_clear`        | DELETE `/api/notifications`                          | D     |
| `env_list`                  | GET `/api/env`                                       | R     |
| `env_set`                   | PUT `/api/env`                                       | M     |
| `env_delete`                | DELETE `/api/env/:id`                                | D     |
| `env_import`                | POST `/api/env/import`                               | M     |
| `log_query`                 | GET `/api/logs`                                      | R     |
| `log_runs`                  | GET `/api/logs/runs`                                 | R     |
| `log_prune`                 | POST `/api/logs/prune`                               | D     |
| `config_export`             | GET `/api/config/export`                             | R     |
| `config_import`             | POST `/api/config/import`                            | D     |
| `configure`                 | POST `/api/configure`                                | M     |
| `base_path_get`             | GET `/api/base-path`                                 | R     |
| `base_path_set`             | PUT `/api/base-path`                                 | M     |
| `shell_get`                 | GET `/api/shells`                                    | R     |
| `shell_set`                 | PUT `/api/shells`                                    | M     |
| `log_retention_get`         | GET `/api/log-retention`                             | R     |
| `log_retention_set`         | PUT `/api/log-retention`                             | M     |
| `docker_compose_parse`      | POST `/api/docker-compose/parse`                     | R     |

Not exposed: `/api/health` (the bridge probes it itself), `/api/logs/stream` (SSE; use `log_query` or `process_wait`), and the legacy `/api/docker compose/parse` alias (use `docker_compose_parse`).

### Results and errors

- **Success** returns one text content item holding the response body as indented JSON. An empty body or a 204 returns `{"ok":true}`.
- **Failure** returns `isError: true` with the API's `error` message as text. For example, every tool outside `workspace_*` returns `no workspace open` while no workspace is open, and `workspace switch in progress` during a switch. These are tool results the agent can read, never JSON-RPC protocol errors.

### process_wait

`process_wait` is the one tool that does not map onto a single route. It polls the process list every 500 ms until the process reaches a state:

- Identify the process with exactly one of `commandId` (the newest process of that command) or `pid`. A command that has not spawned yet is waited for.
- `until` is `running`, `healthy` (healthcheck passing), `stopped` (stopped on request) or `exited`. `exited` also matches `completed` and `failed`, and `completed` is treated as a clean exit.
- It returns an error at once when the process has already reached a terminal state (`stopped`, `completed` or `failed`) that can never satisfy `until`. For example, a process that failed while waiting for `running`.
- `timeout_ms` defaults to 30000 and is capped at 120000. On timeout the error includes the last snapshot. Many MCP clients abort a request after about 60 s, so prefer shorter waits and call again.
- The wait is cancelled when the HTTP connection to `/mcp` closes; the tool then returns an error. A `notifications/cancelled` message sent as a separate stateless POST does not abort a wait that is already in flight.

### Secrets

`env_list`, `env_set` and `env_import` replace the value of every secret variable with `[FILTERED]` in their output, whatever the HTTP route reports. Agents can see that a variable exists and whether it is secret, but not its value. Process output returned by `log_query` is passed through as stored.

## Audit Log

Every mutating operation (command creation/update/deletion, profile changes, env var changes) writes an audit entry to SQLite's `audit_log` table. Fields include: timestamp, action (`create`, `update`, `delete`), actor (profile name or "anonymous"), and details (the changed field names). Audit entries are not exposed via the HTTP API at this time but are queryable through ConductorQueries directly.
