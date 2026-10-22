import { test, expect } from "bun:test";
import { openDatabase } from "../src/db/init";
import { ConductorQueries } from "../src/db/queries";

const line = (message: string) => ({
  process_id: "10",
  command_id: "api",
  profile: "dev",
  timestamp: new Date().toISOString(),
  level: "info",
  stream: "stdout" as const,
  message,
});

test("insertLogs writes a batch with increasing ids, session stamps and FTS entries", () => {
  const queries = new ConductorQueries(openDatabase(":memory:"));
  const sessionId = queries.insertSession("dev");

  const rows = queries.insertLogs([line("alpha one"), line("beta two"), line("gamma three")]);

  expect(rows.map((r) => r.message)).toEqual(["alpha one", "beta two", "gamma three"]);
  expect(rows[1]!.id).toBe(rows[0]!.id + 1);
  expect(rows[2]!.id).toBe(rows[1]!.id + 1);
  expect(rows.every((r) => r.session_id === sessionId)).toBe(true);
  expect(queries.queryLogs({ grep: "beta" }).map((r) => r.id)).toEqual([rows[1]!.id]);
});

test("insertLogs with an empty batch is a no-op", () => {
  const queries = new ConductorQueries(openDatabase(":memory:"));
  expect(queries.insertLogs([])).toEqual([]);
  expect(queries.queryLogs({})).toEqual([]);
});
