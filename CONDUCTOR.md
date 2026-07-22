# Conductor — Universal Task Runner & Dashboard

**Status**: Specification (Ready for MVP implementation)  
**License**: MIT/Apache 2.0 (Fully Open Source)  
**Target**: Developers, DevOps, SRE teams, and anyone running multi-step workflows  
**Community**: Shareable templates, GitHub integration, extensible themes

---

## 🎯 Vision

A **universal, beautiful, community-driven task runner** that makes running complex workflows as simple as:

```bash
conductor run dev  # Execute entire dev stack with live dashboard
```

Works with **any tech stack**. Configurable in **seconds**. Shareable with your team. Open source and self-hosted.

---

## 💡 Why Conductor?

**The Problem**:

- Dev teams scatter knowledge across READMEs, shell scripts, and tribal knowledge
- Running multi-step workflows (DB, server, cache, worker) is tedious and error-prone
- Process monitoring requires jumping between windows
- Teams can't easily share "start dev environment" configs
- Log searching and debugging is painful

**The Solution**:

```bash
# Just run this
conductor run dev

# See real-time:
# ✓ All services starting
# ✓ Live logs with search
# ✓ CPU/memory per process
# ✓ Rich web dashboard (optional)
```

No Docker learning curve. No Kubernetes. Just shell commands + beautiful UX.

---

## 🚀 Core Features (MVP)

### 1. **Command Profiles** (YAML config)

```yaml
# .conductor.yml
profiles:
  dev:
    env:
      NODE_ENV: development
      LOG_LEVEL: debug
    commands:
      - id: db
        name: "PostgreSQL"
        run: docker compose up postgres
      - id: server
        name: "API Server"
        run: npm run dev
        deps: [db]
      - id: worker
        name: "Background Jobs"
        run: npm run worker
```

### 2. **CLI (Primary Interface)**

```bash
conductor run dev              # Start all commands in profile
conductor run dev db           # Start only one command
conductor stop dev             # Graceful shutdown
conductor ps                   # List running processes
conductor logs --follow --grep ERROR
conductor env dev get NODE_ENV
conductor env dev set DEBUG "*"
conductor config validate      # Validate YAML
conductor list                 # Show profiles
```

### 3. **Web Dashboard (Optional, Real-Time)**

- **Process Board**: Live grid of all running commands (status, CPU, memory, elapsed time)
- **Log Viewer**: Real-time logs with search, filter by level/command
- **Command Library**: Run commands with custom env overrides
- **Environment Editor**: Override env vars per profile
- **Metrics Dashboard**: CPU/memory time-series graphs

### 4. **Smart Features**

- **Dependency resolution**: Start services in correct order
- **Graceful shutdown**: SIGTERM → wait 30s → SIGKILL
- **Secret masking**: Hide API keys in logs
- **Cross-platform**: Windows (PowerShell), macOS (bash), Linux (bash/sh)
- **Hot reload**: Auto-restart on file changes (optional)
- **Execution history**: SQLite audit log of all runs

### 5. **Community & Sharing**

- **Conductor Registry**: Share `.conductor.yml` templates with your team
- **GitHub Actions**: Native integration (run `conductor` in CI)
- **Extensible**: Themes, custom UI components (Phase 2)

---

## 🏗️ Architecture

