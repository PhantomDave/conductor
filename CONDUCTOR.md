# Conductor — Architecture

## Purpose

Conductor is a Bun-based monorepo that provides a CLI, HTTP API, web dashboard, and desktop shell for declaratively running multi-service development environments. The core engine orchestrates processes in dependency order, runs configurable health checks, persists state to SQLite, and streams logs via Server-Sent Events.

## Repository Layout

```
conductor/
├── packages/core/src/        Core engine (config × executor × db × API)
│   ├── config/               Config loader + Zod schema (+ env-example compiler)
│   ├── env/                  Secret masking, variable interpolation
│   ├── logs/                 SSE broadcaster (pub/sub)
│   ├── docker-compose/       YAML parser → Command suggestions
│   ├── executor/             SpawnQueue + ProcessWrapper + healthchecks
│   ├── monitor/              (stub — not yet implemented)
│   ├── db/                   SQLite init, queries, schema.sql
│   └── api.ts                Fastify API server (~876 lines)
├── packages/cli/src/commands /CLI commands (run | configure | list | config | env | ps | logs)
├── packages/ui/src/          React 19 + Vite + Mantine dashboard
├── packages/desktop/main.ts Electron shell (sidecar compile + UI dist)
└── .conductor.example.yml    Canonical config example
```

## Data Flow — Process Execution

```
CLI/API ──▶ Profile resolution (from .conductor.yml in base_path)
           ▶ Command graph build (root commands + command_ids per profile)
           ▶ Dependency sort topological traversal
           ▶ for each unresolved command: StartOne(commandId, onLog)
               ├─ resolve deps recursively first
               ├─ spawn process via node:child_process
               ├─ pipe stdout/stderr → SQLite INSERT queries
               └─ broadcast log lines (logs/broadcaster.ts)
```

### StartOne Logic (packages/core/src/executor/queue.ts::StartOne)

1. Fetch the command and its dependencies from the config store
2. For each dependency, call `startOne` recursively until all resolve as healthy or error
3. Resolve shell: use `default_shell` in config → fall back to `$SHELL` (POSIX) or `%COMSPEC%` (Windows)
4. Spawn process via node child_process; capture PID and pipe stdout/stderr into SQLite + broadcaster
5. If healthcheck defined, poll until timeout/retries exhausted (port/http/command/none)

## Process Lifecycle (Status Machine)

```
starting → running → healthy / stopped / failed
                    ↕               │
                  (poll)          └─ exit code logic:
                                     0 = stopped
                                    ≠0 = failed
```

- **starting**: PID assigned, process group created; health check not yet applicable
- **running**: Process spawned; if healthcheck type is `none`, considered success immediately; otherwise begin polling interval
- **healthy**: Health check passed (`port`: TCP connect succeeds within 2 s socket timeout; `http`: GET to URL returns < 500 within 2 s fetch timeout; `command`: exit code === 0)
- **stopped**: Process exited with code 0 (graceful)
- **failed**: Process exited with non-zero code

### Graceful Shutdown (stopByPid)

1. Write negative PID to the process group (POSIX `-pid`) or call `taskkill /pid /T` (Windows)
2. Wait up to `stop_timeout_ms` (default 5,000 ms)
3. If still alive, send SIGKILL
4. Transition status → stopped/failed

## Config Engine

### Schema Structure

```typescript
interface ConductorConfigSchema {
  version: string; // default "1"
  name?: string; description?: string; author?: string; keywords?: string[]; tags?: string[];
  env_secrets: string[];              // vars to mask in logs and UI
  base_path: string;                  // default ".", relative to cwd + $BASE_PATH override
  default_shell?: string;             // shell for non-shell commands
  global_env: Record<string, string>; // merged into every command's env

  // ROOT-LEVEL commands (single source of truth)
  commands: CommandSchema[];

  // Profiles are pure selectors with optional overrides
  profiles: Record<string, ProfileSchema>;
}
```

### Config Resolution

1. Load `.conductor.yml` from `base_path` (configurable via env var too)
2. Merge config → store (`packages/core/src/config/store.ts`)
3. Env resolution: global_env → profile.env → command.env_overrides → system env
4. Secret masking (env/masker.ts): any variable whose name appears in `env_secrets` is replaced with `[FILTERED]` before writing to logs or UI

### Example-Templates Compilation

The `configure` command and CLI's `compileConfigExamples` function scans the config's base_path for `.example` dot-files (`.env.example`, `.appsettings.json.example`). For each, it reads the template and replaces `${VAR}` references with current env values, writing results under base_path as `.env.<profile>` or app-specific files. Returns a `CompileReport` (`created`, `skipped`, `errors`, `missingVars`, `results[]`).

## HTTP API (packages/core/src/api.ts)

Fastify server on port 4000; CORS scoped to localhost any port.

### Key Endpoints by Group

