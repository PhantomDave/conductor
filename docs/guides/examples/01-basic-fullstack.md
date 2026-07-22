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

profiles:
  dev:
    description: "Local development with live reload"
    env:
      NODE_ENV: development
      API_URL: "http://localhost:3001"
      DATABASE_URL: "postgresql://user:password@localhost:5432/myapp"

    commands:
      # Database service - starts first, no dependencies
      - id: postgres
        name: "PostgreSQL Database"
        description: "Primary application database"
        run: docker compose up postgres
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
        healthcheck:
          type: http
          url: "http://localhost:3001/health"
          interval_ms: 500
          timeout_ms: 30000
          retries: 30
        stop_timeout_ms: 5000

      # Frontend - waits for API to be ready (for proxying)
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
```

## Running the Application

```bash
# Start the entire stack in order
conductor run dev

# In another terminal, watch logs
conductor logs --follow

# Check what's running
conductor ps

# Example output:
# PID    COMMAND    STATUS     HEALTH      STARTED
# 42123  postgres   running    healthy     2s ago
# 42456  api        running    healthy     1s ago
# 42789  web        running    healthy     0s ago
```

## How It Works

1. **PostgreSQL starts first** — Conductor waits for port 5432 to be responsive
2. **API starts second** — Only after postgres is healthy, Conductor starts the API and waits for `/health` to return a 2xx response
3. **Frontend starts third** — Only after the API is healthy, Conductor starts the frontend and waits for the root URL to respond

If any step fails:

- If postgres fails, the API and web never start
- If the API fails to become healthy, the web never starts
- If the web fails, you'll see an error but postgres and api stay running (for debugging)

## Tips

**Want to restart just the API?**

```bash
conductor restart api
```

The database and frontend stay running. When the API restarts, Conductor waits for its health check again.

**Want to see what went wrong?**

```bash
conductor logs --follow   # tail all services
conductor logs api        # just the API
```

**Want to kill a stuck service?**
The `stop` command sends SIGTERM and waits 5 seconds; if the process doesn't exit, Conductor sends SIGKILL:

```bash
conductor stop api
```

**Custom database?**
Change the `run` command and health check type. For example, with MySQL:

```yaml
- id: mysql
  run: docker compose up mysql
  healthcheck:
    type: port
    port: 3306
```

**Remote database?**
Use the `command` health check to verify connectivity:

```yaml
- id: external-db
  name: "External PostgreSQL"
  run: echo "waiting for external DB" # fire-and-forget
  healthcheck:
    type: command
    command: "pg_isready -h db.example.com -p 5432"
    interval_ms: 1000
```
