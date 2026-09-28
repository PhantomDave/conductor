import type { LogRow } from "./api";

/**
 * Adds `incoming` to `rows`, skipping ids already present, ordered by id.
 * LogViewer fills from two overlapping sources - the /api/logs history fetch
 * and the SSE stream, which replays the same recent history before tailing -
 * and either can land first, so both go through here.
 */
export function mergeLogs(rows: LogRow[], incoming: LogRow[]): LogRow[] {
  const seen = new Set(rows.map((r) => r.id));
  const fresh = incoming.filter((r) => !seen.has(r.id) && seen.add(r.id));
  if (fresh.length === 0) return rows;
  return [...rows, ...fresh].sort((a, b) => a.id - b.id);
}