| Group | Methods + Route | Notes |
|---|---|---|
| System health | `GET /api/health` | Pong check |
| Profiles CRUD | `GET/POST /api/profiles`; `PUT/DELETE/:profile`; `POST/:profile/duplicate`; `GET/:profile/export` | Full management; store-backed |
| Commands (root) | `GET/POST /api/command`; `PUT/:id`; `DELETE/:id` | Root commands; delete touches all profiles |
| Profile↔Command links | `POST/:profile/commands` (create root cmd + add); `PUT/:profile/commands/:id`; `POST/:profile/commands/sync {add?,remove?}`; `POST/:profile/commands/:id/duplicate {targetProfile?}`; `POST/:profile/commands/:id/move {targetProfile}` | Full linking graph |
| Processes | `GET /api/processes` (queue.listSnapshots); `DELETE /:pid`; `GET /:pid/metrics?from&to` (stubbed) | Active runs |
| Notifications | `GET /api/notifications?limit&offset` | Events from executor |
| Env vars | `GET/PUT /api/env` (scope global\|profile); `DELETE/:id`; `POST /env/import {scope, profile, text}` | SQLite persisted; looksSecret auto-detect |
| Logs + SSE | `GET /logs?pid&commandId&profile&limit` returns reversed; `GET /logs/stream/:pid` (SSE) | 500-line replay + live tail + 15 s heartbeats |
| Config | `POST /api/configure {profile?, force?}`; `POST /config/import {yaml}`; `GET /config/export`; `GET/PUT /base-path`; `GET/PUT /shells`; `POST /docker compose/parse {yaml}` (parses docker-compose → suggested commands) | All mutating ops write audit entries |

### UI Serving

If CONDUCTOR_UI_DIST env is set (Electron shell), Fastify serves build artifacts with SPA fallback to index.html. This achieves same-origin API/UI in production.

## Database Layer (SQLite)

Schema: `packages/core/src/db/schema.sql` plus TypeScript queries in `queries.ts`.

Tables:

- `execution_history(id, command_id, profile, start_time, end_time, exit_code)`
- `logs(id, process_id, timestamp, level, message)` — indexed on process_id; up to 500-line window
- `process_metadata(id, command_id, profile, pid, created_at, ended_at, status)``
- `process_metrics(pid, timestamp, cpu_percent, memory_bytes)` — queried via queries.queryMetrics (stubbed, monitor/ not wired)
- `env_vars(id, scope, profile, key, value, secret)` — upserted/deleted from API/env CLI
- `audit_log(timestamp, action, actor, details)` — written on every config mutation

All query helpers live in ConductorQueries class; used by queue.ts (for process metadata) and the API layer.

## State Management

Config is stored in packages/core/src/config/store.ts as an in-memory reactive store with helper mutators:

- getConfig / addCommand / removeCommand / updateCommand
- addCommandToProfile / removeCommandFromProfile / duplicateCommand
- addProfile / removeProfile / updateProfile / duplicateProfile / getProfileCommands
- setBasePath / getResolvedBasePath / setDefaultShell / importConfig / compileConfigExamples / refreshEnv

Every mutation triggers a config change event and writes an audit log entry. The HTTP API and CLI both modify the same store instance via shared imports.

## Environment & Secrets

packages/core/src/env/masker.ts: interpolateString resolves `${VAR}` references; looksSecret checks variable names against env_secrets list; masked values become `[FILTERED]` in log output and UI display.

Environment priority (lowest → highest):

1. System environment variables
2. global_env from config
3. Profile-level env (`profiles.dev.env`)
4. Command-level env_overrides

## Desktop Shell (packages/desktop)

Electron 43 + electron-builder + esbuild: main bundle compiles @conductor/core as sidecar binary (bun build --compile → dist-bin/conductor-server), builds UI with Vite, and packages both via electron-builder. `CONDUCTOR_UI_DIST` points Electron to the UI directory for same-origin serving.

Build: `bunx electron-builder --publish always` produces per-OS installers uploaded as GitHub Release assets in CI (release.yml triggers on release published). Separate from tag-based releases.

## Process Monitoring (Not Yet)

packages/core/src/monitor/ is an empty directory — CPU/memory polling does not exist yet. The API endpoint `/api/processes/:pid/metrics` proxies to queries.queryMetrics which returns null by design. Marked as 🔄 Roadmap item.

## Monorepo Scripts

| Script | What it runs |
|---|---|
| `dev:core` | @conductor/core dev server |
| `dev:ui` | Vite dev on port 3000 |
| `dev:cli` | CLI dev (run directly) |
| `dev:desktop` | Builds sidecar + UI, starts Electron |
| `build` | Core build → CLI build → UI build |
| `build:desktop` | Sidecar + UI + electron-builder dist |
| `test` | bun test |
| `typecheck` | TypeScript across all packages |

==================end of section===============================================
