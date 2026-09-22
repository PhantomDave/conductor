# Ideas for Conductor

This is a shortlist, not a feature tour. The filter applied to every candidate was:
**does Conductor already have the substrate, so the borrow is a small diff?**
Anything needing a new subsystem was cut.

Conductor's side was mapped from the graphify knowledge graph in `graphify-out/`
(943 nodes, 1997 edges), then the load-bearing claims were verified against source.
None of these duplicate the eight items already in [IMPROVEMENT_BACKLOG.md](./IMPROVEMENT_BACKLOG.md).

---

## 1. Restart policy — `manual` / `on_failure` / `always`

**The gap.** Conductor detects a service going unhealthy and then does nothing about
it. `HealthMonitor` polls, debounces to state _changes_ only, and calls back on each
flip. The entire flip handler is this (`startHealthMonitor` in [queue.ts](../packages/core/src/executor/queue.ts)):

```ts
(isHealthy, detail) => {
  wrapper.updateHealth(isHealthy ? "healthy" : "unhealthy");
  wrapper.log(
    isHealthy ? "[healthcheck] service healthy" : `[healthcheck] service unhealthy: ${detail}`,
    "stdout",
  );
};
```

It paints the status dot red. That's the whole response to a crashed service.

**The change.** Conductor needs one schema field and a branch in the closure above — and the
closure is already a method on `SpawnQueue`, which already owns `restartOne(commandId)`
(`restartOne` in the same file). The action is a method
call on `this`.

```yaml
commands:
  - id: api
    restart: on_failure # manual (default) | on_failure | always
```

**Why it's the top pick.** Highest value-to-diff ratio in the list. It closes the loop
on monitoring machinery that is already built, already wired, and currently only
produces a log line.

**Carry the details too:** cap the attempts and back off. An `always` policy on a
service that crashes at startup is an infinite spawn loop, and Conductor's
`SpawnQueue` is the 42-edge god node in the graph — the worst place to add an
unbounded loop.

---

## 2. `log_line` readiness probe

**The gap.** Conductor's healthchecks are `port` / `http` / `command` / `none`. Plenty
of dev tools announce readiness _only_ on stdout and never open a port you can
meaningfully poll — `webpack` printing `compiled successfully`, a migration runner,
`Attached to ...`. Today the only option is `sleep`-and-hope via `command`.

**The change.** Match a substring against the process's output stream and resolve when
it appears.

```yaml
healthcheck:
  type: log_line
  pattern: "Now listening on:"
```

**Honest caveat — this is not a clean fifth `case`.** `probeOnce(healthcheck, env)` is
a _pure, stateless_ function ([healthcheck.ts](../packages/core/src/executor/healthcheck.ts));
it has no idea which process it is probing and no access to its output. A log probe is
inherently stateful and per-process. Set a matched flag on the `ProcessWrapper` from the existing
log path, and have the `log_line` case read that flag. Still small, but it touches
`ProcessWrapper` as well as the switch — budget for two files, not one.

---

## 3. Watch-and-restart

**The gap.** Conductor has no file watching at all. Restarting after an edit is manual,
and restarting the services _downstream_ of the edited one is manual and easy to forget.

**The borrow.** Globs relative to `cwd`, a 500 ms debounce quiet window, and — the part
that matters — restarting the changed service **plus every healthy service that
transitively depends on it**. Conductor already has exactly that lookup: `SpawnQueue.transitiveDependents(commandId)`
walks the reverse `deps` edges today to populate `Notification.affectedDownstream`. It is
`private` — widening it is the whole graph-side cost.

```yaml
commands:
  - id: api
    watch: ["src/**", "*.csproj"]
```

Coalesce events that arrive during an in-flight restart so a formatter run that touches
40 files does not thrash the restart machinery.

**Depends on #1** — it's the same restart machinery with a different trigger. Build it
second.

## 4. Resource alerts that never kill

**The gap.** `MetricCollector` is wired — instantiated in `bin/server.ts` (5s sampling,
24h retention), its `onSample` hook already feeds live CPU/RSS into
`ProcessWrapper`'s snapshots, and `GET /api/processes/:pid/metrics` returns real
history. The collection half is done and has been since #36.

What's actually missing is two things: the threshold/notify logic itself (no
`max_cpu_pct` / `max_mem_mb` fields exist anywhere yet — `schema.ts` has nothing for
them), and a UI consumer — `packages/ui/src/lib/api.ts` has a `fetchProcessMetrics`
helper that nothing calls, so there's no chart either.

