# TypeScript 7 Migration Plan

**Status:** complete (2026-09-11): Phase 1 #61, Phase 2 #62, Phase 3 #63, Phase 4 #64; decisions in [Decisions](#decisions) · **Baseline:** `main` after #57 and #58 (TypeScript 6.0.3, ESLint + typescript-eslint, strict lint in CI; Dependabot proposes TS 7 bumps, which fail Lint until Phase 1 lands)

## Goal

Make TypeScript 7 (the native Go compiler) the only TypeScript in the repo, for typechecking and the editor, and lint with [oxlint](https://oxc.rs/docs/guide/usage/linter) instead of ESLint + typescript-eslint.

## Why this needs a linter swap

typescript-eslint loads the compiler with `require("typescript")`. TypeScript 7 has no JS compiler API: its package `main` is a version shim. That's why lint crashed at module load after the TS 7 bump (#57). Even typescript-eslint 8.70.0 and its canary still declare `typescript: >=4.8.4 <6.1.0`, and [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940) has no timeline. As long as we use typescript-eslint, we can't use TS 7.

oxlint doesn't depend on `typescript` at all. Its type-aware mode runs on [`oxlint-tsgolint`](https://www.npmjs.com/package/oxlint-tsgolint), which is built on typescript-go (the TS 7 codebase). So type-aware linting keeps pace with TypeScript instead of lagging behind it.

## Measurements (2026-09-11, on the #57 tree)

|                                                                                   | Result                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `tsc --noEmit`, TS 6.0.3, 4 packages                                              | ~4.1 s, pass                                            |
| `tsc --noEmit`, TS 7.0.2, 4 packages                                              | ~0.8 s, pass, no tsconfig changes needed                |
| oxlint 1.82.0, default rules                                                      | 77 files in 26 ms, 0 findings                           |
| oxlint with our ESLint rule set (`no-explicit-any`, `no-unused-vars`, `no-empty`) | 0 findings (parity with the current clean ESLint run)   |
| oxlint + react plugin (`exhaustive-deps`, `rules-of-hooks`)                       | 3 findings (react-hooks was never enabled under ESLint) |
| oxlint + `react/set-state-in-effect`                                              | 6 findings                                              |
| oxlint `--type-aware` (oxlint-tsgolint 7.0.2001)                                  | 512 ms, 69 findings (see Phase 4)                       |

## Phases

Each phase is its own PR: separately green, separately revertable. Run the full [verification checklist](#verification-checklist-every-phase), **including the Electron smoke test**, before every commit.

### Phase 1: Replace ESLint with oxlint at parity (TS 6 stays)

Changing the linter and the compiler at the same time would make any regression hard to attribute, so this phase only swaps the linter.

1. `bun add -d oxlint playwright-core` (`playwright-core` drives the Electron smoke test in `.claude/skills/run-desktop/`).
2. Generate a config with `bunx @oxlint/migrate eslint.config.js`, then hand-review the resulting `.oxlintrc.json`. Target:
   - default `correctness` category
   - `typescript/no-explicit-any: error`
   - `no-unused-vars: ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }]`
   - `no-empty: error`
   - the other `eslint:recommended` / typescript-eslint `recommended` rules that aren't in `correctness`, named explicitly for parity; `no-undef` and `no-redeclare` only for plain JS files (as typescript-eslint had them)
   - `ignorePatterns`: `**/dist/**`, `**/build/**`, `**/node_modules/**`
3. Change the `lint` script to `oxlint --deny-warnings` (the equivalent of `--max-warnings 0`). The CI step is unchanged because the script name stays the same.
4. Remove `eslint`, `@eslint/js`, `typescript-eslint` and `eslint.config.js`.
5. **Prove the rules fire:** in a scratch file, add one explicit `any`, one unused variable and one empty block, and confirm each is reported. A clean run alone doesn't prove the rules are enabled.
6. Docs: CONDUCTOR.md `lint` row → "oxlint over all .ts/.tsx"; TROUBLESHOOTING "fails on a warning" entry → mention `--deny-warnings`.

**Exit:** `bun run lint` has 0 findings; seeded violations are reported; CI passes.

### Phase 2: Enable React hooks rules

1. Enable the react plugin in `.oxlintrc.json` (`"plugins": ["typescript", "react", ...]`) with `react/rules-of-hooks`, `react/exhaustive-deps` and `react/set-state-in-effect` as errors. The hooks rules are reported as `react-hooks(...)`; re-check the names in the config and seed one violation per rule to prove each fires.
2. Fix the 3 hooks findings:
   - `packages/ui/src/components/DependencyFlow.tsx:327` and `:333`: the `statusSignature` dependency is intentional (a poll-stable stand-in for `processes`). Add back a suppression, this time for a rule that exists: `// oxlint-disable-next-line react/exhaustive-deps -- <reason>`.
   - `packages/ui/src/components/EnvironmentManager.tsx:149`: `useEffect` is missing the `value` dependency. Treat it as a possible stale-closure bug and investigate before silencing.
3. Fix the 6 `react/set-state-in-effect` findings properly (derive the state, move the logic into event handlers, or reset with a `key`), without suppressions. Exercise every touched component in the running app.

### Phase 3: Switch the compiler to TypeScript 7

1. Change `typescript` from `^6.0.3` to `^7.0.2` in the root and `packages/desktop` `package.json`, then `bun install`. The lockfile should drop TS 6 and add the `@typescript/typescript-<platform>` native binaries.
2. Close any open Dependabot `typescript` 7.x bump PRs. Before Phase 1 they failed CI's Lint step; after Phase 1 they can pass CI, so they stay unmerged by hand until this phase replaces them. Once the manifests are on 7.x, Dependabot stops proposing them.
3. Check that nothing still needs the TS JS API:
   - `git grep -n "from \"typescript\"\|require(\"typescript\")" -- packages` should be empty.
   - `ts-api-utils` should be gone from `bun.lock`; it came with typescript-eslint.
   - `config-file-ts` (via electron-builder) only matters for TypeScript builder configs. Ours is `electron-builder.yml`, so it isn't affected.
   - Prettier ships its own TypeScript parser and doesn't depend on the installed compiler.
4. Confirm every workspace resolves TS 7: `bun run --cwd packages/<pkg> tsc --version` should print 7.x for core, cli, ui and desktop.
5. Docs:
   - Replace the TROUBLESHOOTING "typescript-eslint does not support TS 7.0" section.
   - ARCHITECTURE: note TS 7 and oxlint.
   - Point editor users at the TypeScript Native Preview extension and the oxc VS Code extension.

**Exit:** the full checklist passes, including cross-OS CI. TS 7's platform binaries already installed and ran on the ubuntu/macos/windows test matrix before #57.

### Phase 4: Type-aware linting (required CI step)

Add `oxlint-tsgolint` and run `oxlint --type-aware`. Baseline on the #57 tree:

| Rule                                       | Findings | Notes                                                                                                |
| ------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `typescript/no-floating-promises`          | 49       | Mostly UI event handlers and `executor/wrapper.ts`. Fix by `await`, `.catch`, or an explicit `void`. |
| `typescript/await-thenable`                | 10       | `await` on non-promises. Usually just delete it, but check each one.                                 |
| `react/set-state-in-effect`                | 6        | Fixed in Phase 2.                                                                                    |
| `react-hooks/exhaustive-deps`              | 3        | Fixed in Phase 2.                                                                                    |
| `typescript/restrict-template-expressions` | 1        | `packages/desktop/src/main.ts:123`                                                                   |

By package: ui 50, core 17, desktop 2. Fix every finding (no baseline file, no blanket disables). Type-aware lint runs as its **own required CI step** (`lint:types`), so it can be switched off separately if tsgolint regresses. If the phase gets large, split it into consecutive PRs (per rule or package), each green and merged before the next.

**Outcome:** by the time Phase 4 ran, 58 findings remained (Phase 2's React fixes and two returned `invalidateQueries` promises had cleared the rest), and all 58 were fixed in one PR with no suppressions. The 10 `await-thenable` findings were all `await expect(promise).rejects/resolves...` in core tests. bun:test's `.rejects`/`.resolves` matchers block until the promise settles and return `undefined` (checked at runtime), so those `await`s were no-ops and were removed.

## Verification checklist (every phase)

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
```

Then the **Electron smoke test** (`.claude/skills/run-desktop/SKILL.md`):

1. Build the sidecar and UI (`bun run --cwd packages/core build:sidecar`, `bun run --cwd packages/ui build`).
2. Bundle the main process (`bun run --cwd packages/desktop build:main`).
3. Run `node .claude/skills/run-desktop/smoke.mjs`. It launches the app without `--no-sandbox` (see #56), with `XDG_CONFIG_HOME` pointed at a temp directory.
4. Confirm:
   - the dashboard renders (non-blank `#root`);
   - `/api/health`, `/api/profiles` and `/api/processes` return 200 from the renderer;
   - the nav → Environment → tab switch works;
   - there are no console errors;
   - the sidecar exits cleanly on quit.

## Risks and mitigations

| Risk                                                                   | Mitigation                                                                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| oxlint rule semantics differ from ESLint (options, edge cases)         | Phase 1 step 5 (seeded violations); keep the migrated config small and explicit  |
| A clean lint run hides a rule that silently isn't enabled              | The same seeded-violation check, repeated whenever the config changes            |
| oxlint / tsgolint release churn (both move fast)                       | Caret ranges plus Dependabot; type-aware lint is its own CI step                 |
| `no-undef` is an oxlint nursery rule (behaviour can shift in a minor)  | Scoped to plain JS files only (currently just the smoke-test driver)             |
| Between Phases 1 and 3, Dependabot's TS 7 PRs can pass CI              | Leave them unmerged; Phase 3 closes them and does the bump by hand               |
| Editor experience changes (no ESLint extension; TS 7 language service) | Document the recommended VS Code extensions in Phase 3                           |
| Something needed the TS 6 JS API after all                             | Phase 3 audit; each phase is a separate squash PR, so it can be reverted cleanly |

## Effort

Phases 1–3 are small and mechanical, since each has already been checked in isolation above: roughly an afternoon. Phase 4 is medium (69 findings, most of them in `packages/ui`) and can be spread over several PRs.

## Decisions

- **Linter:** oxlint, plus `oxlint-tsgolint` for type-aware rules. Prettier stays. (Biome could replace both the linter and the formatter, but that's a bigger, separate change.)
- **Scope:** all four phases.
- **`react/set-state-in-effect`:** enabled as an error in Phase 2; all 6 findings fixed, not suppressed.
- **Type-aware lint in CI:** required, as its own step. All findings fixed; no baseline file, no blanket disables.