```
conductor/
│
├── @conductor/core (Bun backend)
│   ├── Config Engine
│   │   └── YAML parser + zod validation
│   ├── Environment Manager
│   │   └── Profile switching + secret masking
│   ├── Command Executor
│   │   └── Queue (serial/parallel) + graceful shutdown
│   ├── Process Monitor
│   │   └── CPU/memory polling + time-series storage
│   ├── Logger
│   │   └── Structured logging (pino) → SQLite + stdout
│   ├── Database Layer
│   │   └── SQLite with bun:sqlite (native bindings)
│   └── HTTP API + Server-Sent Events (SSE)
│       ├── WebSocket for real-time log streaming
│       ├── REST for commands/metrics
│       └── CORS (localhost:3000 by default)
│
├── @conductor/cli (Bun executable)
│   ├── run <profile> [<command>]
│   ├── list [<profile>]
│   ├── ps
│   ├── logs [--follow] [--grep] [--level]
│   ├── config validate
│   ├── env <profile> get|set
│   └── stop <profile>
│
├── @conductor/ui (React + Vite, run with `bun --bun`)
│   ├── pages: Dashboard, Logs, Commands, Metrics, Settings
│   ├── components: ProcessBoard, LogViewer, EnvironmentEditor
│   ├── state: TanStack Query + Zustand
│   ├── realtime: SSE + optional WebSocket
│   └── theme: Light/dark Mantine theme customization
│
└── Config Files (YAML)
    ├── .conductor.yml          — project config + commands
    ├── .conductor.profiles.yml — environment profiles
    └── .env.*.local (git-ignored) — user overrides
```

---

## ⚙️ Tech Stack (Final)

| Component          | Tech                                 | Rationale                                                 |
| ------------------ | ------------------------------------ | --------------------------------------------------------- |
| **Runtime**        | Bun 1.1+                             | Fast startup, built-in bundler, modern, ↑50% perf vs Node |
| **Config**         | YAML + zod                           | Human-readable, typed validation                          |
| **Database**       | SQLite (bun:sqlite)                  | Embedded, zero ops, native Bun support                    |
| **Logging**        | pino (Bun-optimized)                 | Structured, fast, works great with Bun                    |
| **CLI**            | oclif (works on Bun)                 | Commands, plugins, help system                            |
| **HTTP**           | Fastify (Bun-compatible)             | Type-safe, minimal overhead, SSE/WS                       |
| **Realtime**       | Server-Sent Events (SSE) + WebSocket | Efficient log streaming                                   |
| **Frontend**       | React 19 + Vite (Bun)                | Vite + Bun = instant startup, hot reload                  |
| **Routing**        | TanStack Router                      | Type-safe, lightweight                                    |
| **State**          | TanStack Query + Zustand             | Server state + client state                               |
| **UI**             | Mantine                              | Polished, accessible, dark mode                           |
| **Terminal**       | xterm.js                             | Battle-tested terminal emulation                          |
| **Charts**         | Recharts                             | Lightweight, React-friendly                               |
| **Process/Shells** | Cross-platform shell handling        | PowerShell/bash detection + safety                        |

### Why Bun for This Project?

**Bun 1.1+** is the ideal choice for Conductor:

- **Fast startup**: CLI startup is <50ms (vs ~300ms with Node.js) — matters for dev experience
- **Built-in bundler**: No webpack/esbuild config needed for CLI or server
- **Native SQLite**: `bun:sqlite` is fastest Node.js SQLite binding (pure Bun native)
- **Zero-config Vite**: `bun --bun` runs Vite with Bun's bundler → instant HMR
- **Excellent TypeScript**: Native transpilation, no tsc step needed
- **Better package manager**: `bun install` is 5-10x faster than npm/yarn
- **Modern + opinionated**: Aligns with open-source project positioning
- **Great DX**: Test runner, formatter, bundler all included

All key dependencies work on Bun: Fastify, pino, zod, oclif, React, Vite, Recharts ✓

**Trade-off**: ~2% of npm packages incompatible, but all Conductor deps are solid. Any issues can be addressed with fallbacks.

---

## 📋 Configuration Schema

### `.conductor.yml`

