# Example 2: Microservices with Docker Compose

This example shows a microservices architecture with multiple interdependent services, all orchestrated via Docker Compose.

## Configuration

```yaml
version: "1"
name: "Microservices Platform"
description: "Multi-service development environment"

base_path: "."

profiles:
  dev:
    description: "Local development with Docker Compose"
    env:
      COMPOSE_PROJECT_NAME: "myapp-dev"
      LOG_LEVEL: "debug"

    commands:
      # Core infrastructure: message broker and cache
      - id: redis
        name: "Redis Cache"
        run: docker-compose up -d redis
        healthcheck:
          type: command
          command: "docker-compose exec -T redis redis-cli ping | grep -q PONG"
          interval_ms: 1000
          timeout_ms: 30000
          retries: 30
        stop_command: docker-compose stop redis
        stop_timeout_ms: 5000

      - id: rabbitmq
        name: "RabbitMQ Message Broker"
        run: docker-compose up -d rabbitmq
        healthcheck:
          type: port
          port: 5672
          interval_ms: 1000
          timeout_ms: 30000
          retries: 30
        stop_command: docker-compose stop rabbitmq
        stop_timeout_ms: 5000

      # Database services (can start in parallel, no deps)
      - id: postgres
        name: "PostgreSQL Database"
        run: docker-compose up -d postgres
        healthcheck:
          type: command
          command: "docker-compose exec -T postgres pg_isready -U postgres"
          interval_ms: 1000
          timeout_ms: 30000
          retries: 30
        stop_command: docker-compose stop postgres
        stop_timeout_ms: 5000

      - id: mongo
        name: "MongoDB"
        run: docker-compose up -d mongo
        healthcheck:
          type: port
          port: 27017
          interval_ms: 1000
          timeout_ms: 30000
          retries: 30
        stop_command: docker-compose stop mongo
        stop_timeout_ms: 5000

      # Microservices (all depend on infrastructure)
      - id: auth-service
        name: "Auth Service"
        run: docker-compose up -d auth-service
        deps: [redis, rabbitmq, postgres]
        healthcheck:
          type: http
          url: "http://localhost:3001/health"
          interval_ms: 500
          timeout_ms: 30000
          retries: 30
        stop_command: docker-compose stop auth-service
        stop_timeout_ms: 5000

      - id: api-service
        name: "API Service"
        run: docker-compose up -d api-service
        deps: [redis, rabbitmq, postgres, auth-service]
        healthcheck:
          type: http
          url: "http://localhost:3002/health"
          interval_ms: 500
          timeout_ms: 30000
          retries: 30
        stop_command: docker-compose stop api-service
        stop_timeout_ms: 5000

      - id: worker-service
        name: "Background Worker"
        run: docker-compose up -d worker-service
        deps: [redis, rabbitmq, mongo]
        healthcheck:
          type: command
          command: "docker-compose exec -T worker-service curl -s http://localhost:3003/health || false"
          interval_ms: 500
          timeout_ms: 30000
          retries: 30
        stop_command: docker-compose stop worker-service
        stop_timeout_ms: 5000

      # API Gateway (depends on all services)
      - id: gateway
        name: "API Gateway"
        run: docker-compose up -d gateway
        deps: [auth-service, api-service, worker-service]
        healthcheck:
          type: http
          url: "http://localhost:8080/health"
          interval_ms: 500
          timeout_ms: 30000
          retries: 30
        stop_command: docker-compose stop gateway
        stop_timeout_ms: 5000
```

## Directory Structure

```
project/
├── .conductor.yml
├── docker-compose.yml
├── services/
│   ├── auth/
│   │   ├── Dockerfile
│   │   └── src/
│   ├── api/
│   │   ├── Dockerfile
│   │   └── src/
│   ├── worker/
│   │   ├── Dockerfile
│   │   └── src/
│   └── gateway/
│       ├── Dockerfile
│       └── src/
└── infra/
    ├── postgres/
    ├── mongo/
    ├── redis/
    └── rabbitmq/
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
conductor restart api-service

# Stop everything gracefully (all services get 5 seconds, then SIGKILL)
conductor stop all
```

## Dependency Graph

```
redis ─┐
       ├─→ auth-service ─┐
rabbitmq               ├─→ gateway
postgres ──→ api-service ┤
       ├─→ worker-service ─┘
mongo ──┘
```

This shows the order services start:

1. **Layer 0** (no deps): redis, rabbitmq, postgres, mongo
2. **Layer 1** (infra ready): auth-service, api-service, worker-service
3. **Layer 2** (services ready): gateway

## Advanced: Custom Compose Profiles

If your `docker-compose.yml` uses profiles, you can start a subset:

```yaml
- id: core-only
  name: "Run Core Services Only"
  run: docker-compose --profile core up -d
  stop_command: docker-compose --profile core down
  stop_timeout_ms: 5000
```

Then:

```bash
conductor run dev      # runs all
conductor run core     # just the infrastructure
```

## Cleanup

```bash
# Stop everything (Conductor waits 5 seconds per service, then SIGKILL)
conductor stop all

# Stop and remove containers (optional docker-compose cleanup)
docker-compose down -v
```

## Troubleshooting

**Health check keeps failing?**

```bash
conductor logs rabbitmq    # see why it's not healthy
docker-compose ps          # verify it's actually running
docker-compose logs rabbitmq  # see service logs
```

**Dependent service stuck?**

```bash
# Force kill it (sends SIGKILL immediately after 5 seconds)
conductor stop api-service

# Restart it (will wait for all deps again)
conductor restart api-service
```

**Want faster startup/shutdown?**
Edit `.conductor.yml` and change `stop_timeout_ms`:

```yaml
- id: my-service
  stop_timeout_ms: 2000 # 2 seconds instead of 5
```
