# Guides Overview

This section contains practical guides for working with Conductor — how dependencies, healthchecks, and environment variables work in practice.

## Dependency Ordering

Root-level commands are started in dependency order using topological sort. Any command that lists another by its `id` in that command's `deps[]` will wait until all listed deps are healthy (or have exited 0).

```yaml
commands:
  - id: db
    run: docker compose up postgres

  - id: api
    run: npm start
    deps: [db] # api starts only after db is healthy

  - id: worker
    run: npm run worker
    deps: [db] # also waits for db (but not in any particular order with api)

profiles:
  dev:
    env: { NODE_ENV: development }
    command_ids: [api, worker, db]
```

**Rules:**

- If a dependency ID isn't defined as a root-level command, execution fails immediately.
- Circular deps are rejected before any process starts (topological sort detects cycles).
- A command with no `deps` starts immediately. The order from `command_ids` in the profile is used only when multiple commands have no cross-dependencies.

## Healthchecks

Every command can specify a healthcheck to tell Conductor when it's considered "ready":

| Type | When to use | Example |
| ---- | ----------- | ------- |
