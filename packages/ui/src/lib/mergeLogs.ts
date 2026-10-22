import type { LogRow } from "./api";

/** The live viewer keeps only the newest lines; older output stays in History. */
export const MAX_LOG_ROWS = 5000;

/**
 * Adds `incoming` to `rows`, skipping ids already present, ordered by id, and
 * keeps the newest `max`. LogViewer fills from two overlapping sources - the
 * /api/logs history fetch and the SSE stream, which replays the same recent
 * history before tailing - and either can land first, so both go through here.
 */
export function mergeLogs(rows: LogRow[], incoming: LogRow[], max = MAX_LOG_ROWS): LogRow[] {
  if (incoming.length === 0) return rows;
  let merged: LogRow[];
  if (isAppend(rows, incoming)) {
    // The live tail: ids only grow, so no dedup or sort needed.
    merged = rows.concat(incoming);
  } else {
    const seen = new Set(rows.map((r) => r.id));
    const fresh = incoming.filter((r) => !seen.has(r.id) && seen.add(r.id));
    if (fresh.length === 0) return rows;
    merged = [...rows, ...fresh].sort((a, b) => a.id - b.id);
  }
  return merged.length > max ? merged.slice(-max) : merged;
}

/** Whether `incoming` is strictly increasing and starts after the last of `rows`. */
function isAppend(rows: LogRow[], incoming: LogRow[]): boolean {
  let last = rows.at(-1)?.id ?? -Infinity;
  for (const row of incoming) {
    if (row.id <= last) return false;
    last = row.id;
  }
  return true;
}
