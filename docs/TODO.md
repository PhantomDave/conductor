# TODO

Reconciles [IMPROVEMENT_BACKLOG.md](./IMPROVEMENT_BACKLOG.md), [IDEAS.md](./IDEAS.md), and
[TS7_MIGRATION_PLAN.md](./TS7_MIGRATION_PLAN.md) against the current tree (verified via `graphify query`
and direct source reads, 2026-09-17). Those three docs keep their full problem/scope detail; this file
is just the current, deduplicated action list. Don't add new detail here — add it there and link it.

## Already shipped — stale in the source docs

Confirmed done by reading the code, not by trusting the doc. Safe to delete these entries from
`IMPROVEMENT_BACKLOG.md` and the `IDEAS.md` progress list next time either file is touched.

| Item                                      | Evidence                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backlog #1 — `conductor logs` end-to-end  | [logs.ts](../packages/cli/src/commands/logs.ts) hits `GET /api/logs`, `--follow` opens an `EventSource` on `/api/logs/stream`                        |
| Backlog #2 — `conductor stop <profile>`   | [ps.ts](../packages/cli/src/commands/ps.ts) `registerStopCommand` calls `POST /api/profiles/:profile/stop`                                           |
| Backlog #3 — docker-compose route naming  | [api.ts:304](../packages/core/src/api.ts) canonical `/api/docker-compose/parse`, `:306` legacy alias kept, [API.md:118-119](./API.md) documents both |
| Backlog #5 — numeric query param guards   | [api.ts:74-92](../packages/core/src/api.ts), `z.coerce.number().int().min/max(...)` on `limit`/`offset`/`pid`                                        |
| Backlog #8 — audit entries for env delete | [api.ts:857](../packages/core/src/api.ts) `insertAuditEntry("delete-env", ...)`                                                                      |
| IDEAS #1 — restart policies               | Shipped in #65; schema, API, `SpawnQueue` backoff, tests, `CommandForm.tsx` — see IDEAS.md's own progress checklist                                  |
| IDEAS #2 — `log_line` readiness probe     | Shipped in #66                                                                                                                                       |
| IDEAS #3 — watch-and-restart              | `FileWatcher` in [file-watcher.ts](../packages/core/src/monitor/file-watcher.ts), owned by `SpawnQueue`; `watch` field was already in schema/API/UI  |
| TS7 Phase 4 — type-aware lint in CI       | `lint:types` script, `oxlint-tsgolint`, wired into `ci.yml`                                                                                          |
| TS7 Phase 1 — oxlint replaces ESLint      | `.oxlintrc.json` present, no `eslint.config.js`, `"lint": "oxlint --deny-warnings"`                                                                  |
| TS7 Phase 2 — React hooks lint rules      | Merged in #62                                                                                                                                        |
| TS7 Phase 3 — TypeScript 7 bump           | Merged in #63                                                                                                                                        |

One loose end from #3, not worth its own item: the audit label at
[api.ts:297](../packages/core/src/api.ts) is still `"parse-docker compose"` (with the old space). Fix it
in passing next time that line is touched.

## Open, in order

1. **Backlog #4 — CLI and UI tests.** Still zero test files under `packages/cli` and `packages/ui`
   (`packages/core/test/` is the only test dir in the repo). Highest-priority open item by the backlog's
   own severity rating; nothing else on this list has regression coverage once it lands.

2. **Backlog #7 — `/api/command` → `/api/commands`.** Still only the singular routes exist
   (`api.ts:592,597,613,632`). Add plural aliases, mark canonical in `API.md`, deprecate the singular
   ones on a timeline.

3. **Backlog #6 + IDEAS "Sharpens" — log retention with FTS5, on two axes.** Metrics already purge
   via `deleteMetricBefore`; logs don't. IDEAS.md attaches real numbers to this: 3.1× storage
   amplification without a trigram-tokenized FTS5 index, 7-day default window is the reference
   implementation's choice. A second, configurable axis is also wanted: retention **by session**
   (one session = one full `POST /api/profiles/:profile/run`, not a single command restart) —
   keep the last N sessions per profile, N configurable next to `base_path`/`default_shell`. See
   IDEAS.md's "Session-scoped retention" section for the `sessions` table / `logs.session_id`
   shape. Build retention (both axes) and the FTS5 index together — the doc explains why they're
   one change, not two.

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