```yaml
version: "1"

# Metadata (for registry/discovery)
name: "My Project"
description: "Full-stack web app development environment"
author: "your-github-handle"
keywords: [dev, docker, node, postgres]
tags: [fullstack, nodejs, react]

# Security
env_secrets:
  - AWS_SECRET_ACCESS_KEY
  - DATABASE_PASSWORD
  - API_TOKEN
  - STRIPE_KEY

# Global env (inherited by all profiles)
global_env:
  LOG_LEVEL: info
  SHELL: /bin/bash

# Profiles
profiles:
  dev:
    description: "Local development"

    env:
      NODE_ENV: development
      LOG_LEVEL: debug
      API_URL: http://localhost:3000

    commands:
      - id: postgres
        name: "PostgreSQL"
        description: "Start PostgreSQL container"
        run: docker compose up postgres
        cwd: "."
        shell: true

      - id: redis
        name: "Redis"
        run: docker compose up redis

      - id: api
        name: "API Server"
        run: npm run dev
        cwd: "./server"
        shell: true
        deps: [postgres, redis]
        env_overrides:
          PORT: 3001
        watch: [src/**/*.ts] # Auto-restart on changes

      - id: worker
        name: "Background Worker"
        run: npm run worker
        cwd: "./server"
        deps: [postgres, redis]

      - id: web
        name: "React Frontend"
        run: npm run dev
        cwd: "./web"
        env_overrides:
          VITE_API_URL: http://localhost:3001
        deps: [api]

  prod:
    description: "Production monitoring (read-only)"
    env:
      NODE_ENV: production
    commands:
      - id: health
        name: "Health Check"
        run: curl -s https://api.example.com/health | jq .
        readonly: true
```

---

## 🚀 Implementation Plan

### Phase 1: Core Backend + CLI (5–6 days)

1. **Monorepo Setup**
   - `bun workspaces` for `@conductor/core`, `@conductor/cli`, `@conductor/ui`
   - Shared TypeScript config + types
   - Testing setup (bun:test + optional vitest)

2. **Config Engine** (`@conductor/core/src/config/`)
   - YAML parser with js-yaml
   - zod schema validation
   - Profile manager + env merge
   - Secret masking

3. **Environment Manager** (`@conductor/core/src/env/`)
   - `.env.{profile}.local` loader
   - Variable interpolation (`${VAR}`)
   - Cross-platform shell detection

4. **Command Executor** (`@conductor/core/src/executor/`)
   - spawn queue (serial/parallel modes)
   - ProcessWrapper (stdout/stderr capture)
   - Graceful shutdown (SIGTERM → 30s → SIGKILL)
   - Dependency resolution
   - File watcher for hot-reload

5. **Logger** (`@conductor/core/src/logger/`)
   - pino structured logging
   - Secret masking filter
   - SQLite + stdout output

6. **Database Layer** (`@conductor/core/src/db/`)
   - SQLite schema:
     - `execution_history` (id, command_id, profile, start_time, end_time, exit_code)
     - `logs` (id, process_id, timestamp, level, message)
     - `process_metadata` (pid, command_id, profile, created_at, ended_at)
     - `process_metrics` (pid, timestamp, cpu_percent, memory_bytes)
     - `audit_log` (timestamp, action, actor, details)
   - Migrations + initialization

7. **HTTP API** (`@conductor/core/src/api.ts`)
   - Fastify server
   - REST endpoints:
     - `POST /api/commands/:id/execute` — run command
     - `GET /api/processes` — list running
     - `DELETE /api/processes/:pid` — stop process
     - `GET /api/processes/:pid/metrics` — time-series
   - Server-Sent Events (SSE) for logs
   - WebSocket upgrade for real-time updates
   - CORS configured for local frontend

8. **CLI** (`@conductor/cli/src/`)
   - oclif framework
   - Commands:
     - `conductor run <profile> [<command>]`
     - `conductor list [<profile>]`
     - `conductor ps`
     - `conductor logs [--follow] [--grep] [--level]`
     - `conductor config validate`
     - `conductor env <profile> get|set`
     - `conductor stop <profile>`
   - Default: show help + list profiles

### Phase 2: Frontend Web UI (4–5 days)

1. **Vite + React Setup**
   - `packages/@conductor/ui`
   - TypeScript + Mantine
   - Dark/light theme toggle

