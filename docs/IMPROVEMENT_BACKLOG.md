# Improvement Backlog (Issue Drafts)

This file contains issue-ready improvements found during a full repository analysis.
I could not create GitHub issues directly from this environment, so these are documented here for triage and copy/paste into Issues.

## 1) Implement `conductor logs` end-to-end (CLI + follow mode)

- **Priority:** High
- **Problem:** The CLI `logs` command is still a stub and does not call the core API.
- **Evidence:**
  - `/home/runner/work/conductor/conductor/packages/cli/src/commands/logs.ts`
  - `/home/runner/work/conductor/conductor/packages/core/src/api.ts` (`GET /api/logs`, `GET /api/logs/stream`)
- **Impact:** Users cannot rely on CLI logs for non-UI workflows or remote terminals.
- **Scope:**
  - Wire `conductor logs` to `GET /api/logs`
  - Support `--follow` via SSE (`/api/logs/stream`)
  - Support current filters (`--grep`, `--level`, and optional pid/command/profile)
- **Acceptance criteria:**
  - `conductor logs` returns real records
  - `conductor logs --follow` streams new events until interrupted
  - Filters are actually applied server-side

## 2) Implement `conductor stop <profile>` by calling core API

- **Priority:** High
- **Problem:** CLI stop command is currently informational text only.
- **Evidence:**
  - `/home/runner/work/conductor/conductor/packages/cli/src/commands/ps.ts` (`registerStopCommand`)
  - `/home/runner/work/conductor/conductor/packages/core/src/api.ts` (`POST /api/profiles/:profile/stop`)
- **Impact:** CLI behavior is misleading and blocks script automation.
- **Scope:** Call `POST /api/profiles/:profile/stop`, return clear success/failure output.
- **Acceptance criteria:**
  - `conductor stop dev` stops profile processes
  - Non-existing profile returns readable error
  - Exit codes are script-friendly (0 success, non-zero failure)

## 3) Normalize API route naming for Docker Compose parsing

- **Priority:** Medium
- **Problem:** Endpoint currently uses a space in path (`/api/docker compose/parse`), which is non-standard and awkward.
- **Evidence:**
  - `/home/runner/work/conductor/conductor/packages/core/src/api.ts`
  - `/home/runner/work/conductor/conductor/packages/ui/src/lib/api.ts`
  - `/home/runner/work/conductor/conductor/docs/API.md`
- **Impact:** Increases integration friction and risks client/encoding bugs.
- **Scope:**
  - Add canonical endpoint `/api/docker-compose/parse`
  - Keep legacy endpoint temporarily for compatibility
  - Update docs and UI client to canonical path
- **Acceptance criteria:**
  - Canonical endpoint works everywhere
  - Legacy route remains functional during migration window
  - Documentation references canonical path

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

## 5) Add input guards for numeric query params in API

- **Priority:** Medium
- **Problem:** Some numeric query params (`limit`, `offset`, `pid`) are parsed without robust NaN/bounds validation.
- **Evidence:**
  - `/home/runner/work/conductor/conductor/packages/core/src/api.ts` (`/api/notifications`, `/api/processes/:pid/metrics`, `/api/logs`)
- **Impact:** Invalid inputs can trigger confusing behavior and inconsistent pagination/filtering.
- **Scope:**
  - Validate/coerce with zod for querystring params
  - Enforce sane min/max values centrally
- **Acceptance criteria:**
  - Invalid numeric input returns 400 with actionable message
  - Upper/lower bounds are documented and enforced

## 6) Add retention controls for logs table growth

- **Priority:** Medium
- **Problem:** Metrics have cleanup support, but log retention policy is not implemented.
- **Evidence:**
  - Logs table schema: `/home/runner/work/conductor/conductor/packages/core/src/db/schema.sql`
  - Metrics cleanup exists: `/home/runner/work/conductor/conductor/packages/core/src/db/queries.ts` (`deleteMetricBefore`)
- **Impact:** Long-running usage may produce unbounded database growth.
- **Scope:**
  - Add configurable log retention (time-based and/or max rows)
  - Periodic cleanup task + manual cleanup command/API
- **Acceptance criteria:**
  - Log DB growth is bounded by configured policy
  - Cleanup behavior is documented and observable

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

## 8) Add audit entries for all env mutation operations

- **Priority:** Low
- **Problem:** Most mutating API operations write to `audit_log`, but env deletion currently does not.
- **Evidence:**
  - `/home/runner/work/conductor/conductor/packages/core/src/api.ts` (`DELETE /api/env/:id`)
  - `/home/runner/work/conductor/conductor/packages/core/src/db/queries.ts` (`insertAuditEntry`)
- **Impact:** Reduces traceability for sensitive configuration lifecycle events.
- **Scope:** Write audit records for env delete (and verify parity across env endpoints).
- **Acceptance criteria:**
  - Env create/update/import/delete all emit audit entries with useful details
  - Documentation confirms expected audit coverage
