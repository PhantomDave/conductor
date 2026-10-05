import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecent, recordRecent, forgetRecent } from "../src/workspace/recent";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conductor-recent-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readRecent", () => {
  test("missing file returns []", () => {
    expect(readRecent(dir)).toEqual([]);
  });

  test("invalid JSON returns []", () => {
    writeFileSync(join(dir, "workspaces.json"), "{not json");
    expect(readRecent(dir)).toEqual([]);
  });

  test("valid JSON that isn't an array returns []", () => {
    writeFileSync(join(dir, "workspaces.json"), "{}");
    expect(readRecent(dir)).toEqual([]);
  });

  test("drops malformed entries, keeping only valid ones", () => {
    const valid = { path: "/proj/a", name: "Alpha", lastOpened: new Date().toISOString() };
    writeFileSync(
      join(dir, "workspaces.json"),
      JSON.stringify([null, { foo: 1 }, { path: "/a", name: "a", lastOpened: "nope" }, valid]),
    );
    expect(readRecent(dir)).toEqual([valid]);
  });
});

describe("recordRecent", () => {
  test("on a file with malformed entries, succeeds and keeps the new + valid entries", () => {
    const valid = { path: "/proj/a", name: "Alpha", lastOpened: new Date().toISOString() };
    writeFileSync(
      join(dir, "workspaces.json"),
      JSON.stringify([null, { foo: 1 }, { path: "/a", name: "a", lastOpened: "nope" }, valid]),
    );

    expect(() => recordRecent(dir, { path: "/proj/b", name: "Beta" })).not.toThrow();

    const entries = readRecent(dir);
    expect(entries.map((e) => e.path)).toEqual(["/proj/b", "/proj/a"]);
  });

  test("recording the same path twice keeps one entry with the newest name", () => {
    recordRecent(dir, { path: "/proj/a", name: "Alpha" });
    recordRecent(dir, { path: "/proj/a", name: "Alpha Renamed" });

    const entries = readRecent(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("Alpha Renamed");
  });

  test("orders entries newest first", () => {
    recordRecent(dir, { path: "/proj/a", name: "Alpha" });
    recordRecent(dir, { path: "/proj/b", name: "Beta" });
    recordRecent(dir, { path: "/proj/c", name: "Gamma" });

    expect(readRecent(dir).map((e) => e.path)).toEqual(["/proj/c", "/proj/b", "/proj/a"]);
  });

  test("21 records keeps only the newest 20, dropping the oldest", () => {
    for (let i = 0; i < 21; i++) {
      recordRecent(dir, { path: `/proj/${i}`, name: `Project ${i}` });
    }

    const entries = readRecent(dir);
    expect(entries).toHaveLength(20);
    expect(entries.map((e) => e.path)).not.toContain("/proj/0");
    expect(entries[0]?.path).toBe("/proj/20");
  });
});

describe("forgetRecent", () => {
  test("removes only the given path", () => {
    recordRecent(dir, { path: "/proj/a", name: "Alpha" });
    recordRecent(dir, { path: "/proj/b", name: "Beta" });

    forgetRecent(dir, "/proj/a");

    const entries = readRecent(dir);
    expect(entries.map((e) => e.path)).toEqual(["/proj/b"]);
  });
});
