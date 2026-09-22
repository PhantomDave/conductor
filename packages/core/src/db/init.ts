// The `*.sql` text-import ambient type below needs to be visible to
// consumers (e.g. the CLI package's separate tsc program) that don't
// glob-include this file, hence the triple-slash reference.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="../types/sql.d.ts" />
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
// Imported (not read via fs) so the schema is inlined into the bundle at
// build time - this is required for `bun build --compile` executables
// (e.g. the Electron sidecar binary), which can't `readFileSync` a
// sibling file from their virtual `/$bunfs/` filesystem the same way.
import schemaSql from "./schema.sql" with { type: "text" };

/**
 * Opens (creating if necessary) the Conductor SQLite database and applies
 * the base schema. Safe to call multiple times (idempotent DDL).
 */
export function openDatabase(filePath: string): Database {
  // ":memory:" is SQLite's special in-memory identifier, not a real path -
  // dirname() resolves it to "." and mkdirSync of the cwd throws EEXIST on
  // Windows (POSIX no-ops instead), so skip it for that one sigil value.
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  const db = new Database(filePath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  // schema.sql only uses idempotent `CREATE TABLE IF NOT EXISTS` - there's no
  // migration framework, so an already-installed DB never picks up a column
  // added to an existing table. Patch it in manually before applying schema.sql.
  const logsColumns = db.query("PRAGMA table_info(logs)").all() as Array<{ name: string }>;
  if (logsColumns.length > 0 && !logsColumns.some((c) => c.name === "session_id")) {
    db.exec("ALTER TABLE logs ADD COLUMN session_id INTEGER;");
  }

  const ftsExisted =
    (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'logs_fts'").get() as {
      1: number;
    } | null) !== null;

  db.exec(schemaSql);

  // logs_fts is external-content: it only gains rows via the AFTER INSERT
  // trigger, so a table created just now for a DB with pre-existing logs
  // starts empty. Rebuild once so old rows are searchable too; this is O(all
  // logs), so it must only run the one time the table is first created.
  if (!ftsExisted) {
    db.exec("INSERT INTO logs_fts(logs_fts) VALUES ('rebuild');");
  }

  return db;
}

export const DEFAULT_DB_PATH = ".conductor/data/conductor.sqlite";