**The rationale, not the feature.** `max_cpu_pct` / `max_mem_mb` should **notify and
never kill**, deliberately: a dev process legitimately pegging
a core under a debugger or a profiler must not be killed by a number someone typed into
a config months earlier. Pair that with a per-(service, resource) cooldown — 5 minutes
is a reasonable default — or a service that idles on the threshold boundary generates a
notification every sample tick. Omitting the fields disarms it at zero cost.

Kept on the list because the sampling code is the expensive half and it is already
written and already correct.
---

## 5. Failure diagnosis panel

**The gap.** When a service fails to come up, the answer is spread across four screens:
the status badge says _why_ in three words, the log viewer has the actual error, the
dependency view shows which upstream is red, and the probe detail is buried in a log
line.

**The change.** Assemble one panel from data Conductor
already stores: failure reason, an output tail, the last probe cycle, and the list of
unhealthy dependencies. **No new subsystem — pure assembly over existing state.**
Conductor stores every one of those inputs already.

Two implementation details worth copying verbatim:

- Detect the probe-cycle boundary by watching for the attempt number to _decrease_,
  so you show the last full cycle rather than an arbitrary window.

---

## Sharpens an existing backlog item: FTS5 + log retention

Backlog item 6 is "add log retention." The **measured numbers** turn it from a
nice-to-have into a sizing decision — and explain why the two features belong together.

From `db/retention.rs`: an 8-hour session across 43 services produced 247,680 rows and
484 MiB of raw payload — which landed as **1,497 MiB** on disk. Roughly **3.1×
amplification**, almost all of it the search index. Insert cost was ~197 µs; write
latency was never the problem, storage was. Their default is a 7-day window, hourly
sweep, `0` disables.

The paired half is FTS5 with a **trigram** tokenizer as an _external-content_ index
(`content='logs'`, no duplicated payload). Three points from their migration's rationale:

- **Trigram, not the default tokenizer** — log search is substring search. `eout` must
- **The index is a candidate filter, not the answer.** It narrows the rows; the exact
  matcher still runs per line. This is what keeps results correct rather than
- **Regex stays on the linear path**, and terms under 3 characters have no trigram at
  all and fall back to scanning. Know the fallbacks before promising the speedup.

---

## Session-scoped retention (second axis, same backlog item)

Requested addition: keep logs by **session** — a session is one full profile
start (`POST /api/profiles/:profile/run`, [api.ts:718](../packages/core/src/api.ts)) — with
the session count configurable, not just the time window above. A single command's
`execute`/`restart` ([api.ts:667](../packages/core/src/api.ts),
[api.ts:692](../packages/core/src/api.ts)) does not open a new session; only a
profile-level run does.

Shape:

- **`sessions` table**: `id INTEGER PRIMARY KEY, profile TEXT NOT NULL, started_at TEXT NOT NULL`.
  One row inserted per `/api/profiles/:profile/run` call, before `queue.startMany`
  ([api.ts:742](../packages/core/src/api.ts)).
- **`logs.session_id INTEGER`** (nullable). The `onLog` closure in
  [server.ts:73](../packages/core/bin/server.ts) already has `entry.profile` on every row; it
  needs the current session id for that profile threaded in (e.g. a `Map<profile, sessionId>`
  updated whenever a new session row is created — `onLog` has no request context of its own).
  Commands started standalone via `/api/commands/:id/execute` (no profile run) get a null
  `session_id` and simply sit outside session-based retention, same as they already do for the
  time-window one.
- **Config**: `log_retention_sessions` on `ConductorConfigSchema`, next to `base_path` /
  `default_shell` ([schema.ts:76-80](../packages/core/src/config/schema.ts)). Default a small
  number (e.g. 10), `0` disables — same convention the time-window default above already uses.
  Exposed and edited the same way those two fields are: a GET/PUT route and a control in
  [EnvironmentManager.tsx](../packages/ui/src/components/EnvironmentManager.tsx), which already
  hosts both.
- **Sweep**: on each new session insert, delete `logs` rows for that profile whose `session_id`
  is older than the Nth most recent session (`... WHERE session_id IN (SELECT id FROM sessions
WHERE profile = ? ORDER BY started_at DESC LIMIT -1 OFFSET ?)`). Same trigger point as the
  time-window sweep — one cleanup pass, not two.

This is additive to, not instead of, the FTS5 + time-window piece above: if the FTS5 index lands
as an external-content index keyed to `logs.rowid`, a session-based delete has to keep it in sync
exactly like the time-window delete does — same shadow-table concern, applies to whichever sweep
deletes the row.

---

