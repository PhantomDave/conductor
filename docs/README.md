# Conductor Documentation

Reference documentation and practical guides for using Conductor to manage your development environment.

## Core Reference Docs

| Doc                                        | Description                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| [CONFIG.md](./CONFIG.md)                   | Full configuration schema: top-level fields, commands, profiles, healthchecks, env resolution order        |
| [CLI.md](./CLI.md)                         | Every `conductor` command with usage, flags, and environment variables                                     |
| [API.md](./API.md)                         | HTTP API reference — all endpoints grouped by feature (profiles, commands, processes, logs/SSE, config)    |
| [ARCHITECTURE.md](./ARCHITECTURE.md)       | How the engine works: package layout, data flow, process lifecycle, store vs config files, monitoring      |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Common problems and their solutions: CLI errors, health check failures, env vars, processes, Docker import |
| [IMPROVEMENT_BACKLOG.md](./IMPROVEMENT_BACKLOG.md) | Full codebase analysis findings and issue-ready improvement backlog                                  |

## Guides

Practical walkthroughs for common scenarios:

| Guide                                                                    | Description                                                                            |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| [Guides Overview](./guides/README.md)                                    | Concepts: dependency ordering, healthcheck types, config patterns                      |
| [01 Basic Full-Stack App](./guides/examples/01-basic-fullstack.md)       | PostgreSQL + Express API + React frontend on port 3000 with live-reload                |
| [02 Microservices Docker Compose](./guides/examples/02-microservices.md) | Multi-service architecture via `docker compose` with infra → services → gateway layers |
