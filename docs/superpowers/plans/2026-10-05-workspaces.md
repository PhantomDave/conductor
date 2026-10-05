# Workspaces & Start Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pick and switch between project folders, each with its own `.conductor.yml`, from a start screen, in one running Conductor.

**Architecture:** A `WorkspaceManager` in core owns one swappable `WorkspaceSession` (config store + DB + collectors). `buildApi`'s handlers already read `deps.*` per request, so installing a session means copying its fields into the shared deps object, plus one guard hook. The UI gates on `/api/workspaces` above `App`; the desktop host adds a native folder picker.

**Tech Stack:** Bun, TypeScript 7, Fastify 5, bun:sqlite, React 19 + Mantine 9 + TanStack Query, Tauri 2 (+ `tauri-plugin-dialog`).

**Spec:** `docs/superpowers/specs/2026-10-05-workspaces-design.md`

## Global Constraints

- Tooling: TS 7 + oxlint (`bun run lint`, `bun run lint:types`, `bun run typecheck`, `bun run format:check`). No ESLint, no TS 6.
- Tests: `bun test` (bun:test). No new test frameworks.
- Without `deps.workspaces`, `buildApi` behaviour must be byte-for-byte unchanged.
- The env var names are exactly `CONDUCTOR_START_SCREEN` (value `"1"`) and `CONDUCTOR_DATA_DIR`.
- The recent list file is exactly `workspaces.json`, capped at 20 entries.
- Before every commit, run the `run-desktop` skill (Dave's standing rule).
- Commits are conventional style (`feat(core): …`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on a branch; the PR is squash-merged.

## Review Focus

1. **Re-opening the workspace that is already open** must not stop its processes; it returns `current` unchanged. → Task 4 test `open(current) is a no-op`.
2. **A recent entry whose folder was deleted** is listed with `missing: true`. Opening it returns 400 "Folder not found", and it can still be removed. → Task 4 test.
3. **A corrupt or empty `workspaces.json`** must not crash boot; it reads as `[]`. → Task 2 test.
4. **A path typed as `~/proj`, with a trailing slash, or pointing at the `.conductor.yml` file itself** resolves to the same workspace and does not create a duplicate recent entry. → Task 3 test `resolveWorkspaceDir`.
5. **A request arriving mid-switch** (slow `stop_timeout_ms`) gets 409 "workspace switch in progress" and never starts processes in the workspace being torn down. → Task 4 test.

---

### Task 1: Commit the spec and plan

- [ ] Create a branch: `git checkout -b feat/workspaces`.
- [ ] Copy the **Spec** section of this file to `docs/superpowers/specs/2026-10-05-workspaces-design.md`, and the **Implementation Plan** section to `docs/superpowers/plans/2026-10-05-workspaces.md`.
- [ ] Commit: `docs: workspaces + start screen design and plan`.

### Task 2: Recent-workspaces registry

**Files:** Create `packages/core/src/workspace/recent.ts` · Test `packages/core/test/workspace-recent.test.ts` · Modify `packages/core/src/index.ts` (add `export * from "./workspace/recent"`).

**Interfaces — Produces:**

```ts
export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: string; /* ISO */
}
export function readRecent(dataDir: string): RecentWorkspace[];
export function recordRecent(dataDir: string, entry: { path: string; name: string }): void; // sets lastOpened=now
export function forgetRecent(dataDir: string, path: string): void;
```

- [ ] **Write the failing tests** (temp dir via `mkdtempSync`):
  - `readRecent on missing file → []`;
  - `readRecent on "{not json" and on "{}" → []`;
  - `recordRecent twice for the same path → one entry, newest name`;
  - `ordering newest first`;
  - `21 records → length 20, oldest dropped`;
  - `forgetRecent removes only that path`.
- [ ] Run `bun test packages/core/test/workspace-recent.test.ts`. Expected: FAIL (module missing).
- [ ] Implement. JSON is written with `writeFileSync` (2-space indent). Any read or parse error, or a non-array value, returns `[]`.
- [ ] Re-run. Expected: PASS.
- [ ] Commit: `feat(core): recent workspaces registry`.

### Task 3: WorkspaceSession (extract from server.ts)

**Files:** Create `packages/core/src/workspace/session.ts` · Modify `packages/core/bin/server.ts` (use `openSession` in place of the inline wiring at lines 28–76 and the retention interval at 92–105) · Modify `packages/core/src/index.ts` · Test `packages/core/test/workspace-session.test.ts`.

**Interfaces — Produces:**

```ts
export function resolveWorkspaceDir(input: string): string; // ~ expansion, resolve, .conductor.yml → dirname; throws ConfigError("Folder not found: …")
export interface WorkspaceSession {
  dir: string;
  name: string; // name = config.name
  store: ConfigStore;
  queries: ConductorQueries;
  logger: ConductorLogger;
  onLog: LogHandler;
  close(): Promise<void>;
}
export interface SessionOptions {
  dbPath?: string;
  broadcaster: LogBroadcaster;
  logLevel?: string;
}
export function prepareSession(dir: string): { configPath: string; config: ConductorConfig }; // validate/create only, no DB
export function openSession(dir: string, opts: SessionOptions): WorkspaceSession;
```

- `prepareSession`: if `<dir>/.conductor.yml` is missing, `saveConfig` a `createDefaultConfig()` with `name: basename(dir)`, and write `<dir>/.conductor/.gitignore` = `"*\n"`. Then `loadConfig` (throws ConfigError on bad YAML).
- `openSession`: calls `prepareSession`. `dbPath` defaults to `join(dir, DEFAULT_DB_PATH)`. It moves the `onLog`, `MetricCollector` and retention-interval code from `server.ts` verbatim and starts the collector. `close()` = `Promise.all(queues.stopAll())`, then `collector.stop()`, `clearInterval`, `db.close()`.

- [ ] **Write the failing tests:**
  - `resolveWorkspaceDir`: `~/x` → `join(homedir(),"x")`; `"/tmp/a/"` and `"/tmp/a/.conductor.yml"` both → `"/tmp/a"`; a missing dir throws a ConfigError matching `/Folder not found/`.
  - `prepareSession on empty dir creates .conductor.yml with name=basename and .conductor/.gitignore === "*\n"`.
  - `prepareSession on invalid YAML throws ConfigError and creates no DB file`.
  - `openSession → start a long-running command (e.g. "sleep 30") → close() → process is gone and queries throw` (closed DB).
- [ ] Run. Expected: FAIL.
- [ ] Implement `session.ts`. Rewire `server.ts` to `const session = openSession(dir, { broadcaster })` and pass `session.*` into `buildApi`. Its behaviour must stay identical; it is temporary until Task 4.
- [ ] Run `bun test` (whole suite) and `bun run typecheck`. Expected: PASS.
- [ ] Commit: `refactor(core): extract per-config WorkspaceSession from server.ts`.

### Task 4: WorkspaceManager, API routes, guard, boot modes

**Files:** Create `packages/core/src/workspace/manager.ts` · Modify `packages/core/src/api.ts` (`ApiDependencies` + routes + `onRequest` hook, registered right after cors) · Modify `packages/core/bin/server.ts` · Modify `packages/core/test/fixtures/api-harness.ts` (build through the manager, `dbPath: ":memory:"`) · Test `packages/core/test/workspace-manager.test.ts` · Docs: `docs/API.md` (new routes), `docs/ARCHITECTURE.md` (session/manager in Data Flow + layout), `docs/CLI.md` (the "a workspace is your cwd" note).

**Interfaces:**

- Consumes: `openSession`, `prepareSession`, `resolveWorkspaceDir` (Task 3); `readRecent`, `recordRecent`, `forgetRecent` (Task 2).
- Produces:

```ts
export class WorkspaceBusyError extends Error {}
export class WorkspaceManager {
  constructor(opts: { dataDir: string; deps: ApiDependencies; session: SessionOptions });
  get current(): WorkspaceSession | null;
  get switching(): boolean;
  open(input: string): Promise<WorkspaceSession>;
  close(): Promise<void>;
  list(): {
    current: { path: string; name: string } | null;
    recent: (RecentWorkspace & { missing: boolean })[];
  };
  forget(path: string): void;
}
// ApiDependencies gains: workspaces?: WorkspaceManager
```

- **Installing a session:** `Object.assign(deps, { store, queries, logger, onLog })`. Mark this with a comment in `server.ts`: `// ponytail: deps fields are unset until a workspace opens; the onRequest guard keeps handlers from running before that` (construct deps with `as ApiDependencies`).

- [ ] **Write the failing tests** (two temp workspace dirs A, B; a manager over a fresh `buildApi`):
  - `GET /api/profiles with no workspace → 409 "no workspace open"`; `/api/health → 200`.
  - `open A then open B: A's running process is stopped, /api/profiles serves B's config`.
  - `open B with invalid YAML → 400; A still current and its process still running`.
  - `open(current) is a no-op`: same session object, process still running (Review Focus 1).
  - `open while another open is in flight → 409 "workspace switch in progress"`, making A's close slow with a command `run: "trap '' TERM; sleep 30"`, `stop_timeout_ms: 1500`, skipped on win32 with `test.skipIf(process.platform === "win32")` because CI runs a Windows matrix. While the switch is running, `/api/profiles/dev/run` also returns 409 (Review Focus 5).
  - `deleted folder in recent → list().recent[i].missing === true; open → 400 /Folder not found/; DELETE removes it` (Review Focus 2).
  - `after switching to B, a log line from B lands in B's DB, not A's`.
  - `close() → current null, guard 409 again`.
- [ ] Run. Expected: FAIL.
- [ ] Implement the manager, the routes (map ConfigError → 400 via the existing `handleConfigError`, and `WorkspaceBusyError` → 409) and the guard hook.
- [ ] **`server.ts` boot:**
  - `dataDir = process.env.CONDUCTOR_DATA_DIR ?? process.cwd()`.
  - `CONDUCTOR_START_SCREEN === "1"` → seed the legacy `<dataDir>/.conductor.yml` if the recent list is empty; open nothing.
  - Otherwise → today's discover/bootstrap path, then `await manager.open(dirname(configPath))`.
  - `shutdown` → `await manager.close()`.
- [ ] Update the api-harness to use the manager. Run `bun test` (core + cli + ui suites all use the harness). Expected: PASS.
- [ ] Update docs. Run `bun run lint && bun run lint:types && bun run typecheck && bun run format:check`.
- [ ] Run the `run-desktop` skill, then commit: `feat(core): workspaces — swap the active conductor.yml at runtime`.

### Task 5: UI start screen, gate, sidebar switch

**Files:** Create `packages/ui/src/components/StartScreen.tsx`, `packages/ui/src/components/WorkspaceGate.tsx`, `packages/ui/src/hooks/useWorkspaces.ts` · Modify `packages/ui/src/main.tsx` (wrap `<App/>`), `packages/ui/src/components/Sidebar.tsx` (name + Switch action), `packages/ui/src/lib/api.ts`, `packages/ui/src/vite-env.d.ts` only if the `invoke` typing needs changing · Test `packages/ui/test/api.test.ts`.

**Interfaces:**

- Consumes: the Task 4 routes.
- Produces in `lib/api.ts`: `fetchWorkspaces(): Promise<WorkspaceList>`, `openWorkspace(path: string): Promise<{path:string;name:string}>`, `closeWorkspace(): Promise<void>`, `forgetWorkspace(path: string): Promise<void>`, and the types `WorkspaceList` / `RecentWorkspaceInfo` mirroring `manager.list()`.

- [ ] **Write the failing contract tests** in `api.test.ts` (the harness has the sample workspace open):
  - `fetchWorkspaces → current.name equals the sample config's name, recent contains it`;
  - `openWorkspace on a nonexistent path rejects with /Folder not found/`.
- [ ] Run `bun test packages/ui/test/api.test.ts`. Expected: FAIL.
- [ ] Implement the helpers, using the same error-unwrapping style as the existing helpers in `api.ts`.
- [ ] Implement `useWorkspaces` (a TanStack `useQuery` on `["workspaces"]`). `WorkspaceGate` shows a Mantine `Loader` while pending and `StartScreen` when `current === null`, otherwise renders its children.
- [ ] Implement `StartScreen`:
  - Reuse `ConductorMark`. Recent rows: `Text` name, dimmed path, relative time via `Intl.RelativeTimeFormat`, `ActionIcon` ✕ → `forgetWorkspace`. Missing rows get `opacity 0.5` and "folder not found".
  - Open: if `window.__TAURI__`, call `invoke<string | null>("pick_folder")`; else show a `TextInput` + Open button.
  - After a successful open: `window.location.reload()`. Errors go into an inline `Alert`.
- [ ] Sidebar: the current workspace name (from `useWorkspaces`) above the nav, plus a "Switch workspace" `NavLink`. If the processes poll shows any `running`, confirm with `window.confirm("This stops N running processes. Continue?")`. Then `closeWorkspace()` → reload.
- [ ] Run `bun test`, `bun run typecheck`, `bun run lint`. Then the `run-desktop` skill (headless Chromium):
  - with `CONDUCTOR_START_SCREEN=1`, the start screen shows;
  - opening a temp folder through the path field loads the dashboard;
  - Switch workspace returns to the start screen;
  - the temp folder is listed in the recent list.

  Screenshot each.

- [ ] Commit: `feat(ui): workspace start screen and switcher`.

### Task 6: Desktop host — start-screen mode + native folder picker

**Files:** Modify `packages/desktop-tauri/src-tauri/Cargo.toml` (add `tauri-plugin-dialog = "2"`), `src-tauri/src/main.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/sidecar-ui.json`.

**Interfaces — Produces:** `#[tauri::command] async fn pick_folder(app: AppHandle) -> Option<String>`, invoked from the UI as `invoke("pick_folder")`.

- [ ] In `start_sidecar`, add `.env("CONDUCTOR_START_SCREEN", "1")` and `.env("CONDUCTOR_DATA_DIR", data_dir.to_string_lossy().to_string())`; the `data_dir` clone happens before `current_dir`.
- [ ] `.plugin(tauri_plugin_dialog::init())`. Implement `pick_folder` with `app.dialog().file().pick_folder(callback)` bridged through a `tokio::sync::oneshot`. Use the non-blocking form; the blocking one must not run on the async runtime. Return `path.to_string()`.
- [ ] Add `"pick_folder"` to `build.rs` `commands(&[...])` and `"allow-pick-folder"` to `sidecar-ui.json` `permissions`.
- [ ] Run `cargo check` in `src-tauri`, then the `run-desktop` skill (sidecar boots in start-screen mode under `CONDUCTOR_DATA_DIR`; the legacy `.conductor.yml` in that dir appears in the recent list). The native dialog can't be screenshotted on this host; note that in the PR as a manual check for Dave.
- [ ] Commit: `feat(desktop): start on the workspace picker, native folder dialog`.

### Task 7: Finish

- [ ] Full verification: `bun test && bun run lint && bun run lint:types && bun run typecheck && bun run format:check`.
- [ ] Final `run-desktop` pass.
- [ ] Hand off to `superpowers:finishing-a-development-branch` (push / PR as PhantomDave, squash).

## Verification (end-to-end)

1. `bun test`: the new workspace-recent, workspace-session and workspace-manager suites, plus the existing core/cli/ui suites through the manager-backed harness.
2. `run-desktop` skill with `CONDUCTOR_START_SCREEN=1`:
   - start screen → open temp folder A → dashboard → start a command;
   - Switch → confirm → start screen → open B → A's process is gone (`ps`), and B's DB is under `B/.conductor/data/`.
3. Manual (Dave, real desktop window): the **Open folder…** native dialog returns a path and opens it.
