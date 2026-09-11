---
name: run-desktop
description: Build, launch and smoke-test the Conductor Electron desktop app (packages/desktop). Use before EVERY commit (Dave's standing rule), and whenever asked to run, screenshot or verify the desktop app.
---

Launches the real Electron app, confirms the dashboard renders (not a blank window), checks the sidecar API from inside the page, clicks through the UI, then quits and confirms the sidecar shut down cleanly. It takes about 5 seconds once everything is built.

Run all commands from the repo root.

## Prerequisites (once per checkout)

```bash
bun install
# bun skips electron's postinstall. This extracts the binary from ~/.cache/electron.
node packages/desktop/node_modules/electron/install.js
```

`playwright-core` is a root devDependency, and the driver imports it.

## Build (after any source change)

```bash
bun run --cwd packages/core build:sidecar   # -> packages/core/dist-bin/conductor-server
bun run --cwd packages/ui build             # -> packages/ui/dist
bun run --cwd packages/desktop build:main   # -> packages/desktop/dist/main.js
```

## Run

```bash
node .claude/skills/run-desktop/smoke.mjs            # optional args: [desktopDir] [outDir]
```

Exit codes: 0 means every check passed, 1 means a check failed, and 2 means something is missing or the run hung (the missing piece and its fix command are printed). Look at the screenshots (`01-dashboard.png`, `02-environment-tab.png`) and `main-process.log` in the printed artifacts dir (default `$TMPDIR/conductor-electron-smoke`). A blank screenshot is a failure even if every check passes.

## What it checks

- The window loads the sidecar URL and `#root` renders real content.
- The main window is visible and its renderer hasn't crashed.
- `/api/health`, `/api/profiles` and `/api/processes` return 200 from inside the page.
- Clicking nav → Environment opens the view, and clicking an unselected scope tab selects it.
- There are no renderer console errors.
- The main process logged `Window loaded, showing`.
- No abnormal `Renderer process gone`.
- The sidecar exits with code 0 when the app quits.

## Gotchas

- **Never add `--no-sandbox`.** Many generic Electron recipes include it. Here it tears down Chromium's sandbox, and the renderer dies with SIGTRAP as soon as a page loads, which looks like a blank white window (#56). `main.ts` already sets `disable-setuid-sandbox`, which is enough.
- **The window really opens on your display.** This host has no xvfb, so a window appears on the Wayland session for a few seconds. The app requires `DISPLAY` or `WAYLAND_DISPLAY` to be set.
- **userData is isolated.** `XDG_CONFIG_HOME` points into the artifacts dir, so the run never touches the real `~/.config` workspace or SQLite DB. It always starts with a fresh `default` profile.
- **A fresh workspace has no processes, so ProcessBoard has no tabs.** That's why the driver clicks through the Environment view instead.
- **After a fresh `bun install`, `node_modules/electron/dist` is missing.** Re-run the `install.js` command above.
