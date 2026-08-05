# Example 1: Basic Full-Stack Application

This example shows a typical Node.js full-stack application with:

- PostgreSQL database
- Express API server
- React frontend

## Configuration

Create a `.conductor.yml` in your project root:

```yaml
version: "1"
name: "MyApp Full-Stack"
description: "Local development environment"

base_path: "."
global_env:
  LOG_LEVEL: info

# ── Commands (root level — single source of truth) ────────────
commands:
  # Database service - starts first, no dependencies
  - id: postgres
    name: "PostgreSQL Database"
    description: "Primary application database"
    run: docker compose up -d postgres
    healthcheck:
      type: port
      port: 5432
      interval_ms: 1000
      timeout_ms: 30000
      retries: 30

  # API server - waits for database to be healthy
  - id: api
    name: "API Server"
    description: "Node.js Express API"
    run: npm run dev
    cwd: ./api
    deps: [postgres]
    env_overrides:
      NODE_ENV: development
    healthcheck:
      type: http
      url: "http://localhost:3001/health"
      interval_ms: 500
      timeout_ms: 30000
      retries: 30
    stop_timeout_ms: 5000

  # Frontend - waits for API to be ready
  - id: web
    name: "React Frontend"
    description: "Vite React application"
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

# ── Profiles (selectors referencing commands) ──────────────────
profiles:
  dev:
    description: "Local development with live reload"
    env:
      NODE_ENV: development
      API_URL: "http://localhost:3001"
    command_ids: [postgres, api, web]
```

## Running the Application

```bash
# Start the entire stack in order
conductor run dev

# Check what's running (requires API server on :4000)
conductor ps
```

### Expected `ps` output

```json
[
  {
    "pid": 42123,
    "commandId": "postgres",
    "status": "running",
    "health": "healthy",
    "startedAt": "..."
  },
  {
    "pid": 42456,
    "commandId": "api",
    "status": "running",
    "health": "healthy",
    "startedAt": "..."
  },
  { "pid": 42789, "commandId": "web", "status": "running", "health": "healthy", "startedAt": "..." }
]
```

## How It Works

Commands run from the `dev` profile are `postgres`, `api`, and `web`. Conductor resolves:

1. **PostgreSQL starts first** — no dependencies, so it spawns immediately and waits for port 5432 to accept connections (up to 30 retries)
2. **API starts second** — after postgres is healthy, Conductor runs `npm run dev` from `./api/` and polls `http://localhost:3001/health` every 500 ms
3. **Frontend starts third** — only after the API is healthy, Conductor starts Vite from `./web/`

If any step fails:

- If postgres fails during the healthcheck loop (timeout/retries exhausted), api and web never start; an error is displayed and the process stops.
- If the API fails to become healthy, the web never starts.
- If the web fails, you'll see an error but postgres and api stay running for debugging.

## Tips

**Want to restart just the API?**

```bash
# Via the UI / browser dashboard — search for 'api' in the process board
# (CLI support for per-command `restart` is planned)
```

The database and frontend stay running. When the API restarts via the UI, Conductor waits for its health check again.

**Want to see what went wrong?**

```bash
conductor logs --follow   # tail all services live
# The LogViewer panel in the UI shows full history with per-command filters
```

**Want to kill a stuck service?**

The `stop` command sends SIGTERM and waits 5 seconds; if the process doesn't exit, Conductor sends SIGKILL:

```bash
conductor stop api        # CLI support for graceful shutdown pending
# In UI — click "Stop" on the process card
```

**Custom database?**

Change the `run` command and health check type. For example, with MySQL:

```yaml
- id: mysql
  run: docker compose up -d mysql
  healthcheck:
    type: port
    port: 3306
    interval_ms: 1000
    timeout_ms: 30000
    retries: 30
```

**Remote database?**

Use the `command` health check to verify connectivity:

```yaml
- id: external-db
  name: "External PostgreSQL"
  run: echo "waiting for external DB"
  healthcheck:
    type: command
    command: "pg_isready -h db.example.com -p 5432"
    interval_ms: 1000
```

## Notes on Configuration

- `commands` live at the **root level** — they're global, never nested under profiles.
- The `profiles.dev.command_ids` array tells Conductor which commands to run for the `dev` profile and in what initial order (dependency resolution takes over).
- Environment variables merge in this order: `global_env` → profile `env` → command `env_overrides`.
