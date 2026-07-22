# Conductor Documentation

Welcome to Conductor! This folder contains guides, examples, and references for using Conductor in your projects.

## Getting Started

**New to Conductor?** Start here:

1. Read the [main README](../README.md) for an overview
2. Walk through [Example 1: Basic Full-Stack Application](./guides/examples/01-basic-fullstack.md)
3. Try running Conductor on your own project

## Documentation Index

### Guides

- [Examples & Common Patterns](./guides/README.md) — Real-world configurations
  - [Example 1: Full-Stack App](./guides/examples/01-basic-fullstack.md)
  - [Example 2: Microservices](./guides/examples/02-microservices.md)
- [Configuration Reference](./CONFIG.md) (coming soon)
- [Architecture & Design](./ARCHITECTURE.md) (coming soon)
- [Troubleshooting Guide](./TROUBLESHOOTING.md) (coming soon)

### API Reference

- [HTTP API](./API.md) (coming soon)
- [CLI Commands](./CLI.md) (coming soon)

## Key Concepts

### Profiles

Conductor lets you define multiple execution profiles (dev, staging, prod) in a single `.conductor.yml`:

```bash
conductor run dev      # start dev profile
conductor run staging  # start staging profile
```

### Dependency Resolution

Services start in order. Dependents wait for dependencies to be healthy:

```yaml
- id: db
  run: postgres
- id: api
  run: node server.js
  deps: [db] # api only starts after db is healthy
```

### Health Checks

Verify services are actually ready before starting dependents:

```yaml
- id: api
  healthcheck:
    type: http
    url: http://localhost:3000/health
```

### Process Lifecycle

- Graceful shutdown (SIGTERM) with configurable timeout
- SIGKILL as fallback if graceful shutdown fails
- Status tracking (running, healthy, stopped, failed)

## Common Tasks

| Task                 | Command                     |
| -------------------- | --------------------------- |
| Start everything     | `conductor run dev`         |
| Tail all logs        | `conductor logs --follow`   |
| Check what's running | `conductor ps`              |
| Restart one service  | `conductor restart api`     |
| Stop everything      | `conductor stop all`        |
| View config          | `conductor config`          |
| Validate config      | `conductor config validate` |

## Troubleshooting

- Service won't start? → Check dependencies: `conductor ps`
- Health check timing out? → Increase `timeout_ms` in config
- Port already in use? → Change port in service config or stop other services
- Docker issues? → Ensure Docker daemon is running, check `docker ps`

See [Troubleshooting Guide](./TROUBLESHOOTING.md) for more.

## Contributing

Found an issue? Missing documentation? PRs welcome!

## Resources

- [GitHub Repository](https://github.com/PhantomDave/conductor)
- [Issue Tracker](https://github.com/PhantomDave/conductor/issues)
- [Releases](https://github.com/PhantomDave/conductor/releases)
