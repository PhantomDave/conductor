# CLI Reference

The Conductor CLI is built with Commander v15 and runs standalone (no daemon required). The binary is published as `conductor` and installed via `bun link`.

**Workspaces:** the CLI is already per workspace — it uses the `.conductor.yml` found by walking up from your cwd, so `cd` into a project folder to work on it. There is no `conductor workspace` command: switching the desktop app's open workspace happens in its start screen. The desktop sidecar listens on a random port, so `ps`, `stop`, `logs` and `log-retention` (which use `CONDUCTOR_API_URL` or port 4000) can't reach it; the `conductor mcp` bridge finds it through [`endpoint.json`](#conductor-mcp).

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

Manage profile environment variables stored in the SQLite DB (`.conductor/data/conductor.sqlite` next to `.conductor.yml`) — the same store as the UI's Environment tab, so `run`, `configure` and the server all see them.

```
usage: conductor env get <profile> <key>
usage: conductor env set <profile> <key> <value>
```

- `get` — prints the fully resolved value the profile's commands will see (all layers, `${VAR}` interpolated)
- `set` — stores a profile-scoped var; keys that look secret (`*TOKEN*`, `*PASSWORD*`, ...) are flagged as secret

Merge order (later wins): system env → `global_env` → DB global vars → profile `env` → DB profile vars → command `env_overrides`.

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

Query or stream process logs from the core API.

```
usage: conductor logs [--follow] [--grep <pattern>] [--level <debug|info|warn|error>] [--pid <pid>] [--command <id>] [--profile <name>] [--limit <n>]
```

- `--follow` — tail continuously via SSE (`/api/logs/stream`)
- `--runs` — list past runs (one per pid) instead of log lines; combine with `--command`/`--profile`, then view one with `--pid`
- `--grep` — substring filter against log message text
- `--level` — exact log level filter (`debug`, `info`, `warn`, `error`)
- `--pid` — filter by process id
- `--command` — filter by command id
- `--profile` — filter by profile name
- `--limit` — maximum history lines fetched before follow starts

### conductor stop

Stop all running commands in a profile through the core API endpoint.

```
usage: conductor stop <profile>
```

### conductor mcp

Bridge a stdio MCP client to the running core's [`/mcp` endpoint](./API.md#mcp-endpoint). An MCP client launches this command itself; you don't normally run it by hand. stdout carries only JSON-RPC messages.

```
usage: conductor mcp [--url <url>]
```

- `--url <url>` — core base URL, such as `http://localhost:4000`. Omit it to auto-discover.

The base URL is resolved in this order. An empty value counts as unset.

1. `--url`
2. `CONDUCTOR_API_URL`
3. The endpoint file, if the process it names is still alive
4. `http://localhost:4000`

The endpoint file is `~/.conductor/endpoint.json`, containing `{ "url", "pid", "startedAt" }`. The core writes it once it is listening and removes it on a clean shutdown, and only if the file still names its own pid. Set `CONDUCTOR_ENDPOINT_FILE` to use another path; the core and the CLI read the same variable. A file left by a dead process is ignored. Run only one core per user: with several cores running at once the last one to start owns `endpoint.json`, and when it exits it removes the file, so `conductor mcp` stops auto-discovering the others. The desktop app's sidecar advertises its random port this way, so `conductor mcp` needs no flags when the app is running.

Before it starts relaying, the bridge probes `/api/health` with a 2 second timeout. If the URL came from the endpoint file and does not answer, the bridge tries `http://localhost:4000` once before giving up, and notes the fallback on stderr. `--url` and `CONDUCTOR_API_URL` never fall back. If nothing answers, it prints an error to stderr naming each URL it tried and exits with code 1.

`/mcp` only accepts loopback hosts (`localhost`, `127.0.0.1`, `[::1]`). If core answers a forwarded request with HTTP 403, the bridge writes one line to stderr, `conductor mcp: /mcp only accepts loopback hosts (localhost, 127.0.0.1, [::1]); got <base URL>`, then carries on. Point `--url` at a loopback address.

Register it with Claude Code:

```bash
claude mcp add conductor -- conductor mcp
```

## Configuration Resolution Order (highest → lowest)

1. Per-command `env_overrides` (in `.conductor.yml`)
2. Active profile's `env` block (in `.conductor.yml`)
3. Top-level `global_env` (in `.conductor.yml`)
4. System environment variables (host OS)
5. Values from `.env.<profile>.local` written via `conductor env set`

## CLI Environment Variables

| Variable                  | Purpose                                                                                            | Default                      |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------- |
| `CONDUCTOR_API_URL`       | Override the HTTP API server URL used by `ps`, `stop`, `logs`, `log-retention` and `conductor mcp` | `http://localhost:4000`      |
| `CONDUCTOR_ENDPOINT_FILE` | Path of the endpoint file that `conductor mcp` reads (and the core writes)                         | `~/.conductor/endpoint.json` |
| `BASE_PATH`               | Base directory for config resolution (overrides `.conductor.yml`)                                  | `"."`                        |

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