2. **Pages & Components**
   - `/` (Dashboard)
     - **ProcessBoard**: Live grid (status, CPU, memory, elapsed time)
     - Quick actions: restart, stop, view logs
   - `/commands` (Command Library)
     - Search by name/profile
     - Run with custom env overrides
   - `/logs` (Log Viewer)
     - Real-time SSE stream
     - Filter by level, command, process
     - Search + export
   - `/metrics` (Metrics Dashboard)
     - CPU/memory time-series (Recharts)
     - Date range picker
     - CSV export
   - `/settings` (Configuration)
     - Theme switcher
     - API connection status
     - Keyboard shortcuts

3. **State Management**
   - **TanStack Query**: server state (processes, logs, metrics)
   - **Zustand**: client state (active profile, filters, theme)

4. **Realtime Integration**
   - SSE client for log streaming
   - WebSocket for process events (optional upgrade)
   - Auto-reconnect with exponential backoff

5. **Accessibility & Polish**
   - Keyboard shortcuts (Cmd/Ctrl+K for search)
   - Copy to clipboard for commands
   - Responsive design (mobile-friendly)
   - Proper ARIA labels

### Phase 3: Process Monitoring & Metrics (2–3 days)

1. **Metrics Collection** (`@conductor/core/src/monitor/`)
   - Poll processes every 5 seconds
   - Extract: CPU %, RSS memory, uptime
   - Store in SQLite (24h retention by default)

2. **Metrics API**
   - `GET /api/processes/:pid/metrics?from=ISO8601&to=ISO8601`
   - Returns time-series JSON

3. **Frontend Charts**
   - Recharts LineChart (CPU%) + AreaChart (memory)
   - Auto-refresh while process active

---

## 🎨 Design & UX

### Visual Identity

**Color Palette** (Mantine defaults + customization):

- Primary: Indigo/Teal (professional, accessible)
- Status: Green (running), Yellow (paused), Red (error), Gray (stopped)
- Backgrounds: Clean, minimal, high contrast for logs

**Typography**:

- Clean sans-serif (system fonts preferred)
- Monospace for commands/logs (Monaco, Menlo, Courier New)

### Theming

Users can create custom themes:

```js
// .conductor/theme.js
export default {
  colors: {
    primary: "#6366f1",
    error: "#ef4444",
    success: "#22c55e",
  },
  fonts: {
    body: "Inter, sans-serif",
    mono: "Fira Code, monospace",
  },
};
```

### Keyboard Shortcuts

- `Cmd/Ctrl+K`: Search/command palette
- `Cmd/Ctrl+L`: Clear logs
- `Space`: Pause/resume process
- `X`: Stop process
- `R`: Restart process
- `T`: Toggle dark mode

---

## 📦 Community & Extensibility

### Registry

```bash
# Share your template
conductor publish my-project

# Use someone else's
conductor init my-project --from=user/my-project-template
```

Registry hosted on GitHub (no central server—just YAML files + GitHub releases).

### GitHub Actions Integration

```yaml
# .github/workflows/test.yml
- uses: davestools/conductor@v1
  with:
    profile: test
    command: run-tests
```

Or just call the CLI:

```bash
conductor run test
```

---

## ✅ MVP Scope

### Included

- ✅ Execute arbitrary shell commands
- ✅ Multi-environment profiles (dev, staging, prod)
- ✅ Capture + persist logs (SQLite + realtime)
- ✅ Environment variable management + secret masking
- ✅ Process monitoring (CPU, memory, uptime)
- ✅ Graceful shutdown + dependency resolution
- ✅ CLI (primary) + Web UI (secondary)
- ✅ Cross-platform (Windows, macOS, Linux)
- ✅ Execution history + audit log
- ✅ Theme customization (light/dark)
- ✅ Community templates (Registry)

### Phase 2+

- 🔲 Plugin system (custom commands/extensions)
- 🔲 Role-based access control (multi-user backend)
- 🔲 Vault integration (HashiCorp Vault, AWS Secrets Manager)
- 🔲 Kubernetes integration
- 🔲 Distributed deployment (clustering)
- 🔲 Scheduled jobs / cron
- 🔲 AI-powered log analysis
- 🔲 Desktop app (Tauri)
- 🔲 Helm charts / Docker images
- 🔲 VS Code extension

---

## 📖 Documentation Strategy

