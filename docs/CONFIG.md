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

| Field                    | Type                            | Default                                 | Description                                                                                                                                    |
| ------------------------ | ------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                | string                          | `"1"`                                   | Config schema version                                                                                                                          |
| `name`                   | string                          | —                                       | Display name in UI/logs                                                                                                                        |
| `description`            | string                          | —                                       | Profile-group-level description                                                                                                                |
| `author`                 | string                          | —                                       | Template author (display only)                                                                                                                 |
| `keywords`               | string[]                        | —                                       | Tags for discoverability                                                                                                                       |
| `tags`                   | string[]                        | —                                       | Human-readable tags                                                                                                                            |
| `env_secrets`            | string[]                        | `[]`                                    | Variable names masked everywhere (`[FILTERED]`)                                                                                                |
| `base_path`              | string                          | `"."`                                   | Directory resolution; also overridden by `$BASE_PATH` env var                                                                                  |
| `default_shell`          | string                          | system default (`$SHELL` / `%COMSPEC%`) | Default shell for non-shell commands                                                                                                           |
| `global_env`             | Record\<string, string\>        | `{}`                                    | Merged into every command's environment                                                                                                        |
| `log_retention_days`     | number                          | `7`                                     | Time-window log retention (hourly sweep); `0` disables. Edited via GET/PUT `/api/log-retention` or the Environment tab, not the YAML directly. |
| `log_retention_sessions` | number                          | `10`                                    | Keeps only the last N sessions' logs per profile (a session = one `POST /profiles/:profile/run`); `0` disables. Same edit path as above.       |
| `commands`               | CommandSchema[]                 | —                                       | **Root-level commands** (single source of truth)                                                                                               |
| `profiles`               | Record\<string, ProfileSchema\> | _(required)_                            | Named sets that reference commands by ID                                                                                                       |

## CommandSchema (root level)

Every field except `id`, `name`, and `run` has a default. **Commands live at the root only**; they are never embedded inside profiles.

