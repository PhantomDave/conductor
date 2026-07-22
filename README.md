<div align="center">

# 🎼 Conductor

**Universal task runner & real-time dashboard for developers**

Run your entire dev stack — databases, servers, workers — with one command.
Watch live logs, CPU/memory metrics, and manage everything from a beautiful web UI.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/runtime-bun-f472b6)](https://bun.sh)
[![Status](https://img.shields.io/badge/status-MVP-orange)](<>)

</div>

---

## Why Conductor?

Starting a dev environment usually means juggling five terminal tabs, a
half-remembered shell script, and hoping nobody forgot to start the
database first. Conductor replaces that with one declarative YAML file and
one command:

```bash
conductor run dev
```

- ✅ Works with **any tech stack** — Node.js, .NET, Python, Docker, whatever you run
- ✅ **Dependency-aware** — start services in the right order, waits for health checks to pass
- ✅ **Smart process management** — distinguishes between running and healthy; graceful stop with SIGKILL fallback
- ✅ **Live dashboard** — logs, CPU/memory, process status in your browser
- ✅ **Secret-safe** — sensitive env vars are masked in logs by default
- ✅ **Cross-platform** — Linux, macOS, and Windows, all first-class
- ✅ **Shareable** — commit `.conductor.yml` and your whole team gets the same setup

---

## Quick Start

```bash
# 1. Install (coming soon to npm/Homebrew — for now, clone & build)
git clone https://github.com/PhantomDave/conductor
cd conductor
bun install

# 2. Link the CLI so the `conductor` command is available globally
bun run link:cli

# 3. Create a .conductor.yml in your project (see example below)
cp .conductor.example.yml .conductor.yml

# 4. Run it
conductor run dev
```

> `bun run link:cli` uses [`bun link`](https://bun.sh/docs/cli/link) to symlink
> the `conductor` binary into `~/.bun/bin`, which is added to your `PATH` by
> the Bun installer. If `conductor: command not found` persists, make sure
> `~/.bun/bin` is on your `PATH` (restart your shell after installing Bun).
> Prefer not to link globally? Run it directly instead:
> `bun run --cwd packages/cli bin/conductor.ts run dev`.

### Example `.conductor.yml`

```yaml
version: "1"

profiles:
  dev:
    description: "Local development"
    env:
      NODE_ENV: development
    commands:
      - id: db
        name: "PostgreSQL"
        run: docker compose up postgres

      - id: api
        name: "API Server"
        run: npm run dev
        cwd: ./server
        deps: [db]

      - id: web
        name: "Frontend"
        run: npm run dev
        cwd: ./web
        deps: [api]
```

Then:

```bash
conductor run dev          # starts db → api → web, in order
conductor logs --follow    # tail everything in real-time
conductor ps                # see what's running
```

---

## Dependency Management & Health Checks

Conductor ensures services start in the correct order and only when their dependencies are ready:

### Dependency Resolution

Use the `deps` field to declare which services must start before a command runs:

```yaml
commands:
  - id: postgres
    name: "PostgreSQL Database"
    run: docker compose up -d postgres

  - id: api
    name: "API Server"
    run: npm run dev
    deps: [postgres] # waits for postgres to be healthy
    cwd: ./api

  - id: web
    name: "Frontend"
    run: npm run dev
    deps: [api] # waits for api to be healthy
    cwd: ./web
```

**Key behaviors:**

- Services with unmet dependencies won't start — they'll error immediately
- Exit code 0 counts as success (even for fire-and-forget scripts)
- Services are polled every 100ms; if a dependency fails, dependents fail too
- If a dependency never becomes ready within 60 seconds, the start fails

### Health Checks

By default, Conductor waits for a process to spawn. Use `healthcheck` to wait for actual readiness:

```yaml
- id: db
  name: "PostgreSQL"
  run: docker compose up postgres
  healthcheck:
    type: port # wait for port 5432 to accept connections
    port: 5432
    interval_ms: 1000 # probe every 1 second
    retries: 30 # try for ~30 seconds
    timeout_ms: 30000

- id: api
  name: "API Server"
  run: npm run dev
  deps: [db]
  healthcheck:
    type: http # wait for HTTP 2xx/3xx response
    url: "http://localhost:3000/health"
    interval_ms: 500
    retries: 30
```

**Health check types:**

- `port` — TCP connection succeeds
- `http` — HTTP endpoint responds with status < 500
- `command` — shell command exits with code 0
- `none` (default) — just wait for process to spawn

**Status display** (`conductor ps` and the dashboard):

- **Running** — process is active
- **Healthy** — process has passed its health check
- **Stopped** — process exited gracefully (code 0)
- **Failed** — process exited with error (code ≠ 0)

---

## Process Lifecycle

### Graceful Shutdown

By default, Conductor sends `SIGTERM` and waits 5 seconds for graceful shutdown:

```yaml
- id: api
  run: npm run dev
  stop_signal: SIGTERM # default
  stop_timeout_ms: 5000 # wait 5 seconds, then force-kill
```

If the process doesn't exit in time, Conductor sends `SIGKILL` to force termination.

### Custom Stop Commands

For complex services (e.g., Docker Compose), use `stop_command`:

```yaml
- id: services
  run: docker compose up
  stop_command: docker compose down # runs this to shut down cleanly
  stop_timeout_ms: 5000
```

---

## Web Dashboard

Conductor ships with an optional real-time web UI:

```bash
bun run --cwd packages/core dev   # backend API on :4000
bun run --cwd packages/ui dev     # dashboard on :3000
```

The dashboard shows live process status, CPU/memory graphs, and lets you
start/stop commands without touching the terminal.

---

## Desktop App

Don't want to touch the terminal at all? Conductor also ships as a
standalone desktop app (Electron) that bundles the API server and the
dashboard into one installable application — no Bun install required.

**Download:** grab the latest installer for your OS from the
[Releases page](https://github.com/PhantomDave/conductor/releases)
(`.dmg`/`.zip` for macOS, `.exe` for Windows, `.AppImage`/`.deb` for Linux).
The app checks for updates automatically on launch.

Under the hood, the desktop app spawns a compiled Bun "sidecar" binary
(the same core engine used by the CLI) and points an Electron window at it
— so it behaves identically to `conductor run`, just packaged for
double-click installation. Your config and process history live in your OS
user-data directory, so they persist across app updates.

To build/run the desktop app from source:

```bash
bun run dev:desktop     # builds sidecar + UI, launches Electron in dev mode
bun run build:desktop   # produces a distributable installer in packages/desktop/out
```

---

## Project Structure

This is a Bun-based monorepo:

```
conductor/
├── packages/
│   ├── core/     # Backend engine: config, executor, logger, SQLite, HTTP API
│   ├── cli/      # `conductor` command-line tool
│   ├── ui/       # React + Vite + Mantine dashboard
│   └── desktop/  # Electron shell (sidecar + dashboard, packaged via GitHub Releases)
├── examples/     # Sample .conductor.yml configs for common stacks
├── docs/         # Documentation source
└── .conductor.example.yml
```

## Tech Stack

| Layer         | Tech                                                                     |
| ------------- | ------------------------------------------------------------------------ |
| Runtime       | [Bun](https://bun.sh)                                                    |
| Config        | YAML + [Zod](https://zod.dev)                                            |
| Database      | SQLite (`bun:sqlite`)                                                    |
| HTTP API      | [Fastify](https://fastify.dev)                                           |
| CLI           | [Commander](https://github.com/tj/commander.js)                          |
| Frontend      | React 19 + [Vite](https://vitejs.dev)                                    |
| UI Components | [Mantine](https://mantine.dev)                                           |
| Charts        | [Recharts](https://recharts.org) / Mantine Charts                        |
| Logging       | [Pino](https://getpino.io)                                               |
| Desktop       | [Electron](https://electronjs.org) + electron-builder / electron-updater |

See [CONDUCTOR.md](CONDUCTOR.md) for the full architecture & design spec.

---

## Development

```bash
bun install

# Run each package in dev mode (separate terminals)
bun run --cwd packages/core dev
bun run --cwd packages/ui dev
bun run --cwd packages/cli dev -- run dev

# Type-check everything
bun run typecheck

# Run tests
bun test
```

---

## Roadmap

- [x] Core config engine + YAML validation
- [x] Command executor with dependency resolution
- [x] CLI (`run`, `list`, `ps`, `logs`, `env`, `config validate`)
- [x] SQLite persistence (history, logs, metrics, audit log)
- [x] Fastify HTTP API + SSE log streaming
- [x] React + Mantine dashboard skeleton
- [x] Standalone desktop app (Electron, auto-updates via GitHub Releases)
- [ ] Full WebSocket/SSE live log wiring in the UI
- [ ] Process CPU/memory metrics collection
- [ ] Community template registry
- [ ] Standalone CLI binary distribution (npm, Homebrew)

---

## Contributing

Conductor is fully open source (MIT) and welcomes contributions of all
kinds — bug fixes, docs, new examples, or entirely new features. Check the
issues tab for `good first issue` labels, or open a discussion to propose
something bigger.

## License

[MIT](LICENSE) — free to use, modify, and distribute.
