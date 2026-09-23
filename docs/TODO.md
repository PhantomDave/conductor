# TODO

Reconciles [IMPROVEMENT_BACKLOG.md](./IMPROVEMENT_BACKLOG.md), [IDEAS.md](./IDEAS.md), and
[TS7_MIGRATION_PLAN.md](./TS7_MIGRATION_PLAN.md) against the current tree (verified via `graphify query`
and direct source reads, 2026-09-17). Those three docs keep their full problem/scope detail; this file
is just the current, deduplicated action list. Don't add new detail here — add it there and link it.

## Already shipped — stale in the source docs

Confirmed done by reading the code, not by trusting the doc. Safe to delete these entries from
`IMPROVEMENT_BACKLOG.md` and the `IDEAS.md` progress list next time either file is touched.

| Item                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backlog #1 — `conductor logs` end-to-end                | [logs.ts](../packages/cli/src/commands/logs.ts) hits `GET /api/logs`, `--follow` opens an `EventSource` on `/api/logs/stream`                                                                                                                                                                                                                                                                                                                                                         |
| Backlog #2 — `conductor stop <profile>`                 | [ps.ts](../packages/cli/src/commands/ps.ts) `registerStopCommand` calls `POST /api/profiles/:profile/stop`                                                                                                                                                                                                                                                                                                                                                                            |
| Backlog #3 — docker-compose route naming                | [api.ts:304](../packages/core/src/api.ts) canonical `/api/docker-compose/parse`, `:306` legacy alias kept, [API.md:118-119](./API.md) documents both                                                                                                                                                                                                                                                                                                                                  |
| Backlog #5 — numeric query param guards                 | [api.ts:74-92](../packages/core/src/api.ts), `z.coerce.number().int().min/max(...)` on `limit`/`offset`/`pid`                                                                                                                                                                                                                                                                                                                                                                         |
| Backlog #8 — audit entries for env delete               | [api.ts:857](../packages/core/src/api.ts) `insertAuditEntry("delete-env", ...)`                                                                                                                                                                                                                                                                                                                                                                                                       |
| IDEAS #1 — restart policies                             | Shipped in #65; schema, API, `SpawnQueue` backoff, tests, `CommandForm.tsx` — see IDEAS.md's own progress checklist                                                                                                                                                                                                                                                                                                                                                                   |
| IDEAS #2 — `log_line` readiness probe                   | Shipped in #66                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| IDEAS #3 — watch-and-restart                            | `FileWatcher` in [file-watcher.ts](../packages/core/src/monitor/file-watcher.ts), owned by `SpawnQueue`; `watch` field was already in schema/API/UI                                                                                                                                                                                                                                                                                                                                   |
| TS7 Phase 4 — type-aware lint in CI                     | `lint:types` script, `oxlint-tsgolint`, wired into `ci.yml`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| TS7 Phase 1 — oxlint replaces ESLint                    | `.oxlintrc.json` present, no `eslint.config.js`, `"lint": "oxlint --deny-warnings"`                                                                                                                                                                                                                                                                                                                                                                                                   |
| TS7 Phase 2 — React hooks lint rules                    | Merged in #62                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| TS7 Phase 3 — TypeScript 7 bump                         | Merged in #63                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Backlog #6 + IDEAS "Sharpens" — log retention with FTS5 | Shipped in #72; `logs_fts` FTS5 table ([schema.sql:47](../packages/core/src/db/schema.sql)), `deleteLogsBefore`/`pruneOldSessions` ([queries.ts](../packages/core/src/db/queries.ts)), `log_retention_days`/`log_retention_sessions` on `ConductorConfigSchema` ([schema.ts:85-86](../packages/core/src/config/schema.ts)), GET/PUT `/api/log-retention` ([api.ts](../packages/core/src/api.ts)), `EnvironmentManager.tsx` control, [CONFIG.md](./CONFIG.md), `log-retention.test.ts` |
| Backlog #4 — CLI and UI tests                           | [cli.test.ts](../packages/cli/test/cli.test.ts) spawns the real CLI, [api.test.ts](../packages/ui/test/api.test.ts) drives the UI's `lib/api.ts`, both against a real core booted by [api-harness.ts](../packages/core/test/fixtures/api-harness.ts); root `bun test` already runs them in CI on all three OSes. React hook/component tests deferred (would need a DOM lib)                                                                                                           |

One loose end from #3, not worth its own item: the audit label at
[api.ts:297](../packages/core/src/api.ts) is still `"parse-docker compose"` (with the old space). Fix it
in passing next time that line is touched.

## Open, in order

1. **Log rows tagged `profile="__global__"`** (found by the CLI tests). Core runs everything on one
   global `SpawnQueue("__global__")` ([store.ts:36](../packages/core/src/config/store.ts)), so every
   log row from a core-started run stores that as its profile — `conductor logs --profile X`, the UI's
   profile filter, and likely session-scoped retention never match. Fix at the source (tag with the
   launching profile), then switch `cli.test.ts`'s logs test back to `--profile`.

2. **Managed-process output lost** (found by the CLI tests on macOS/Windows CI). (a) `conductor run`
   ([run.ts](../packages/cli/src/commands/run.ts)) returns once `startAll` resolves, so a short-lived
   command's stdout can be dropped when the CLI exits before its pump drains (seen on macOS) — it should
   wait for its commands to exit and their streams to drain. (b) On Windows, stdout from a
   `bun -e "..."` command isn't captured at all, in core too — only `[startup]` lines reach the log.
   Once fixed, make `cli.test.ts`'s run/logs tests assert on the fixture's stdout again.

3. **Backlog #7 — `/api/command` → `/api/commands`.** Still only the singular routes exist
   (`api.ts:634,639,655,674`). Add plural aliases, mark canonical in `API.md`, deprecate the singular
   ones on a timeline.

4. **IDEAS #4 — resource alerts that never kill.** `MetricCollector` is already wired (`bin/server.ts`,
   since #36) — sampling, retention, and `GET /api/processes/:pid/metrics` all work. What's actually open:
   add `max_cpu_pct` / `max_mem_mb` to the schema and hang notify logic off the existing `onSample` hook
   (notify-only, never kill; per-(service, resource) cooldown, 5 min default, so a threshold-boundary
   service doesn't spam), and wire a UI chart against the already-existing `fetchProcessMetrics` helper,
   which nothing currently calls.

5. **IDEAS #5 — failure diagnosis panel.** Pure assembly over state Conductor already stores (failure
   reason, output tail, last probe cycle, unhealthy deps) — no new subsystem. Last in the suggested order
   because nothing else depends on it.

## Standing rules for every item above

- A feature isn't done until schema/API, CLI, and UI all cover it — a backend-only field is not a
  finished feature. IDEAS #1's own progress checklist (schema → `api.ts` → `CommandForm.tsx` → test) is
  the model to copy.
- Anything touching the desktop shell needs a smoke test before commit, not just `bun test`: run
  `.claude/skills/run-desktop/smoke.mjs` (builds sidecar + UI, runs the compiled binary with `CONDUCTOR_UI_DIST`
  set, drives it via headless Chromium since this host can't screenshot a real window). `packages/desktop`
  (Electron) is gone; the skill was rewritten for Tauri and passes.
