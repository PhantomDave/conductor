# Improvement Backlog (Issue Drafts)

This file contains issue-ready improvements found during a full repository analysis.
I could not create GitHub issues directly from this environment, so these are documented here for triage and copy/paste into Issues.

Items 1, 2, 3, 5, 6, and 8 shipped and were removed from this file — see
[docs/TODO.md](./TODO.md)'s "Already shipped" table for the evidence. Numbering below is kept
as-is (not renumbered) since `TODO.md` cross-references these entries by number.

## 4) Add CLI and UI automated tests

- **Priority:** High
- **Problem:** Existing tests are concentrated in `packages/core`; CLI and UI currently have no test coverage.
- **Evidence:**
  - Core tests exist in `/home/runner/work/conductor/conductor/packages/core/test/*.test.ts`
  - No test files under `/home/runner/work/conductor/conductor/packages/cli` and `/home/runner/work/conductor/conductor/packages/ui`
- **Impact:** Regressions in command behavior and UI/API integration can ship unnoticed.
- **Scope:**
  - Add CLI tests for `run`, `list`, `config`, `env`, `ps`, `stop`, `logs`
  - Add UI unit/integration tests for API hooks and critical workflows
- **Acceptance criteria:**
  - CI runs CLI/UI tests
  - Failing behavior in command parsing/API contract is caught by tests

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
