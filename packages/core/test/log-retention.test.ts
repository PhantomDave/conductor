import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/init";
import { ConductorQueries, type LogRow } from "../src/db/queries";

let queries: ConductorQueries;

beforeEach(() => {
  queries = new ConductorQueries(openDatabase(":memory:"));
});

function log(overrides: Partial<Omit<LogRow, "id" | "session_id">> = {}) {
  return queries.insertLog({
    process_id: "1",
    command_id: "cmd",
    profile: "dev",
    timestamp: new Date().toISOString(),
    level: "info",
    stream: "stdout",
    message: "hello world",
    ...overrides,
  });
}

describe("deleteLogsBefore (time-window sweep)", () => {
  test("drops rows older than cutoff, keeps newer ones", () => {
    const old = log({ timestamp: "2020-01-01T00:00:00.000Z" });
    const recent = log({ timestamp: new Date().toISOString() });

    const deleted = queries.deleteLogsBefore("2024-01-01T00:00:00.000Z");

    expect(deleted).toBe(1);
    const remaining = queries.queryLogs({}).map((r) => r.id);
    expect(remaining).toContain(recent.id);
    expect(remaining).not.toContain(old.id);
  });
});

describe("pruneOldSessions (session-scoped sweep)", () => {
  test("keeps only the last N sessions' logs per profile, and prunes the sessions table too", () => {
    const keptSessionIds: number[] = [];
    for (let i = 0; i < 5; i++) {
      const sessionId = queries.insertSession("dev");
      keptSessionIds.push(sessionId);
      log();
    }

    const deleted = queries.pruneOldSessions("dev", 2);

    expect(deleted).toBe(3);
    const remainingLogs = queries.queryLogs({ profile: "dev" });
    expect(remainingLogs).toHaveLength(2);
    for (const row of remainingLogs) {
      expect(keptSessionIds.slice(-2)).toContain(row.session_id);
    }

    const sessionsLeft = queries.pruneOldSessions("dev", 2);
    expect(sessionsLeft).toBe(0); // already pruned, nothing left beyond the last 2
  });

  test("0 disables the axis (no-op)", () => {
    queries.insertSession("dev");
    log();
    expect(queries.pruneOldSessions("dev", 0)).toBe(0);
    expect(queries.queryLogs({ profile: "dev" })).toHaveLength(1);
  });
});

describe("queryLogs grep", () => {
  test("falls back to plain LIKE for terms under 3 chars", () => {
    log({ message: "ab error" });
    const results = queries.queryLogs({ grep: "ab" });
    expect(results).toHaveLength(1);
  });

  test("FTS candidate filter narrows results for terms >= 3 chars, including operator-like characters", () => {
    log({ message: "connection-refused: retrying" });
    log({ message: "totally unrelated line" });

    const results = queries.queryLogs({ grep: "connection-refused" });
    expect(results).toHaveLength(1);
    expect(results[0]?.message).toContain("connection-refused");
  });

  test("a row deleted by either sweep no longer matches a grep that previously found it", () => {
    const old = log({ timestamp: "2020-01-01T00:00:00.000Z", message: "unique-marker-text" });
    queries.deleteLogsBefore("2024-01-01T00:00:00.000Z");

    const results = queries.queryLogs({ grep: "unique-marker-text" });
    expect(results.map((r) => r.id)).not.toContain(old.id);
    expect(results).toHaveLength(0);
  });
});
