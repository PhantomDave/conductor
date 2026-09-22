---
name: run-desktop
description: Build and smoke-test the Conductor desktop sidecar (the backend packages/desktop-tauri's Rust shell spawns) via headless Chromium. Use before EVERY commit (Dave's standing rule), and whenever asked to run, screenshot or verify the desktop app.
---

This host can't screenshot a real GTK/Wayland window, so instead of driving the Tauri shell it runs the same sidecar binary Tauri's Rust host spawns, with the same `CONDUCTOR_UI_DIST` env var set on it, and points headless Chromium at its HTTP URL — Tauri and the sidecar serve byte-identical HTML/JS. It takes a few seconds once everything is built.

Run all commands from the repo root.

## Prerequisites (once per checkout)

```bash
npx playwright install chromium   # only if ~/.cache/ms-playwright has no chromium-* build
```

`playwright-core` is a root devDependency; the driver imports it directly.

## Build (after any source change)

```bash
bun run --cwd packages/core build:sidecar   # -> packages/core/dist-bin/conductor-server
bun run --cwd packages/ui build             # -> packages/ui/dist
```

No `tauri build` step needed for this check — the sidecar is what actually renders the UI; the Rust shell just spawns it and points a window at its URL.

## Run

```bash
node .claude/skills/run-desktop/smoke.mjs   # optional arg: [outDir]
```

Exit codes: 0 means every check passed, 1 means a check failed, and 2 means something is missing or the run hung (the missing piece and its fix command are printed). Look at the screenshots (`01-dashboard.png`, `02-environment-tab.png`) and `server.log` in the printed artifacts dir (default `$TMPDIR/conductor-sidecar-smoke`). A blank screenshot is a failure even if every check passes.

## What it checks

- The sidecar comes up and `/api/health` returns 200.
- `/api/profiles` and `/api/processes` also return 200.
- The page loads and `#root` renders real content (not a blank shell).
- Clicking nav → Environment opens the view, and clicking an unselected scope tab selects it.
- There are no browser console errors.
- The sidecar exits with code 0 on SIGTERM — the same signal Tauri's Rust host sends on app quit.

## Gotchas

- **Scratch `cwd`, not a scratch config flag.** The sidecar auto-creates `.conductor.yml` and its SQLite DB relative to its working directory if none exists up the tree (`packages/core/bin/server.ts`) — spawning it with `cwd` set to a fresh temp dir isolates the run from your real workspace config, no env var needed. (The old Electron version of this test used `XDG_CONFIG_HOME` for the same purpose — that trick doesn't apply here since we own the sidecar process directly.)
- **Chromium build mismatch.** `playwright-core` doesn't bundle a browser; the script scans `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome` for the newest cached build rather than hardcoding a version, since a `playwright-core` bump can leave the cache at a path an older lookup didn't expect.
- **This only proves the UI/API layer, not the Rust shell.** It can't catch a Tauri-specific regression (window chrome, `tauri.conf.json` misconfiguration, the updater, `stage-sidecar.mjs`'s binary-staging). CI's "Tauri Check" job covers the shell build; for anything touching `packages/desktop-tauri/src-tauri/`, also run `bun run --cwd packages/desktop-tauri dev` once and eyeball the real window.
- **Port 4199 is hardcoded** as a scratch port unlikely to collide with a real `conductor run` (which defaults to 4000). If it's ever in use, edit `PORT` at the top of `smoke.mjs`.
