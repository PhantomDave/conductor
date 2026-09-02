# Architecture Guide

## Purpose

This document describes how Conductor is organised internally — packages, data flow, process lifecycle, and storage layout — for contributors who need to make or review changes to the engine.

All source lives in the monorepo under `packages/`: core, cli, ui, desktop. Below are the key design decisions and their rationale.

## Repository Layout

```
conductor/
├── packages/core/src/                Backend engine
│   ├── config/                       Config loader + schema + store (mutable)
│   │   ├── loader.ts                 Read .conductor.yml from disk
│   │   ├── schema.ts                 Zod validation for the full schema
│   │   ├── store.ts                  In-memory mutable state; helpers for every mutation
│   │   ├── writer.ts                 Persist changed config back to disk
│   │   ├── env-resolution.ts         Variable merge order (global → profile → command)
│   │   └── example-compiler.ts       compileConfigExamples: .env/.appsettings templates
│   ├── env/                          Secret masking and interpolation
│   │   └── masker.ts                 interpolateString + looksSecret for [FILTERED]
│   ├── db/                           SQLite persistence
│   │   ├── schema.sql                CREATE TABLE statements
│   │   ├── init.ts                   Create tables IF NOT EXISTS on startup
│   │   └── queries.ts                ConductorQueries class (log/metric/env/audit helpers)
│   ├── logs/                         SSE broadcasting
│   │   └── broadcaster.ts            PubSub for log lines per PID + heartbeat keep-alives
│   ├── docker-compose/               Docker compose YAML parser → command suggestions
│   │   └── parser.ts                 parseDockerCompose → CommandSchema objects
│   ├── executor/                     StartOne, restartOne, stop, monitoring
│   │   ├── queue.ts                  SpawnQueue (start/restart/snapshot/list)
│   │   ├── wrapper.ts                ProcessWrapper (PID, killTree, status transitions)
│   │   ├── healthcheck.ts            checkPort / checkHttp implementations
│   │   └── shell.ts                  resolveShell fallback → $SHELL or %COMSPEC%
│   ├── monitor/                      (stub — not wired yet; roadmap for CPU/metrics)
│   ├── api.ts                        Fastify 5 HTTP server (~876 lines)
│   └── index.ts                      15-line barrel export
├── packages/cli/src/                 CLI commands (Commander v15)
│   ├── config-context.ts             CLI → config store bridge
│   └── commands/                     run | configure | list | config validate | env | ps | logs | stop
├── packages/ui/src/                  React 19 + Vite + Mantine 9 dashboard
│   ├── pages/Dashboard.tsx           Only UI page (all panels in one view)
│   ├── components/                   CommandForm, ProcessBoard, LogViewer, etc.
│   ├── hooks/                        useProcesses, useProfiles, useEnvVars, useNotifications, etc.
│   └── lib/                          ansi.tsx, api.ts helpers
├── packages/desktop/main.ts          Electron 43 shell: compiles sidecar + serves UI (CONDUCTOR_UI_DIST)
└── ... (CI workflows, docs, config examples, etc.)
```

## Core Engine — Data Flow

### Config Loading → Store → Persistence

```
.conductor.yml ──loader────▶ Zod validate(schema)──▶ store.ts (in-memory reactive map)
                                                                    │
                                    mutateVia(store helper methods) │
                                     write: writer.ts              │
                                         disk-sync via bun:fssync  │
                                         audit log on every change ▶  sqlite:audit_log
```

Store provides these mutators for everything that changes the config graph: `addCommand`, `removeCommand`, `updateCommand`, `addCommandToProfile`, `removeCommandFromProfile`, `duplicateCommand`, `addProfile`, `removeProfile`, `updateProfile`, `duplicateProfile`, `getProfileCommands`. There is also `setBasePath`, `getResolvedBasePath`, `setDefaultShell`, `importConfig`, `compileConfigExamples`, and `refreshEnv`. Every mutation writes to SQLite's audit_log table.

### Process Execution Flow

```
run <profile> (CLI) or POST /api/profiles/:profile/run (API)
        │
        ▼
resolve active profile from store
        │  (profiles.dev.command_ids → fetch root commands by id)
        ▼
build dependency graph
        │  (commands[].deps → topological sort, recursive deps-first)
        ▼
for target in dep-sorted order:
    startOne(targetId, onLog)
        │── resolveShell(default_shell from config → $SHELL or %COMSPEC%)
        │── startOne(depId, ...) recursively if deps exist (base case: no deps → spawn)
        │── Create ProcessWrapper for PID
        │── pipe stdout/stderr → ConductorQueries.insertLog() + broadcaster.broadcast(pid, line)
        │── healthcheck? (port|http|command|none): poll interval_ms until timeout_ms or retries exhausted
        │── transition: starting → running → healthy/stopped/failed
```

### ProcessWrapper Lifecycle

Each spawned process is wrapped in `ProcessWrapper` which tracks: pid, status, exitCode. KillTree uses negative PID on POSIX (process-group kill) and taskkill /pid /T on Windows. After killing, waitForGroupDeath waits up to the configured timeout_ms then escalates to SIGKILL if still alive. Status transitions are starting → running → healthy/stopped/failed.

### Health Check Types

| Type    | Implementation                                          | Timeout            | Success Criteria                               |
| ------- | ------------------------------------------------------- | ------------------ | ---------------------------------------------- |
| port    | `node:net` socket connect probe on specified port       | 2 s socket timeout | TCP connection succeeds within timeout         |
| http    | native fetch with AbortSignal.timeout(2000) to full URL | 2 s fetch timeout  | response.status < 500                          |
| command | Shell execution via resolveShell                        | Per config         | Exit code === 0                                |
| none    | Immediate success after spawn                           | N/A                | Process successfully spawned in starting state |