### Website (conductor.sh, built with Astro/Docusaurus)

1. **Getting Started**
   - Installation (npm, Homebrew, standalone binary)
   - 5-minute quick start (Docker example)
   - YAML config walkthrough

2. **Guides**
   - Running Node.js stacks
   - Running Docker Compose
   - Running .NET projects
   - Running Python apps
   - Multi-language monorepos
   - CI/CD integration

3. **API Reference**
   - Config schema (searchable)
   - CLI commands
   - HTTP endpoints

4. **Examples**
   - Full-stack Node.js (React + Express + Postgres)
   - Python + Django + Celery
   - .NET + Entity Framework
   - Monorepo (Nx, Turborepo)
   - Microservices (Docker Compose)

5. **Community**
   - Template gallery
   - Showcase (projects using Conductor)
   - Contributing guide
   - Roadmap

---

## 🎯 Naming Options

(You asked for catchy names—here are a few):

| Name          | Vibe                    | .sh Domain   | GitHub               |
| ------------- | ----------------------- | ------------ | -------------------- |
| **Conductor** | Orchestrates everything | conductor.sh | davestools/conductor |
| **Orbit**     | Runs things smoothly    | orbit.dev    | davestools/orbit     |
| **Relay**     | Passes commands through | relay.dev    | davestools/relay     |
| **Beacon**    | Guides your workflows   | beacon.sh    | davestools/beacon    |
| **Palette**   | Mix & match commands    | palette.dev  | davestools/palette   |
| **Crew**      | Collaborative runner    | crew.sh      | davestools/crew      |

_My pick: **Conductor** — clear intent, professional, easy to remember._

---

## ✅ Verification Checklist

### Phase 1

- [ ] `conductor config validate .conductor.yml` ✓
- [ ] `conductor run dev db` ✓ (process tracked, logs stored)
- [ ] `conductor logs --follow --grep ERROR` ✓ (real-time filtered)
- [ ] `conductor ps` ✓ (shows running processes)
- [ ] `conductor env dev get NODE_ENV` ✓
- [ ] `conductor env dev set DEBUG "*"` ✓

### Phase 2

- [ ] Backend API running on :4000
- [ ] Frontend on :3000 (Vite dev server)
- [ ] ProcessBoard shows active processes
- [ ] WebSocket/SSE logs update in real-time
- [ ] Command execution from UI works

### Phase 3

- [ ] Metrics collected every 5s
- [ ] CPU/memory graphs render correctly
- [ ] Date range filtering works
- [ ] CSV export downloads

---

## 📂 File Structure (Monorepo)

