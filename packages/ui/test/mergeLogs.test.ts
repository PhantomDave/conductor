import { expect, test } from "bun:test";
import { mergeLogs } from "../src/lib/mergeLogs";
import type { LogRow } from "../src/lib/api";

const row = (id: number) => ({ id, message: `line ${id}` }) as LogRow;
const ids = (rows: LogRow[]) => rows.map((r) => r.id);

test("SSE replay after the history fetch adds nothing", () => {
  let rows = mergeLogs([], [1, 2, 3].map(row));
  for (const id of [1, 2, 3, 4]) rows = mergeLogs(rows, [row(id)]);
  expect(ids(rows)).toEqual([1, 2, 3, 4]);
});

test("history fetch landing after SSE lines merges in id order", () => {
  let rows: LogRow[] = [];
  for (const id of [2, 4]) rows = mergeLogs(rows, [row(id)]);
  expect(ids(mergeLogs(rows, [1, 2, 3].map(row)))).toEqual([1, 2, 3, 4]);
});

test("returns the same array when nothing is new", () => {
  const rows = [row(1)];
  expect(mergeLogs(rows, [row(1)])).toBe(rows);
});
