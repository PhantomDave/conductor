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
| TS7 Phase 1 — oxlint replaces ESLint      | `.oxlintrc.json` present, no `eslint.config.js`, `"lint": "oxlint --deny-warnings"`                                                                  |
| TS7 Phase 2 — React hooks lint rules      | Merged in #62                                                                                                                                        |
| TS7 Phase 3 — TypeScript 7 bump           | Merged in #63                                                                                                                                        |

One loose end from #3, not worth its own item: the audit label at
[api.ts:297](../packages/core/src/api.ts) is still `"parse-docker compose"` (with the old space). Fix it
in passing next time that line is touched.

## Open, in order

1. **TS7 Phase 4 — type-aware lint in CI.** The plan's own status line ("in progress") is the one part of
   it still true. No `lint:types` script exists, `.oxlintrc.json` has no type-aware config, and neither
   CI workflow (`ci.yml`, `release.yml`) references `tsgolint`. Per the plan: add `oxlint-tsgolint`, wire
   `lint:types` as its own required CI step, fix the ~60 remaining findings (`no-floating-promises` 49,
   `await-thenable` 10, `restrict-template-expressions` 1 at `packages/desktop/src/main.ts:123` —
   `set-state-in-effect` and `exhaustive-deps` are already fixed by Phase 2). Split into multiple PRs per
   the plan's own suggestion if it drags.

2. **IDEAS #2 — `log_line` readiness probe.** Independent of everything else; unblocks any service that
   only announces readiness on stdout. Touches two files, not one: `probeOnce` in `healthcheck.ts` is
   stateless, so the match flag has to live on `ProcessWrapper` and get set from the existing log path.

3. **IDEAS #3 — watch-and-restart.** Now unblocked — its restart machinery (IDEAS #1) shipped in #65.
   Widen `SpawnQueue.transitiveDependents` from `private`, glob watch on `cwd`, 500ms debounce, restart
   the changed service plus every healthy transitive dependent, coalesce events during an in-flight
   restart.

4. **Backlog #4 — CLI and UI tests.** Still zero test files under `packages/cli` and `packages/ui`
   (`packages/core/test/` is the only test dir in the repo). Highest-priority open item by the backlog's
   own severity rating; nothing else on this list has regression coverage once it lands.

5. **Backlog #7 — `/api/command` → `/api/commands`.** Still only the singular routes exist
   (`api.ts:592,597,613,632`). Add plural aliases, mark canonical in `API.md`, deprecate the singular
   ones on a timeline.

6. **Backlog #6 + IDEAS "Sharpens" — log retention with FTS5.** Metrics already purge via
   `deleteMetricBefore`; logs don't. IDEAS.md attaches real numbers to this: 3.1× storage amplification
   without a trigram-tokenized FTS5 index, 7-day default window is the reference implementation's choice.
   Build retention and the FTS5 index together — the doc explains why they're one change, not two.

7. **IDEAS #4 — resource alerts that never kill.** Confirmed still blocked exactly as IDEAS.md says:
   `grep -rn "new MetricCollector" packages/core/src packages/core/bin packages/desktop/src` returns zero
   matches — it's written, never instantiated. Wire the collector first, then hang `max_cpu_pct` /
   `max_mem_mb` thresholds off its existing `onSample` hook. Notify-only, never kill; per-(service,
   resource) cooldown (5 min default) so a threshold-boundary service doesn't spam.

8. **IDEAS #5 — failure diagnosis panel.** Pure assembly over state Conductor already stores (failure
   reason, output tail, last probe cycle, unhealthy deps) — no new subsystem. Last in the suggested order
   because nothing else depends on it.

## Standing rules for every item above

- A feature isn't done until schema/API, CLI, and UI all cover it — a backend-only field is not a
  finished feature. IDEAS #1's own progress checklist (schema → `api.ts` → `CommandForm.tsx` → test) is
  the model to copy.
- Anything touching `packages/desktop` (item 1's `main.ts` finding, in particular) needs the Electron
  smoke test (`.claude/skills/run-desktop/SKILL.md`) before commit, not just `bun test`.