### SSE Log Streaming

The broadcaster at `packages/core/src/logs/broadcaster.ts` uses a pub/sub pattern keyed by log entry metadata. Every log write from ProcessWrapper goes through `broadcaster.publish(entry)`. The endpoint `/api/logs/stream` connects an EventSource; the server replays recent history lines first (with optional filters like `pid`, `commandId`, `profile`) then tails live events. Heartbeats every 15 seconds keep proxies alive (no data frames sent — just silence).

## SQLite Schema Overview

| Table             | Key fields                                                               | Purpose                                                                      |
| ----------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| execution_history | id, command_id, profile, start_time, end_time, exit_code, duration_ms    | Audit of every run attempt per command                                       |
| logs              | id, process_id, command_id, profile, timestamp, level, stream, message   | All captured stdout/stderr + error output; index by command_id and timestamp |
| process_metadata  | pid (composite PK), command_id, profile, created_at, ended_at, exit_code | Snapshot of each started process for recovery & ps queries                   |
| process_metrics   | id, pid, timestamp, cpu_percent, memory_bytes                            | Time-series CPU/memory (schema-ready; monitor/ not wired)                    |
| env_vars          | id (PK), scope, profile, key, value, secret                              | Managed env vars: global or per-profile; kept separate from .conductor.yml   |
| audit_log         | id (PK), timestamp, action, actor, details                               | Every mutation event for auditing/debugging                                  |

## Configuration Store vs Config File

The config file `.conodor.yml` is the **source of truth for persisted configuration**. The in-memory store (`store.ts`) is what the CLI and API both read/write during execution. When CLI starts, it loads from disk into the store; on mutations (e.g. via configure or API PUT), changes are written back to disk synchronously via writer.ts + bun's native fsync API with audit entries written in parallel for history/rollback purposes.

## Configuration File Structure Recap

```yaml
# Root-level fields (single source of truth)
version: "1"
commands:                             # ALL commands live HERE — never nested under profiles.
  - id: api ...
  - id: db ...

# Profiles are selectors only
profiles:
  dev:                                # Named profile containing only env overrides
    description: "Dev mode"           and command_refs (IDs)
    env:
      NODE_ENV: development
    command_ids: [api, db]          # ← IDs reference root-level commands; no duplication here.
```

## Desktop App Architecture (packages/desktop)

The desktop shell is an Electron 43 + electron-builder application that compiles the core engine into a platform-specific sidecar binary (`bun build --compile → dist-bin/conductor-server`). The compiled binary runs the same Fastify API that the Node version exposes on localhost:4000. UI assets are built via Vite to `packages/ui/dist/`. Environment variable `CONDUCTOR_UI_DIST` tells Electron where to load static HTML/UI assets from — this enables serving the dashboard same-origin so the SPA can call `/api/*` without CORS issues (all served by Electron's dev server). Auto-update is handled through electron-builder's GitHub Release integration (`--publish always`). The compiled sidecar binary includes everything needed for `conductor run`, API, SQLite persistence, etc. — no Bun runtime required at install time since it bundles to a native executable.

## Monitoring (stub)

The monitor directory under packages/core/src/monitor is empty and represents the roadmap item for CPU/memory metrics collection: polling process cpu_percent and memory_bytes via `/usr/bin/top` (macOS), `top -bn1` or psutil (Linux), and wmic/process query (Windows). Until wired, GET `/api/processes/:pid/metrics` returns `{ cpu: [], memory: [] }`.

## Testing Strategy

Tests live in `packages/core/test/`: five test files covering config loading/validation, env resolution order, masker secret detection, example-template compile logic, and store mutation helpers (config → example-compiler). The test runner is bun:test which provides native assertion, mocking through globals, and parallel execution.

## CI/CD (.github/workflows)

| Workflow         | When it runs                     | What it does                                                                                                                                                                                      |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`         | Every push / PR to main branches | lint-and-typecheck (format:check + typecheck), test (ubuntu/macos/windows matrix), build (core → cli → ui), cli-smoke-test (cp .conductor.example.yml → .conductor.yml; config validate; run dev) |
| `release.yml`    | On release published             | Per-OS compile of sidecar + electron-builder upload to same GitHub Release                                                                                                                        |
| `dependabot.yml` | Automatic dependency bumps       | Dependabot bot config for Bun ecosystem                                                                                                                                                           |

## CLI vs API Comparison

| Feature                              | Standalone (CLI only — no server)       | With API running                                                          |
| ------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------- |
| run/list/config validate/env get/set | Full functionality via `.conductor.yml` | Same logic, also via REST/HTTP                                            |
| ps                                   | Stub — prints note to Ctrl+C            | Returns process snapshots from Store + SQLite                             |
| logs                                 | API-backed query + SSE follow mode      | SQL-backed query + SSE stream via EventSource API                         |
| stop                                 | POST /api/profiles/:profile/stop        | POST /api/profiles/:profile/stop                                          |
| configure                            | CLI auto-runs before run                | Standalone command `configure [profile] [-f]` via API POST /api/configure |

## Component Communication Pattern

The UI talks to the API exclusively through fetch at localhost:4000. There is no direct database access from the frontend — all mutations pass through Fastify endpoints which write to SQLite and broadcast events. SSE connections use standard EventSource web APIs for log streaming rather than WebSocket or other bespoke protocols like SignalR or Socket.IO.
