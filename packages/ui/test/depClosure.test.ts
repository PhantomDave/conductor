import { expect, test } from "bun:test";
import { depClosure } from "../src/lib/depClosure";
import type { CommandInfo } from "../src/lib/api";

const cmd = (id: string, deps: string[]) => ({ id, deps }) as CommandInfo;

test("selecting only the end command pulls in its whole dep chain", () => {
  const byId = new Map(
    [
      cmd("a", []),
      cmd("b", ["a"]),
      cmd("c", ["b", "missing"]),
      cmd("x", ["y"]),
      cmd("y", ["x"]),
    ].map((c) => [c.id, c]),
  );
  expect(
    depClosure(["c"], byId)
      .map((c) => c.id)
      .sort(),
  ).toEqual(["a", "b", "c"]);
  expect(
    depClosure(["x"], byId)
      .map((c) => c.id)
      .sort(),
  ).toEqual(["x", "y"]); // cycle terminates
});