```
conductor/
├── packages/
│   ├── @conductor/core/
│   │   ├── src/
│   │   │   ├── config/
│   │   │   │   ├── loader.ts
│   │   │   │   ├── schema.ts
│   │   │   │   └── validator.ts
│   │   │   ├── env/
│   │   │   │   ├── loader.ts
│   │   │   │   └── masker.ts
│   │   │   ├── executor/
│   │   │   │   ├── queue.ts
│   │   │   │   ├── wrapper.ts
│   │   │   │   └── shutdown.ts
│   │   │   ├── logger/
│   │   │   │   ├── pino.ts
│   │   │   │   └── masking.ts
│   │   │   ├── db/
│   │   │   │   ├── schema.sql
│   │   │   │   ├── migrations.ts
│   │   │   │   └── queries.ts
│   │   │   ├── monitor/
│   │   │   │   └── metrics.ts
│   │   │   ├── api.ts
│   │   │   ├── ws.ts
│   │   │   └── index.ts
│   │   ├── bin/server.js
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── @conductor/cli/
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   │   ├── run.ts
│   │   │   │   ├── list.ts
│   │   │   │   ├── logs.ts
│   │   │   │   ├── ps.ts
│   │   │   │   ├── config.ts
│   │   │   │   ├── env.ts
│   │   │   │   └── stop.ts
│   │   │   ├── client.ts
│   │   │   └── index.ts
│   │   ├── bin/conductor.js
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── @conductor/ui/
│       ├── src/
│       │   ├── pages/
│       │   │   ├── Dashboard.tsx
│       │   │   ├── Commands.tsx
│       │   │   ├── Logs.tsx
│       │   │   ├── Metrics.tsx
│       │   │   └── Settings.tsx
│       │   ├── components/
│       │   │   ├── ProcessBoard.tsx
│       │   │   ├── LogViewer.tsx
│       │   │   ├── CommandForm.tsx
│       │   │   └── Layout.tsx
│       │   ├── hooks/
│       │   │   ├── useProcesses.ts
│       │   │   ├── useLogs.ts
│       │   │   └── useMetrics.ts
│       │   ├── lib/
│       │   │   ├── api.ts
│       │   │   ├── sse.ts
│       │   │   ├── ws.ts (optional)
│       │   │   └── types.ts
│       │   └── App.tsx
│       ├── public/
│       ├── vite.config.ts
│       ├── index.html
│       ├── tailwind.config.js
│       ├── package.json
│       └── tsconfig.json
├── docs/ (website content)
│   ├── getting-started.md
│   ├── guides/
│   ├── api-reference.md
│   └── examples/
├── examples/
│   ├── nodejs-fullstack/
│   ├── docker compose/
│   └── monorepo/
├── .github/
│   └── workflows/ (CI/CD)
├── .conductor.example.yml
├── package.json (root workspaces)
├── tsconfig.json
├── prettier.config.js
├── eslint.config.js
├── vitest.config.ts
├── .gitignore
├── LICENSE (MIT)
└── README.md
```

---

## 🔑 Key Design Decisions

1. **CLI-first, UI-optional**: Developers use `conductor run` without opening browser. Dashboard is a bonus.
2. **YAML config**: Human-readable, git-trackable, no database required for config.
3. **SQLite**: Zero-ops database perfect for single-machine dev tools.
4. **Fastify**: Modern, type-safe, excellent for both REST + streaming.
5. **Vite + React**: Fast dev experience, minimal overhead, great for internal tools.
6. **Mantine**: Polished components out-of-the-box; less DIY than shadcn.
7. **Secret masking**: Critical—track sensitive keys, mask before ANY log output.
8. **Community registry**: Shareable templates stored as GitHub releases (no central server).
9. **Cross-platform**: Same CLI/config on Windows, macOS, Linux with adaptive shell handling.
10. **Graceful shutdown**: SIGTERM + 30s wait + SIGKILL ensures clean termination.

---

## 🤝 Open Source & Community

### License

MIT or Apache 2.0 (your choice)

### Contributing

- Fork + PR welcome
- Good first issues tagged
- Discussions for RFC features
- Monthly releases (end of month)

### Code of Conduct

Follows Contributor Covenant v2.1

---

## 🚀 Getting Started (Developer Preview)

```bash
git clone https://github.com/davestools/conductor
cd conductor

# Install dependencies
bun install

# Start backend dev server
bun run dev --workspace=@conductor/core

# In another terminal, start frontend
bun run dev --workspace=@conductor/ui

# In another terminal, use the CLI
bun run --workspace=@conductor/cli -- run dev

# Visit dashboard
open http://localhost:3000
```

---

## 📞 Questions Answered (FAQ in Spec)

1. **CLI packaging**: `npm install -g @conductor/cli`, Homebrew, or standalone binary via `pkg` (Phase 2).
2. **Backend daemon**: Start on-demand per `conductor run` command. Stays alive during workflow.
3. **Config discovery**: Auto-discover `.conductor.yml` in current/parent dirs (ESLint-style).
4. **Multi-project**: Single runner manages multiple projects' configs (–-config flag).
5. **Health checks**: Port checks or generic readiness probe for dependency resolution.
6. **Windows**: Full PowerShell support, auto-detect shell.
7. **Theme**: Light/dark toggle + custom theme override support.
8. **Registry**: GitHub-based registry (files in `davestools/conductor-templates` org).

---

**Status**: ✅ **Specification complete. Ready for Phase 1 implementation.**
