# Configuration Reference

## File Structure

Conductor looks for `.conductor.yml` in the project root (or at `base_path` if overridden). The config has two top-level sections: **root commands** and **profiles**.

```yaml
version: "1"
name: "My Project"
description: "Full-stack development environment"

env_secrets: [API_TOKEN, DB_PASSWORD]
base_path: "."
default_shell: "/bin/bash"
global_env:
  LOG_LEVEL: info

# ── Commands (root level — single source of truth) ──
commands:
  - id: db
    name: "PostgreSQL"
    run: docker compose up postgres
    healthcheck: ...

  - id: api
    name: "API Server"
    run: npm run dev
    cwd: ./server
    deps: [db]
    healthcheck: ...

# ── Profiles (selectors that reference commands by ID) ──
profiles:
  dev:
    description: "Local development"
    env:
      NODE_ENV: development
    command_ids: [db, api]
```

## Top-Level Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | string | `"1"` | Config schema version |
| `name` | string | — | Display name in UI/logs |
| `description` | string | — | Profile-group-level description |
| `author` | string | — | Template author (display only) |
| `keywords` | string[] | — | Tags for discoverability |
| `tags` | string[] | — | Human-readable tags |
| `env_secrets` | string[] | `[]` | Variable names masked everywhere (`[FILTERED]`) |
| `base_path` | string | `"."` | Directory resolution; also overridden by `$BASE_PATH` env var |
| `default_shell` | string | system default (`$SHELL` / `%COMSPEC%`) | Default shell for non-shell commands |
| `global_env` | Record\<string, string\> | `{}` | Merged into every command's environment |
| `commands` | CommandSchema[] | — | **Root-level commands** (single source of truth) |
| `profiles` | Record\<string, ProfileSchema\> | *(required)* | Named sets that reference commands by ID |

## CommandSchema (root level)

Every field except `id`, `name`, and `run` has a default. **Commands live at the root only**; they are never embedded inside profiles.