## Considered and deliberately rejected

**A control socket.** A 0600 Unix domain socket with a line-delimited
JSON protocol and a `ctl` verb set, parsed before Tauri boots. Tempting, and the wrong
borrow: that socket exists because Tauri is single-instance and accepts no argv.
**Conductor already has a control plane** — the Fastify API on :4000, which already
exposes `/api/commands/:id/restart`.

Conductor's real problem is different and smaller: `conductor run` holds the engine
in-process, so `ps` / `logs` / `stop` have nothing to talk to once you close the
terminal, and per the graph, _"Ctrl+C is the only way to stop all processes today."_
The transferable idea is **headless lifecycle** — `conductor run --detach` plus the
existing HTTP API — which also closes backlog items 1 and 2. Adding a second IPC
mechanism next to the HTTP API would be architecture astronomy.

**Also looked at, not proposed:** PTY/xterm terminals, command palette, config-reload
banner, support bundle, crash report dialog, stack export/import, time-travel state
timeline. All real, all require substrate Conductor doesn't have. Revisit individually
if one becomes the actual bottleneck.
---

## Suggested order

1. **Restart policy** — smallest diff, closes a loop that's already 90% built.
2. **`log_line` probe** — independent of #1, unblocks a class of services outright.
3. **Watch-and-restart** — reuses #1's machinery.
4. **Failure diagnosis panel** — no new subsystem, pure assembly.
5. **Resource alerts** — sampling (`MetricCollector`) is already wired; build threshold/notify logic and a UI chart.

Retention + FTS folds into backlog item 6 whenever that comes up.
---

## Progress

Build order follows the section above. Checked items are in the working tree, not committed.

- [x] **1. Restart policies** — `restart: manual | on_failure | always` on `CommandSchema`, keyed on process exit
  - [x] `restart` field in `packages/core/src/config/schema.ts`
  - [x] Mirrored in the API command schema (`packages/core/src/api.ts`)
  - [x] Intentional-stop flag on `ProcessWrapper` so a deliberate `stop()` is not read as a crash
  - [x] Policy branch in `SpawnQueue` with attempt cap (5) + exponential backoff (1s → 30s), budget
        resetting after 60s of stable uptime or on a manual restart
  - [x] Backoff timer deliberately not `unref`'d — signal listeners alone don't hold Bun's loop, so an
        unref'd timer would let `conductor run` exit instead of performing the restart it scheduled
  - [x] Documented in `docs/CONFIG.md` — the only discovery path while the field is YAML-only
  - [x] Runnable check: five cases in `packages/core/test/queue.test.ts`
  - [x] UI: `Restart policy` select in `CommandForm.tsx` + `restart` on `CommandInfo`
        (`packages/ui/src/lib/api.ts`). The form always sends the value — `undefined` in a PATCH
        body is dropped by `JSON.stringify`, so an omitted field could never switch a command back
- [x] **2. `log_line` probe** — shipped in #66
- [x] **3. Watch-and-restart** — `FileWatcher` (`packages/core/src/monitor/file-watcher.ts`), owned by `SpawnQueue`
  - [x] One recursive `fs.watch` on the resolved `cwd`, `Bun.Glob` matching, 500ms debounce
  - [x] Build-output/tool dirs (`node_modules`, `.git`, `dist`, `obj`, `target`, …) and lockfiles skipped before matching, so a build writing
        under its own glob can't restart itself in a loop
  - [x] Restarts the command, then every _running_ transitive dependent (stopped first, back up via `startMany` in
        dep order); `transitiveDependents` stayed `private`, since the watcher callback lives on `SpawnQueue`
  - [x] Watcher outlives restarts, so changes mid-restart coalesce into one follow-up; closed by `stopOne`/`stopAll`
  - [x] `resolvedCwd()` on `ProcessWrapper` replaces two copies of the cwd-resolution logic
  - [x] Runnable check: two cases in `packages/core/test/queue.test.ts` (glob/skip matching; 40-event burst → one
        restart of the service and its dependent, then two mid-restart events → exactly one follow-up)
  - [x] `watch` was already in schema, API and `CommandForm.tsx`; no CLI change (same as `restart`)
- [ ] **5. Resource alerts** — `MetricCollector` is wired (collection done); not started: `max_cpu_pct`/`max_mem_mb` threshold config + notify logic, and a UI chart against `fetchProcessMetrics`

Deferred: retention + FTS folds into backlog item 6; `restart_on_unhealthy` (restart on a health flip while the
process is still alive) is a separate field from `restart`, not a fourth enum value.
