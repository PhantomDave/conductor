# Example 2: Microservices with Docker Compose

This example shows a microservices architecture with multiple interdependent services, all orchestrated via Docker Compose.

## Configuration

```yaml
version: "1"
name: "Microservices Platform"
description: "Multi-service development environment"

base_path: "."
global_env:
  LOG_LEVEL: debug

# ── Commands (root level) ────────────────────────────────
commands:
  # Core infrastructure — can start in parallel, no deps
  - id: redis
    name: "Redis Cache"
    run: docker compose up -d redis
    healthcheck:
      type: command
      command: "docker compose exec -T redis redis-cli ping | grep -q PONG"
      interval_ms: 1000
      timeout_ms: 30000
      retries: 30
    stop_command: docker compose stop redis
    stop_timeout_ms: 5000

  - id: rabbitmq
    name: "RabbitMQ Message Broker"
    run: docker compose up -d rabbitmq
    healthcheck:
      type: port
      port: 5672
      interval_ms: 1000
      timeout_ms: 30000
      retries: 30
    stop_command: docker compose stop rabbitmq
    stop_timeout_ms: 5000

  - id: postgres
    name: "PostgreSQL Database"
    run: docker compose up -d postgres
    healthcheck:
      type: command
      command: "docker compose exec -T postgres pg_isready -U postgres"
      interval_ms: 1000
      timeout_ms: 30000
      retries: 30
    stop_command: docker compose stop postgres
    stop_timeout_ms: 5000

  - id: mongo
    name: "MongoDB"
    run: docker compose up -d mongo
    healthcheck:
      type: port
      port: 27017
      interval_ms: 1000
      timeout_ms: 30000
      retries: 30
    stop_command: docker compose stop mongo
    stop_timeout_ms: 5000

  # Microservices — all depend on infrastructure
  - id: auth-service
    name: "Auth Service"
    run: docker compose up -d auth-service
    deps: [redis, rabbitmq, postgres]
    healthcheck:
      type: http
      url: "http://localhost:3001/health"
      interval_ms: 500
      timeout_ms: 30000
      retries: 30
    stop_command: docker compose stop auth-service
    stop_timeout_ms: 5000

  - id: api-service
    name: "API Service"
    run: docker compose up -d api-service
    deps: [redis, rabbitmq, postgres, auth-service]
    healthcheck:
      type: http
      url: "http://localhost:3002/health"
      interval_ms: 500
      timeout_ms: 30000
      retries: 30
    stop_command: docker compose stop api-service
    stop_timeout_ms: 5000

  - id: worker-service
    name: "Background Worker"
    run: docker compose up -d worker-service
    deps: [redis, rabbitmq, mongo]
    healthcheck:
      type: command
      command: "docker compose exec -T worker-service curl -s http://localhost:3003/health || false"
      interval_ms: 500
      timeout_ms: 30000
      retries: 30
    stop_command: docker compose stop worker-service
    stop_timeout_ms: 5000

  # API Gateway — depends on all services
  - id: gateway
    name: "API Gateway"
    run: docker compose up -d gateway
    deps: [auth-service, api-service, worker-service]
    healthcheck:
      type: http
      url: "http://localhost:8080/health"
      interval_ms: 500
      timeout_ms: 30000
      retries: 30
    stop_command: docker compose stop gateway
    stop_timeout_ms: 5000

# ── Profiles ─────────────────────────────────────────────
profiles:
  dev:
    description: "Local development with Docker Compose"
    env:
      COMPOSE_PROJECT_NAME: "myapp-dev"
    command_ids:
      [redis, rabbitmq, postgres, mongo, auth-service, api-service, worker-service, gateway]
```

## Running the Application

```bash
# Start everything in dependency order
conductor run dev

# Watch logs from all services
conductor logs --follow

# See what's running
conductor ps

# Restart a single service (all dependencies remain running)
conductor restart api-service   # CLI support for per-command restart is planned
```

## Dependency Graph

```
redis ─┐
       ├─→ auth-service ─┐
rabbitmq                 ├─→ gateway
postgres ──→ api-service ┤
       ├─→ worker-service ─┘
mongo ──┘
```

### Startup order (layers):

1. **Layer 0** (no deps): redis, rabbitmq, postgres, mongo — all start in parallel
2. **Layer 1** (infra ready): auth-service, api-service, worker-service — each waits for their listed deps
3. **Layer 2** (services ready): gateway — waits for auth-service, api-service, worker-service

## Advanced: Custom Compose Profiles

If your docker compose file uses `profiles`, you can start a subset of services:

```yaml
- id: core-only
  name: "Run Core Services Only"
  run: docker compose --profile core up -d
  stop_command: docker compose --profile core down
  stop_timeout_ms: 5000
```

Then add to any profile's `command_ids`.

## Cleanup

```bash
# Stop everything (Conductor waits 5 seconds per service, then SIGKILL)
conductor stop all          # CLI stub — use the UI or Ctrl+C for now

# Stop and remove containers (optional docker compose cleanup)
docker compose down -v
```

## Troubleshooting

**Health check keeps failing?**

```bash
conductor logs rabbitmq    # see why it's not healthy
docker compose ps          # verify the container is running
docker compose logs rabbitmq  # inspect container output
```

**Dependent service stuck?**

```bash
# Force kill it (sends SIGKILL immediately after 5 seconds)
conductor stop api-service    # CLI stub — use Ctrl+C for now

# Restart it (will wait for all deps again)
# Use the UI's "Restart" button on the process card
```

**Want faster startup/shutdown?**

Edit `.conductor.yml` and change `stop_timeout_ms`:

```yaml
- id: my-service
  stop_timeout_ms: 2000 # 2 seconds instead of default 5
```

## Notes on Configuration

- All services (including infra like redis/rabbitmq) are defined as root-level commands with explicit health checks.
- Infrastructure is always started first because they're listed before microservices in the `command_ids` array and have no deps themselves.
- The stop_command for each service runs a targeted docker compose stop before Conductor sends SIGTERM to the wrapper process, ensuring containers are properly cleaned up.
