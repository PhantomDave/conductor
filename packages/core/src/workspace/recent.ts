import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_ENTRIES = 20;

export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: string /* ISO */;
}

function filePath(dataDir: string): string {
  return join(dataDir, "workspaces.json");
}

/** Reads the recent-workspaces list. Any missing file, parse error, or non-array value yields []. */
export function readRecent(dataDir: string): RecentWorkspace[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath(dataDir), "utf-8"));
    return Array.isArray(parsed) ? (parsed as RecentWorkspace[]) : [];
  } catch {
    return [];
  }
}

function write(dataDir: string, entries: RecentWorkspace[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(filePath(dataDir), JSON.stringify(entries, null, 2));
}

/** Upserts `entry` with `lastOpened` set to now, keeping the list newest-first and capped at 20. */
export function recordRecent(dataDir: string, entry: { path: string; name: string }): void {
  const entries = readRecent(dataDir).filter((e) => e.path !== entry.path);
  entries.unshift({ ...entry, lastOpened: new Date().toISOString() });
  write(dataDir, entries.slice(0, MAX_ENTRIES));
}

/** Removes the entry for `path`, if present. */
export function forgetRecent(dataDir: string, path: string): void {
  write(
    dataDir,
    readRecent(dataDir).filter((e) => e.path !== path),
  );
}
