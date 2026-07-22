# Conductor Examples & Guides

This folder contains practical examples and guides for using Conductor in various scenarios.

## Quick Links

### [Example 1: Basic Full-Stack Application](./examples/01-basic-fullstack.md)

A simple 3-tier application:

- PostgreSQL database
- Express API server
- React frontend

**Good for:** Learning the basics, simple projects, portfolios

**Key concepts:**

- Dependency declaration (`deps`)
- Health checks (port, HTTP, command)
- Process lifecycle (start, health, stop)

---

### [Example 2: Microservices with Docker Compose](./examples/02-microservices.md)

A realistic microservices platform:

- Message broker & cache (infrastructure)
- Multiple microservices with interdependencies
- API Gateway as orchestration point

**Good for:** Modern architectures, production-like setups, Docker workflows

**Key concepts:**

- Complex dependency graphs
- Docker Compose integration
- Custom stop commands
- Health checks for dockerized services

---

## Common Patterns

### Starting in Dependency Order

```yaml
- id: service-a
  run: ./start-a.sh

- id: service-b
  run: ./start-b.sh
  deps: [service-a] # B only starts after A is healthy

- id: service-c
  run: ./start-c.sh
  deps: [service-a, service-b] # C waits for both A and B
```

### Health Checks

Choose the right type for your service:

| Type      | Good For                   | Example                           |
| --------- | -------------------------- | --------------------------------- |
| `port`    | TCP services, databases    | PostgreSQL, Redis, MongoDB        |
| `http`    | Web servers, APIs          | Express, FastAPI, Go servers      |
| `command` | Anything with a shell test | Custom scripts, docker exec, curl |
| `none`    | Fire-and-forget scripts    | Migrations, setup jobs            |

### Graceful Shutdown

```yaml
- id: api
  run: npm run dev
  stop_signal: SIGTERM # or SIGINT, SIGKILL, etc.
  stop_timeout_ms: 5000 # wait 5 seconds
  stop_command: npm run stop # optional: run cleanup script first
```

The sequence is:

1. Run `stop_command` if configured (with the same timeout budget)
2. Send `stop_signal` to the process
3. Wait up to `stop_timeout_ms`
4. If still alive, send `SIGKILL` to force-terminate

---

## Tips & Tricks

### Restarting a Service

```bash
conductor restart api
```

Stops and starts just that service. Dependencies are left running (they're already healthy). This is fast because Conductor doesn't re-validate the whole chain.

### Viewing Logs

```bash
conductor logs                 # all services
conductor logs --follow        # tail in real-time
conductor logs api             # just the API
conductor logs api web         # multiple services
```

### Environment Variables

Define at the profile level:

```yaml
profiles:
  dev:
    env:
      NODE_ENV: development
      DEBUG: "myapp:*"
    commands:
      - id: app
        run: npm run dev # inherits NODE_ENV and DEBUG
```

Or override per-command:

```yaml
- id: app
  run: npm run dev
  env_overrides:
    NODE_ENV: staging # overrides profile-level NODE_ENV
```

### Fire-and-Forget Scripts

Some services should run once and exit (e.g., database migrations):

```yaml
- id: db-migrate
  name: "Database Migration"
  run: npm run migrate
  healthcheck:
    type: none # don't wait for anything; exit is success
```

Exit code 0 = success (dependent services start)
Exit code ≠ 0 = failure (dependent services don't start, error is shown)

### Multiple Profiles

Define different configurations for dev, staging, production:

```yaml
profiles:
  dev:
    env:
      NODE_ENV: development
      DEBUG: "*"
    commands:
      - id: api
        run: npm run dev:debug

  staging:
    env:
      NODE_ENV: staging
    commands:
      - id: api
        run: npm run start

  prod:
    env:
      NODE_ENV: production
    commands:
      - id: api
        run: npm run start
```

Run with: `conductor run staging` or `conductor run prod`

---

## Debugging

### Process Status

```bash
conductor ps

# Output:
# PID    COMMAND     STATUS      HEALTH      STARTED
# 12345  postgres    running     healthy     30s
# 12346  api         running     healthy     20s
# 12347  web         running     healthy     10s
```

Status meanings:

- **running** — process spawned, health unknown or not yet checked
- **healthy** — health check passed
- **stopped** — exited gracefully (code 0)
- **failed** — exited with error (code ≠ 0)

### Why Won't My Service Start?

1. Check if a dependency failed:

   ```bash
   conductor ps
   ```

2. View logs to see the error:

   ```bash
   conductor logs --follow
   ```

3. Try starting the dependency manually:
   ```bash
   conductor start database
   conductor logs database
   ```

### Health Check Debugging

If a health check times out, increase timeout or check manually:

```yaml
- id: api
  healthcheck:
    type: http
    url: "http://localhost:3001/health"
    timeout_ms: 60000 # give it 60 seconds to be ready
    interval_ms: 1000 # check every 1 second
    retries: 60 # retry 60 times
```

Or test the endpoint yourself:

```bash
curl http://localhost:3001/health
```

---

## Next Steps

- [Read the main README](../../README.md) for full documentation
- [Check the architecture guide](../ARCHITECTURE.md) (coming soon)
- [View the configuration reference](../CONFIG.md) (coming soon)
