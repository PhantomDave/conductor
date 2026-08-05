# CLI Reference

The Conductor CLI is built with Commander v15 and runs standalone (no daemon required). The binary is published as `conductor` and installed via `bun link`.

## Commands

### conductor run

Start a profile's commands in dependency order.

```
usage: conductor run <profile> [commandId]
```

- `<profile>` — name of the profile to run (from `.conductor.yml`)
- `[commandId]` — optional: run only this specific command instead of the entire profile

The CLI reads `.conductor.yml` from the current directory, resolves commands in dependency order, and starts them sequentially with health check polling. The process stays alive for the duration of the run. When you press Ctrl+C, Conductor's shutdown handler calls `queue.stopAll()`, which sends each process its configured `stop_signal` (or runs `stop_command` if set) and waits up to `stop_timeout_ms` before escalating to SIGKILL.

All commands are auto-compiled from `.example` templates if the target files don't exist yet. Missing environment variables produce warnings on stderr but don't block execution.

### conductor list

List profiles or commands within a profile.

```
usage: conductor list [<profile>]
```

- Without arguments: lists all profiles in `.conductor.yml`
- With a profile name: lists the commands assigned to that profile (root command IDs)

### conductor ps

Show running processes via the API server (default `http://localhost:4000`).

```
usage: conductor ps [--api-url <url>]
```

Hits `/api/processes` and prints the raw JSON array of process snapshots. If the API server isn't running, the CLI prints an error message and exits without output. Set the `CONDUCTOR_API_URL` environment variable to override the API endpoint.

### conductor env

Manage environment variables persisted in `.env.<profile>.local`.

```
usage: conductor env get <profile> <key>
usage: conductor env set <profile> <key> <value> [--secret]
```

- `get` — reads an env var from the profile's local file
- `set` — writes a var (creates the file if it doesn't exist)
- `--secret` — marks the variable as secret (stored with masked value in logs)

These vars are merged during execution: **global_env** → **profile.env** → **command env_overrides**. The CLI files follow `.env.local` semantics: they take precedence over system variables but below explicit overrides.

### conductor config validate

Validate a YAML configuration file against the Zod schema. No mutations occur.

```
usage: conductor config validate [file]
```

- `[file]` — path to validate; defaults to `./.conductor.yml` or whatever Conductor would load

Outputs JSON errors if validation fails, otherwise prints "OK" and returns exit code 0. Useful in CI pipelines (`bun run -- packages/cli/bin/conductor.ts config validate .conductor.yml`).

### conductor configure

Auto-generate `.env`, `appsettings.json`, and other config files from `.example` templates. Runs before every `run` command but can also be invoked standalone.

```
usage: configure [profile] [-f, --force]
```

- `[profile]` — target profile for which vars from `.config.json.example` are populated; defaults to active profile
- `-f/--force` — overwrite existing files without prompting

The `--force` flag bypasses the interactive prompt. This command is particularly useful when cloning a repo and needing to populate missing `.env` files from their `.example` counterparts.

### conductor logs

View process logs (stub — SQL layer exists via ConductorQueries.queryLogs(), SSE wire needed for terminal tailing).

```
usage: conductor logs [--follow] [--grep <pattern>] [--level <debug|info|warn|error>]
```

- `--follow` — tail continuously (same as `logs -f`)
- `--grep` — regex filter matching the command name, log level, or message text
- `--level` — minimum severity level; defaults to `info`

### conductor stop

Stubbed CLI command. For now, Ctrl+C is the primary way to stop a running profile (immediate SIGKILL). A graceful shutdown option that respects each command's `stop_command`, `stop_signal`, and `stop_timeout_ms` fields is planned but not yet wired into the CLI.

```
usage: conductor stop [profile]
# For now, use Ctrl+C — sends SIGKILL immediately to all active commands.
```

## Configuration Resolution Order (highest → lowest)

1. Per-command `env_overrides` (in `.conductor.yml`)
2. Active profile's `env` block (in `.conductor.yml`)
3. Top-level `global_env` (in `.conductor.yml`)
4. System environment variables (host OS)
5. Values from `.env.<profile>.local` written via `conductor env set`

## CLI Environment Variables

| Variable            | Purpose                                                           | Default                 |
| ------------------- | ----------------------------------------------------------------- | ----------------------- |
| `CONDUCTOR_API_URL` | Override the HTTP API server URL used by `ps`                     | `http://localhost:4000` |
| `BASE_PATH`         | Base directory for config resolution (overrides `.conductor.yml`) | `"."`                   |

## Exit Codes

| Code | Meaning                                 |
| ---- | --------------------------------------- |
| 0    | Success                                 |
| 1    | Validation error or missing config file |
| 2    | Profile not found                       |
| 3    | Command execution failed                |
| 4    | API connection error (`ps` command)     |

## Version Info

```
usage: conductor --version
# Output: 0.1.0
```
