# Workspaces & Start Screen — Design

## Context

Conductor's sidecar boots against exactly one `.conductor.yml`, picked at startup by walking up from cwd. The desktop app runs the sidecar with `cwd = app_data_dir`, so it has a single hidden global config and can only be aimed at a project through `base_path`. Dave wants one app that manages completely separate projects. Each project has its own `conductor.yml`, chosen from a start screen.

**Naming:** "profile" already means a command set _inside_ `conductor.yml`. The new concept is called a **workspace**: one folder = one `<folder>/.conductor.yml`.

**Decisions made with Dave:**

- One workspace active at a time. Switching stops the old workspace's processes.
- A workspace is a project folder. Its `.conductor.yml` lives in that folder, the same file the CLI discovers from cwd.
- The desktop app always opens on the start screen.
- Switching is swapped inside the sidecar, not done by restarting the sidecar process.

## Spec

### Core engine

- **WorkspaceSession** (`packages/core/src/workspace/session.ts`): `openSession(dir)` builds everything today's `server.ts main()` builds from one config: the logger (with `env_secrets`), the SQLite DB at `<dir>/.conductor/data/conductor.sqlite`, `ConductorQueries`, `ConfigStore`, `onLog`, `MetricCollector` (5s / 24h) and the hourly log-retention timer. `close()` stops every queue (`stopAll`, which respects stop_signal/timeout), stops the collector, clears the timer and closes the DB. **The session is the unit that gets swapped.**
- **Exact folder.** Opening `<dir>` uses exactly `<dir>/.conductor.yml`, with no walking up. If the file is missing, create `createDefaultConfig()` with `name = basename(dir)` and write `<dir>/.conductor/.gitignore` containing `*`.
- **Path input.** Expand a leading `~` to `homedir()`, then `resolve()`. If the path points at a `.conductor.yml` file, use its dirname. If the result is not an existing directory, throw `ConfigError("Folder not found: <path>")`.
- **WorkspaceManager** (`packages/core/src/workspace/manager.ts`): owns `current` and a `switching` flag.
  - `open(dir)`: load and validate the new config **first**. On error, throw and leave `current` untouched.
  - If `dir` is already the current workspace, return it with no restart.
  - Otherwise: `await current.close()`, open the new session, install it into the API deps, and record it as recent.
  - A concurrent `open`/`close` throws `WorkspaceBusyError`.
- **Recent list** (`packages/core/src/workspace/recent.ts`): `<CONDUCTOR_DATA_DIR>/workspaces.json`, an array of `{ path, name, lastOpened }`. Newest first, de-duplicated by path, capped at 20. A missing or corrupt file reads as `[]`.
- **API**, active only when `deps.workspaces` is set; without it `buildApi` behaves exactly as today:

  | Route                              | Behaviour                                                                              |
  | ---------------------------------- | -------------------------------------------------------------------------------------- |
  | `GET /api/workspaces`              | `{ current: {path,name} \| null, recent: (RecentWorkspace & { missing: boolean })[] }` |
  | `POST /api/workspaces/open {path}` | 200 → `{path,name}`; 400 on ConfigError; 409 while switching                           |
  | `POST /api/workspaces/close`       | 200 `{}`; 409 while switching                                                          |
  | `DELETE /api/workspaces?path=`     | Removes the entry from the recent list only, never files. 200 `{}`                     |
  - **Guard (`onRequest` hook):** with no current session, or while switching, every `/api/*` route except `/api/health` and `/api/workspaces*` returns 409 `{ error: "no workspace open" | "workspace switch in progress" }`.

- **Boot** (`bin/server.ts`):
  - `CONDUCTOR_DATA_DIR`, if unset, defaults to `process.cwd()` in start-screen mode and to `<config dir>/.conductor/data` in discovery mode (amended after the final review: a cwd default left a stray `workspaces.json` wherever core was run).
  - `CONDUCTOR_START_SCREEN=1`: no session at boot. If `<dataDir>/.conductor.yml` exists and the recent list is empty, seed the list with it (this is the legacy desktop config).
  - Otherwise: today's discovery/bootstrap picks the dir, then `manager.open(dir)`.
  - SIGTERM/SIGINT run `manager.close()` (closing the _current_ session), then app close.

### UI

- **`WorkspaceGate`**, in `main.tsx` around `<App/>`: fetches `/api/workspaces`. If `current` is null it renders `<StartScreen/>`; otherwise `<App/>`. `App` itself is unchanged.
- **`StartScreen`:**
  - Conductor mark and a list of recent workspaces: name, path, relative last-opened time, ✕ to remove. Missing folders are shown dimmed with "folder not found".
  - **Open folder…** calls `window.__TAURI__.core.invoke("pick_folder")` in the desktop app, or shows a path `TextInput` in a plain browser.
  - Server errors are shown inline.
  - On success: `window.location.reload()`.
- **Sidebar:** shows the current workspace name and a **Switch workspace** action. It confirms first ("This stops N running processes") when processes are running, calls `POST /api/workspaces/close`, then reloads.

### Desktop

- `main.rs` passes `CONDUCTOR_START_SCREEN=1` and `CONDUCTOR_DATA_DIR=<app_data_dir>`.
- New Tauri command `pick_folder() -> Option<String>` using `tauri-plugin-dialog`, called from Rust only. Register it in `build.rs`'s `commands(&[...])` and grant `allow-pick-folder` in `capabilities/sidecar-ui.json`.

### CLI

No new commands. The CLI is already per workspace: `cd` into the folder and its cwd discovery finds `.conductor.yml`. A `conductor workspace open` command over the API couldn't reach the desktop sidecar, which listens on a random port. Document this in `docs/CLI.md`.
