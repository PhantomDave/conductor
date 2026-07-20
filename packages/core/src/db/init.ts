// The `*.sql` text-import ambient type below needs to be visible to
// consumers (e.g. the CLI package's separate tsc program) that don't
// glob-include this file, hence the triple-slash reference.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
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
  mkdirSync(dirname(filePath), { recursive: true });

  const db = new Database(filePath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schemaSql);

  return db;
}

export const DEFAULT_DB_PATH = ".conductor/data/conductor.sqlite";