| Field                      | Type                                 | Default            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`id`**                   | string                               | —                  | **Required.** Unique identifier used in `deps[]` and `command_ids[]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **`name`** / `description` | string                               | —                  | Display name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **`run`**\*                | string                               | —                  | **Required.** Shell or binary command to execute.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cwd`                      | string                               | `"."`              | Working directory, resolved relative to `base_path`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `shell`                    | boolean                              | `true`             | If `false`, run is executed without a shell.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `deps`                     | string[]                             | `[]`               | IDs of root commands that must be **healthy** before this starts. Transitive chains supported.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `env_overrides`            | Record\<string, string\>             | `{}`               | Per-command env var overrides (merged on top of global_env + profile.env).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `watch`                    | string[]                             | `[]`               | Globs relative to `cwd` (e.g. `src/**`, `*.csproj`). A matching change restarts the command after 500ms of quiet, then restarts every **running** command that transitively depends on it. Changes during a restart collapse into one follow-up restart. Build/tool dirs (`node_modules`, `.git`, `dist`, `obj`, `target`, `.next`, `.turbo`, `coverage`, `__pycache__`, `.venv`) and lockfiles (`package-lock.json`, `bun.lock`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, …) are always ignored. A command you stopped stays stopped. |
| `config_files`             | (string \| ConfigFile)[]             | `[]`               | `.env` files kept in sync with the env before every start. See [Declared config files](#declared-config-files).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `readonly`                 | boolean                              | `false`            | Informational flag; not enforced by the engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `stop_signal`              | string                               | `"SIGTERM"`        | Signal sent during graceful shutdown. Also accepts `SIGINT`, `SIGHUP`, etc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `stop_timeout_ms`          | number                               | `5000`             | Time before force-kill (SIGKILL or Windows taskkill).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `stop_command`             | string                               | _none_             | A command to run **before** stop_signal; useful for Docker Compose cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `restart`                  | `manual` \| `on_failure` \| `always` | `"manual"`         | Auto-restart policy, keyed on process **exit code**. `on_failure` respawns only on a non-zero exit; `always` respawns any exit. A stop or restart you asked for never counts as a crash. Capped at 5 consecutive restarts with exponential backoff (1s → 30s); the budget resets after 60s of uptime or on a manual restart.                                                                                                                                                                                                               |
| `healthcheck`              | HealthcheckSchema                    | `{ type: "none" }` | Readiness check configuration. See [Healthchecks](#healthchecks) below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

\* The `run` command uses your system shell unless `shell: false`. You can safely use shell features (`&&`, `|`, `~`) with the default.

## ProfileSchema (profiles section)

Profiles **do not embed commands**. They contain three possible keys:

| Field             | Type                     | Default | Description                                                                                                                                                                           |
| ----------------- | ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`     | string                   | —       | Human-readable profile description.                                                                                                                                                   |
| `env`             | Record\<string, string\> | `{}`    | Environment variables for all commands in this profile (between global_env and command-level overrides).                                                                              |
| **`command_ids`** | string[]                 | `[]`    | List of root command IDs this profile will execute. The order in the array is the start order; dependency resolution still applies if `deps` are declared on the commands themselves. |

## Environment Resolution Order (lowest → highest priority)

1. System environment variables
2. `global_env` from config
3. Profile-level `env`
4. Command-level `env_overrides`

Example: if global_env sets `NODE_ENV=production`, profile env sets nothing, and command env_overrides sets `NODE_ENV=development`, the final value is `development`.

### Secret Masking

Any environment variable whose **name** appears in the top-level `env_secrets` array will have its value replaced with `[FILTERED]` everywhere — logs, UI display, and API responses. Both exact match and substring match against the var name are supported (e.g., `API_TOKEN`, `DB_PASSWORD`).

## Healthchecks

Choose one of five types per command:

| Type               | Description                                                                 | Required Fields              |
| ------------------ | --------------------------------------------------------------------------- | ---------------------------- |
| `"none"` (default) | Consider the process healthy immediately after spawning. No waiting.        | _none_                       |
| `"port"`           | Wait for a TCP port to accept connections. Socket timeout: 2 s.             | `port` (number)              |
| `"http"`           | Wait for an HTTP endpoint to respond with status < 500. Fetch timeout: 2 s. | `url` (string, complete URL) |
| `"command"`        | Execute a shell command and wait for exit code 0.                           | `command` (string)           |
| `"log_line"`       | Wait for a stdout/stderr line containing a substring.                       | `pattern` (string)           |

`log_line` polls the process's own output (already collected for logging) rather than the network or a subprocess: on each of the `retries` attempts, spaced `interval_ms` apart, it checks whether any line since startup has contained `pattern`. This suits a service that only announces readiness on stdout (e.g. a dev server printing `compiled successfully`) with no port or endpoint to probe yet. It's a one-shot signal — a line either appeared or it didn't, and it can't un-appear — so unlike the other types, it does not run in the continuous post-startup health monitor.

### Healthcheck Common Fields

All healthcheck types share these fields:

| Field         | Type   | Default | Description                                                       |
| ------------- | ------ | ------- | ----------------------------------------------------------------- |
| `interval_ms` | number | `1000`  | Milliseconds between probes.                                      |
| `timeout_ms`  | number | `30000` | Total timeout before the health check is treated as failed.       |
| `retries`     | number | `30`    | Number of probe attempts (approximately `retries × interval_ms`). |

## base_path Resolution

The config file is always located at `base_path/.conductor.yml`. Resolved as:

```
resolvablePath = process.cwd() + "/" + <base_path from config or $BASE_PATH>
file = resolvablePath + "/.conductor.yml"
```

When no explicit base_path is set, it defaults to `"."` (the current working directory where Conductor is invoked). You can also override globally via the `$BASE_PATH` environment variable.

All `cwd` fields on commands are resolved relative to the computed base_path. Relative paths like `./server`, `../other`, or absolute paths work as expected.

## Example Templates Compilation (configure)

When you run `conductor configure [profile]` (CLI), click **Compile** in the Environment tab, or start a profile, Conductor looks for files following the `<name>.example<.ext>` convention beneath base_path and creates the real file next to each one:

- `.env.example` → `.env`
- `appsettings.example.json` → `appsettings.json`
- `appsettings.Development.example.json` → `appsettings.Development.json`

`${VAR}` tokens in templates are filled in from the resolved env. Missing variables are left blank and reported, not treated as errors. Existing files are never overwritten unless you pass `--force`, so this only helps on a fresh checkout. To keep an existing `.env` up to date, use `config_files` (below).

## Declared config files

`config_files` lists `.env` files that Conductor converges to the current env **before every start** (including restarts), the way Terraform applies a plan. Only keys whose value differs are rewritten. Comments, ordering, `export` prefixes, quoting and line endings are left alone, and a file that's already up to date isn't touched.

```yaml
commands:
  - id: web
    cwd: ./web
    config_files:
      - .env # shorthand for { path: .env, auto: true }
      - path: ../api/.env
        auto: false
        set:
          API_URL: "http://localhost:${API_PORT}"
```

| Field  | Default | Description                                                                                                                                                                                        |
| ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path` | —       | Relative to the command's resolved `cwd`. Supports `${VAR}`.                                                                                                                                       |
| `auto` | `true`  | Rewrites keys the file **already has** with Conductor's value of the same name. It never adds keys, and never blanks a non-empty value.                                                            |
| `set`  | `{}`    | Pinned keys, which win over `auto`. Values may use `${VAR}`. Missing keys are appended, and the file is created if it doesn't exist. A key whose `${VAR}` has no value is left as is and reported. |

**Only keys declared in Conductor count for `auto`**: `global_env`, `profile.env`, DB env vars (global and profile), `env_overrides` and `BASE_PATH`. Variables inherited from the shell that launched Conductor (`PORT`, `NODE_ENV`, …) never overwrite a file.

Each start logs what changed, e.g. `[config] .env: API_URL changed, DB_HOST added`. Values of secret-looking keys and `env_secrets` are masked in plans and logs.

### Plan and apply

- `conductor configure [profile] --plan`, or **Preview changes** in the Environment tab, shows the diff without writing anything, including the example compile:

  ```
  ~ web/.env [web]
      ~ API_URL: "http://old" → "http://localhost:4000"
      + DB_HOST = "localhost"
  ```

- `conductor configure [profile]` or **Compile** applies it. `POST /api/configure` accepts `{ profile?, force?, plan? }` and returns `configFiles` and `lint` alongside the compile report.

### Unused config lint

Plan and apply also cross-check the **shared env** (`global_env`, `profile.env` and DB env vars) against what the config files and `.example` templates actually use. This helps catch typos:

- **Unused**: a shared key that no `auto` file, `set:` value or template references.
- **Not provided**: a key in an `auto` file that Conductor has no value for, so it keeps its local value.

Each entry suggests the closest name from the other list when there's a likely typo, e.g. `API_ULR` → did you mean `API_URL`? These are hints, not errors: a process may still read a variable straight from its env.

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