| Field | Type | Default | Description |
|---|---|---|---|
| **`id`** | string | — | **Required.** Unique identifier used in `deps[]` and `command_ids[]`. |
| **`name`** / `description` | string | — | Display name. |
| **`run`**\* | string | — | **Required.** Shell or binary command to execute. |
| `cwd` | string | `"."` | Working directory, resolved relative to `base_path`. |
| `shell` | boolean | `true` | If `false`, run is executed without a shell. |
| `deps` | string[] | `[]` | IDs of root commands that must be **healthy** before this starts. Transitive chains supported. |
| `env_overrides` | Record\<string, string\> | `{}` | Per-command env var overrides (merged on top of global_env + profile.env). |
| `watch` | string[] | `[]` | File glob patterns for auto-restart (not yet implemented). |
| `readonly` | boolean | `false` | Informational flag; not enforced by the engine. |
| `stop_signal` | string | `"SIGTERM"` | Signal sent during graceful shutdown. Also accepts `SIGINT`, `SIGHUP`, etc. |
| `stop_timeout_ms` | number | `5000` | Time before force-kill (SIGKILL or Windows taskkill). |
| `stop_command` | string | _none_ | A command to run **before** stop_signal; useful for Docker Compose cleanup. |
| `healthcheck` | HealthcheckSchema | `{ type: "none" }` | Readiness check configuration. See [Healthchecks](#healthchecks) below. |

\* The `run` command uses your system shell unless `shell: false`. You can safely use shell features (`&&`, `|`, `~`) with the default.

## ProfileSchema (profiles section)

Profiles **do not embed commands**. They contain three possible keys:

| Field | Type | Default | Description |
|---|---|---|---|
| `description` | string | — | Human-readable profile description. |
| `env` | Record\<string, string\> | `{}` | Environment variables for all commands in this profile (between global_env and command-level overrides). |
| **`command_ids`** | string[] | `[]` | List of root command IDs this profile will execute. The order in the array is the start order; dependency resolution still applies if `deps` are declared on the commands themselves. |

## Environment Resolution Order (lowest → highest priority)

1. System environment variables
2. `global_env` from config
3. Profile-level `env`
4. Command-level `env_overrides`

Example: if global_env sets `NODE_ENV=production`, profile env sets nothing, and command env_overrides sets `NODE_ENV=development`, the final value is `development`.

### Secret Masking

Any environment variable whose **name** appears in the top-level `env_secrets` array will have its value replaced with `[FILTERED]` everywhere — logs, UI display, and API responses. Both exact match and substring match against the var name are supported (e.g., `API_TOKEN`, `DB_PASSWORD`).

## Healthchecks

Choose one of four types per command:

| Type | Description | Required Fields |
|---|---|---|
| `"none"` (default) | Consider the process healthy immediately after spawning. No waiting. | _none_ |
| `"port"` | Wait for a TCP port to accept connections. Socket timeout: 2 s. | `port` (number) |
| `"http"` | Wait for an HTTP endpoint to respond with status < 500. Fetch timeout: 2 s. | `url` (string, complete URL) |
| `"command"` | Execute a shell command and wait for exit code 0. | `command` (string) |

### Healthcheck Common Fields

All healthcheck types share these fields:

| Field | Type | Default | Description |
|---|---|---|---|
| `interval_ms` | number | `1000` | Milliseconds between probes. |
| `timeout_ms` | number | `30000` | Total timeout before the health check is treated as failed. |
| `retries` | number | `30` | Number of probe attempts (approximately `retries × interval_ms`). |

## base_path Resolution

The config file is always located at `base_path/.conductor.yml`. Resolved as:

```
resolvablePath = process.cwd() + "/" + <base_path from config or $BASE_PATH>
file = resolvablePath + "/.conductor.yml"
```

When no explicit base_path is set, it defaults to `"."` (the current working directory where Conductor is invoked). You can also override globally via the `$BASE_PATH` environment variable.

All `cwd` fields on commands are resolved relative to the computed base_path. Relative paths like `./server`, `../other`, or absolute paths work as expected.

## Example Templates Compilation (configure)

When you run `conductor configure <profile>` (CLI) or call the API, Conductor looks for files named `*.example` beneath base_path and auto-generates corresponding live config files:

- `.env.example` → `.env.<profile>`
- `.appsettings.json.example` → `appsettings.json`
- Any other `*.json.example` or `*.yaml.example` → un-suffixed target file (minus the `.example` part)

Variables in templates are interpolated using `$VAR_NAME` syntax. Missing variables produce warnings but not errors. The command returns a structured report with details on what was created, skipped, and which vars were missing.

## Full Example Configuration

```yaml
version: "1"
name: "MyApp Full-Stack"
description: "Local development environment"
author: your-github-handle
keywords: [nodejs, react, postgres]

env_secrets: [DATABASE_PASSWORD, API_TOKEN, STRIPE_KEY]
base_path: "."
default_shell: "/bin/bash"
global_env:
  LOG_LEVEL: info
  APP_NAME: MyApp

# ── Commands (root level) ────────────────────────────────
commands:
  - id: postgres
    name: "PostgreSQL"
    description: "Primary application database"
    run: docker compose up -d postgres
    healthcheck:
      type: port
      port: 5432
      interval_ms: 1000
      timeout_ms: 30000
      retries: 30

  - id: api
    name: "API Server"
    run: npm run dev
    cwd: ./server
    deps: [postgres]
    env_overrides:
      NODE_ENV: development
      PORT: 3001
    healthcheck:
      type: http
      url: "http://localhost:3001/health"
      interval_ms: 500
      timeout_ms: 30000
      retries: 30
    stop_timeout_ms: 5000

  - id: web
    name: "Frontend"
    run: npm run dev
    cwd: ./web
    deps: [api]
    healthcheck:
      type: http
      url: "http://localhost:3000"
      interval_ms: 500
      timeout_ms: 30000
      retries: 30
    stop_timeout_ms: 5000

# ── Profiles ─────────────────────────────────────────────
profiles:
  dev:
    description: "Local development with live reload"
    env:
      NODE_ENV: development
      API_URL: "http://localhost:3001"
    command_ids: [postgres, api, web]

  prod:
    description: "Production-like (no live-reload)"
    env:
      NODE_ENV: production
    command_ids: [api, web]
```
