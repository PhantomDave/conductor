# 🎼 Conductor

**Universal task runner & real-time dashboard for developers**

Run your entire dev stack — databases, servers, workers — with one command.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/runtime-bun-f472b6)](https://bun.sh)
[![Status: beta](https://img.shields.io/badge/status-beta-orange)]()

## Why Conductor?

Starting a dev environment usually means juggling five terminal tabs, a half-remembered shell script, and hoping nobody forgot to start the database first. Conductor replaces that with one declarative YAML file and one command:

```bash
conductor run dev
```

- **Dependency-aware** — start services in the right order, waits for health checks to pass
- **Smart process management** — distinguishes between running and healthy; graceful stop with SIGKILL fallback
- **Secret-safe** — sensitive env vars are masked in logs and UI by default
- **Cross-platform** — Linux, macOS, and Windows, all first-class
- **Shareable** — commit `.conductor.yml` and your whole team gets the same setup

## Quick Start

```bash
# 1. Clone & install
git clone https://github.com/PhantomDave/conductor.git
cd conductor
bun install

# 2. Link the CLI globally
bun run link:cli

# 3. Create a .conductor.yml in your project
cp .conductor.example.yml .conductor.yml
# — or write one from scratch (see below) —

# 4. Run it
conductor run dev
```

> `bun run link:cli` symlinks the `conductor` binary into `~/.bun/bin`. If `conductor: command not found` persists, restart your shell after installing Bun. Prefer not to link globally? Run directly: `bun run --cwd packages/cli bin/conductor.ts run dev`.

### Example `.conductor.yml`

Root-level commands + profiles that reference them by `command_ids`:

```yaml
version: "1"
name: "MyApp Full-Stack"
description: "Local development environment"

base_path: "."
global_env:
  LOG_LEVEL: info

commands:
  - id: postgres
    name: "PostgreSQL"
    run: docker compose up postgres
    healthcheck:
      type: port
      port: 5432
      interval_ms: 1000
      timeout_ms: 30000
      retries: 30

  - id: api
    name: "API Server"
    run: npm run dev
    cwd: ./api
    deps: [postgres]
    healthcheck:
      type: http
      url: "http://localhost:3001/health"
      interval_ms: 500
      timeout_ms: 30000
      retries: 30

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

profiles:
  dev:
    description: "Local development"
    env:
      NODE_ENV: development
      API_URL: "http://localhost:3001"
    command_ids: [postgres, api, web]
```

Then:

```bash
conductor run dev          # starts postgres → api → web, in order
conductor ps                # see what's running
conductor logs --follow    # tail everything in real-time
```

## Configuration Reference

Conductor configs are YAML files starting at the root with two top-level sections:

- **`commands`** (array of root-level command definitions) — `id` is required, `name`/`description`/`run` are required for execution. See [CONFIG.md](./docs/CONFIG.md) for the full schema.
- **`profiles`** (object keyed by profile name) — each has `env`, `description`, and `command_ids` (references to root commands).

## CLI Commands

| Command | Description |
| --- | --- |
| `conductor run <profile> [command]` | Start a profile's commands in dependency order |
| `conductor configure [profile] [-f]` | Auto-compile `.env` / `appsettings.json` from `.example` templates |
| `conductor list [profile]` | List profiles or commands within a profile |
| `conductor config validate [file]` | Validate a YAML config against the schema |
| `conductor env get <profile> <key>` | Read an env var (from `.env.<profile>.local`) |
| `conductor env set <profile> <key> <val>` | Write an env var into `.env.<profile>.local` |
| `conductor ps` | List all running processes (hits API at :4000) |
| `conductor logs [--follow]` | View process logs (stub — SQL layer exists, UI wired only) |
| `conductor stop <profile>` | Stub — use Ctrl+C for now |

Full reference: [CLI.md](./docs/CLI.md)

## Health Checks & Status

Conductor tracks **process status** and **health**:

| Status | Meaning |
| --- | --- |
| `starting` | Process spawned, awaiting health check |
| `running` | No explicit healthcheck yet, or polling in progress |
| `healthy` | Health check passed (`port`, `http`, or `command`) |
| `stopped` | Exited gracefully (code 0) |
| `failed` | Exited with error (code ≠ 0) |

Health check types:

| Type | Checks |
| --- | --- |
| `port` | TCP connection succeeds (2 s socket timeout) |
| `http` | HTTP endpoint responds with status < 500 (2 s fetch timeout) |
| `command` | Shell command exits with code 0 |
| `none` | Just wait for process to spawn (default) |

## Web Dashboard

Conductor ships a React + Vite + Mantine dashboard:

```bash
# Backend API (port 4000)
bun run --cwd packages/core dev

# Dashboard (port 3000)
bun run --cwd packages/ui dev
```

The dashboard shows live process status, env var management, command library, notifications, and logs. UI LogViewer wiring to SSE is a work-in-progress (server-side SSE stream exists).

## Desktop App

Electron shell with a compiled Bun sidecar binary:

```bash
bun run dev:desktop     # builds sidecar + UI, launches Electron dev mode
bun run build:desktop   # produces installers in packages/desktop/out
```

The desktop app checks for updates automatically on launch via GitHub Releases. No separate daemon — it runs the engine in-process.

## Roadmap

- ✅ Config engine + YAML validation (Zod)
- ✅ Command executor with dependency resolution
- ✅ CLI (`run`, `configure`, `list`, `config validate`, `env get/set`)
- ✅ SQLite persistence (execution history, logs, env vars, audit log)
- ✅ Fastify HTTP API + SSE log stream
- ✅ React + Mantine dashboard (single page, all panels)
- ✅ Desktop app (Electron 43 + electron-builder, auto-update)
- ✅ Docker Compose import (`POST /api/docker compose/parse`)
- `configure` command — compiles `.env` and `appsettings.json` from `.example` templates
- 🔄 Live log wiring in UI LogViewer via SSE (server-side ready)
- 🔲 Process CPU/memory metrics collection (`packages/core/src/monitor/` empty)
- 🔲 Community template registry
- 🔲 Standalone CLI binary distribution (npm, Homebrew)

## Project Structure

```
conductor/
├── packages/
│   ├── core/    Backend engine: config loader, executor, SQLite, Fastify API
│   ├── cli/     `conductor` CLI (Commander v15)
│   ├── ui/      React 19 + Vite + Mantine 9 dashboard
│   └── desktop/ Electron shell (sidecar + dashboard, auto-update)
├── docs/        Documentation
├── examples/    Example configs (empty — use .conductor.example.yml or guides)
└── .conductor.example.yml
```

## Contributing

Conductor is fully open source (MIT) and welcomes contributions of all kinds — bug fixes, docs, new examples, or entirely new features. Check the issues tab for `good first issue` labels, or open a discussion to propose something bigger.

## License

[MIT](LICENSE) — free to use, modify, and distribute.
