# Improvement Backlog (Issue Drafts)

This file contains issue-ready improvements found during a full repository analysis.
I could not create GitHub issues directly from this environment, so these are documented here for triage and copy/paste into Issues.

Items 1, 2, 3, 4, 5, 6, and 8 shipped and were removed from this file — see
[docs/TODO.md](./TODO.md)'s "Already shipped" table for the evidence. Numbering below is kept
as-is (not renumbered) since `TODO.md` cross-references these entries by number.

## 7) Add API endpoint consistency pass (`/api/command` vs `/api/commands`)

- **Priority:** Low
- **Problem:** Standalone command endpoints are singular (`/api/command`), while other resources are plural.
- **Evidence:**
  - `/home/runner/work/conductor/conductor/packages/core/src/api.ts`
  - `/home/runner/work/conductor/conductor/packages/ui/src/lib/api.ts`
- **Impact:** Inconsistent API shape adds cognitive overhead and weakens API ergonomics.
- **Scope:**
  - Introduce plural aliases (`/api/commands`) for list/create/update/delete
  - Keep old endpoints for compatibility and deprecate clearly
- **Acceptance criteria:**
  - Both singular and plural routes work during migration
  - Docs mark canonical route and deprecation timeline

## 9) Theming option: light / dark / auto colour scheme

- **Priority:** Low
- **Problem:** The UI is dark-only. Mantine 9 already supports switching schemes (`useMantineColorScheme`, `defaultColorScheme`, `light | dark | auto`), but Conductor pins dark and hard-codes dark values outside the theme.
- **Evidence:**
  - `packages/ui/src/main.tsx:18` hard-codes `defaultColorScheme="dark"`.
  - `packages/ui/src/global.css` has 27 literal `rgb()`/`rgba()`/hex values, all tuned for dark:
    - body background
    - scrollbar
    - selection
    - `code`/`pre`
    - lists
    - native inputs
    - table head and row hover
  - `LogLines.tsx:12,22` hard-codes the log text and timestamp colours, `#d4d4d4` and `#6a6a6a`.
  - `LogViewer.tsx:194` and `LogHistory.tsx:154` hard-code the log panel background, `#1e1e1e`.
  - `ProfilePickerModal.tsx:36` hard-codes a `#e0e0e0` border. It's a light-scheme leftover that already glares in dark.
  - `theme.ts` tunes only the `dark` palette. `green`/`yellow`/`red` are dark-first, and `gray` is a green-tinted dark scale, so light needs its own review.
- **Impact:** People who work in light environments, or who follow the OS setting, can't match the dashboard.
- **Scope:**
  - Move every literal above into CSS variables, with `[data-mantine-color-scheme="light"]` overrides in `global.css`.
  - Tune a light palette and check contrast: body text 4.5:1, borders and focus rings 3:1.
  - Fix the filled-button text while in there: white on `green-5` is 1.7:1, so use a dark `on-accent` colour.
  - Persist the choice server-side, not only in Mantine's default `localStorageColorSchemeManager`. The Tauri shell binds a random free port on every launch (`packages/desktop-tauri/src-tauri/src/main.rs` `find_free_port`), and `localStorage` is per-origin, so a localStorage-only preference resets on every desktop start.
    - Copy log retention's shape: a `color_scheme: "light" | "dark" | "auto"` field on `ConductorConfigSchema`, GET/PUT on the API, and a `conductor` CLI command.
    - Wire a custom `colorSchemeManager` that reads and writes through `lib/api.ts`. It can use localStorage as a flash-free cache.
  - UI: a segmented control in `EnvironmentManager.tsx`, next to log retention, plus an optional header toggle.
- **Acceptance criteria:**
  - Light, dark and auto all render with no hard-coded dark literals left in `packages/ui/src`, except the favicon/app icon, which are a dark tile by design.
  - The choice survives a desktop app restart, and matches across CLI, API and UI.
  - `auto` follows the OS `prefers-color-scheme`.
  - All text pairs meet 4.5:1 in both schemes.
  - The design system (`claude.ai/artifact/7nu6Rp9FQBk8KVSSt5Suar`) gains a `light` theme in `tokens.json`.
