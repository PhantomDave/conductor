# Troubleshooting Guide

## CLI & Runtime Issues

### `conductor: command not found` after install / clone

After running `bun run link:cli`, the binary is symlinked to `~/.bun/bin/conductor`. If you still get `command not found`:

1. Restart your terminal (or restart your shell profile).
2. Check that `~/.bun/bin` and `~/.bun/store` are on your `$PATH` — run `echo $PATH`.
3. Verify the symlink actually exists: `ls -la ~/.bun/bin/conductor`.

If you prefer not to link globally, run the CLI directly in each terminal window:

```bash
bun run --cwd packages/cli bin/conductor.ts run dev
```

### Port 4000 already in use (API server)

The core engine listens on port 4000 for the API. If that port is in use:

```bash
# Find the process using port 4000
lsof -i :4000       # macOS / Linux
netstat -ano | findstr :4000   # Windows

# Kill it if you don't need it
kill <PID>                   # macOS / Linux
taskkill /pid <PID> /f      # Windows
```

To run on a different port, set the `PORT` environment variable before starting:

```bash
PORT=4001 bun run server.ts   # from packages/core
```

### Config file not found or YAML parse error

Run validation in isolation:

```bash
bunx conductor config validate .conductor.yml
```

If it reports errors, fix them first:

- All profiles must have a `command_ids` field.
- Profiles cannot embed commands inline at this time — commands live at the root level, profiles only list which root commands to run via `command_ids`.
- Root-level `commands` array is now mandatory as source of truth.
- Healthcheck fields (interval_ms / timeout_ms / retries) must be numbers, not strings.

See [CONFIG.md](./CONFIG.md) for full reference.

### Commands don't start in expected order

Commands are started based on dependency order computed from each command's `deps` array. The effective execution order is determined through topological sorting of the entire graph:

1. Ensure that dependencies have explicit IDs and that dependents list those IDs correctly (no typos).
2. Check for circular references — they'll cause an immediate error.
3. If using multiple profiles, remember that commands are defined globally and referenced; if one profile includes a command whose deps rely on another profile's command, it should still work fine as long as all referenced commands exist in the root-level `commands` array.

### Profile won't start — exit code ≠ 0 error shown immediately

This usually means a dependency failed before your command could be started. Check:

```bash
conductor ps           # shows current process states
conductor logs api     # view specific command's log lines
```

## Health Check Issues

### Port health check fails but the service is running

Port probes use `node:net` with a 2-second socket timeout and the configured interval (default 1 s). If your service takes several seconds to start listening:

1. Increase `timeout_ms` (total allowed wait time)
2. Increase `retries` (number of probe attempts before failure)
3. Make sure the port number in `healthcheck.port` matches exactly what the service actually binds to (it may not be 5432 if another process is using that port).

### HTTP health check fails with timeout / fetch errors

HTTP checks use native fetch with a 2-second AbortSignal timeout. Common issues:

- **Wrong URL**: The `url` field must include the protocol (`http://`). Paths may need to be explicit (`/health`, `/ping`, etc.).
- **No CORS support in your server**: If your endpoint rejects cross-origin requests, add CORS headers. For local dev this is rarely needed.
- **Firewall blocking**: If on a remote host or non-localhost binding, the host part of the URL may need adjusting.

### Command health check fails (script doesn't exit 0)

Command-type health checks use `resolveShell()` to pick an execution shell and pipe into stdout/stderr. Common failures:

- **Missing binaries**: Docker commands might not be installed or reachable on $PATH.
- **Incorrect arguments**: Check that `command` is a valid, complete shell command with correct quoting.
- **Permission denied**: Ensure the process running Conductor has permissions to execute the command (e.g., Docker requires group membership for non-root usage).

### Process stays in "running" and never reaches "healthy"

This means your health check definition is incompatible with how the service starts:

1. Try using `command` type if neither `port` nor `http` works reliably.
2. Increase `interval_ms` if polling too aggressively, or increase `retries` if the service needs more startup time.
3. Make sure the process actually binds to the port / responds at the expected URL.

## Environment Variable Issues

### Variables not visible to my running command

Check the environment resolution order:

1. System environment variables ($PATH, node, etc.) are always injected from host OS.
2. `global_env` in config merges next.
3. Profile-level `env`.
4. Command-specific `env_overrides`.

If a var disappears between your editor and the running process: it was overridden by a higher-priority entry. Use `conductor env get <profile> <key>` to see what's actually stored in `.env.<profile>.local`:

```bash
conductor env dev NODE_ENV   # shows current value for profile 'dev'
```

### Secrets appear as [FILTERED] everywhere (including API responses)

This is intentional. Any variable name that appears under the top-level `env_secrets` list gets masked as `[FILTERED]`. Check that you don't have accidentally included names you actually need in logs (like `API_TOKEN`) — remove them from the `env_secrets` array if they're not actually secret.

### Example template compilation fails / warns about missing vars

When running `conductor configure <profile>`, variables listed as `$VAR_NAME` in any `.example` file that don't exist get a warning printed to stderr but are ignored — the generated file will contain the raw `${VAR_NAME}` placeholder text. To fix:

1. Run `conductor env set <profile> VAR_NAME value` for each missing variable first
2. Then re-run configure (or pass `-f/--force`)

## Process & Lifecycle Issues

### Ctrl+C doesn't stop running processes

For now, the only way to stop all processes is pressing Ctrl+C in the terminal window that launched `conductor run`. The process manager sends SIGKILL immediately with no graceful shutdown. A future feature will add per-command configurable timeout-based graceful shutdown (SIGTERM → wait → SIGKILL).

### Stuck process (process still running but UI shows "stopped")

This can happen if the parent process that launched Conductor was killed before its children could be notified. To find and kill orphaned processes yourself:

```bash
# macOS / Linux
ps aux | grep 'the_command_name'        # locate PIDs
kill -9 <PID>                            # force kill

# Windows (if applicable)
tasklist | findstr "conductor"           # find process PID
taskkill /pid <PID> /f                   # force kill
```

### Logs command shows only a stub message

The `logs` CLI command currently prints "coming soon" rather than querying SQLite. The database layer for logs (querying via ConductorQueries and the SSE stream at `/api/logs/stream/:pid`) exists but is not wired into the terminal CLI output yet. Use the Web Dashboard's **LogViewer** panel to see live logs via SSE.

## Desktop App Issues

### Electron desktop won't launch after build

Ensure all dependencies compiled correctly:

```bash
bun run build  # core, cli, ui
bun run build:desktop  # sidecar + electron builder
```

The sidecar must be in `packages/core/dist-bin/conductor-server` before the desktop app can find it. Check for errors during the sidecar compilation step (`bunx bun build --compile > ...`).

## Docker Compose Import Issues

### docker compose YAML fails to parse

If `/api/docker compose/parse` returns errors about service configuration, check:

- The YAML is valid (run `docker-compose config`)
- At least one `ports` field maps a host-port for healthcheck detection
- Service names don't contain characters that would break URL generation for http healthchecks

### Docker Compose commands suggest wrong healthchecks

The parser auto-generates `port` healthchecks for services with `ports` mappings and `http` type when a `/health`, `/ping`, or similar endpoint can be inferred from port ranges. Manual review is always recommended after import before running the profile in production scenarios.
