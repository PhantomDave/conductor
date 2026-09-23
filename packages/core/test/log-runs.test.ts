import { test, expect } from "bun:test";
import { openDatabase } from "../src/db/init";
import { ConductorQueries } from "../src/db/queries";

test("listLogRuns groups by pid, newest first, with counts and filters", () => {
  const queries = new ConductorQueries(openDatabase(":memory:"));
  const log = (process_id: string, command_id: string, stream: "stdout" | "stderr" = "stdout") =>
    queries.insertLog({
      process_id,
      command_id,
      profile: "dev",
      timestamp: new Date().toISOString(),
      level: "info",
      stream,
      message: "x",
    });

  log("10", "api");
  log("10", "api", "stderr");
  log("20", "web");
  log("30", "api");

  const all = queries.listLogRuns({});
  expect(all.map((r) => r.process_id)).toEqual(["30", "20", "10"]);

  const api = queries.listLogRuns({ commandId: "api" });
  expect(api.map((r) => r.process_id)).toEqual(["30", "10"]);
  expect(api[1]).toMatchObject({ lines: 2, stderr_lines: 1, profile: "dev" });

  expect(queries.listLogRuns({ profile: "other" })).toEqual([]);
  expect(queries.listLogRuns({ limit: 1 })).toHaveLength(1);
});
