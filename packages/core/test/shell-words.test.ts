import { describe, test, expect } from "bun:test";
import { splitShellWords } from "../src/executor/shell-words";

describe("splitShellWords", () => {
  test("splits on plain whitespace, collapsing runs of it", () => {
    expect(splitShellWords("node  script.js   --flag")).toEqual(["node", "script.js", "--flag"]);
  });

  test("trims leading/trailing whitespace without producing empty tokens", () => {
    expect(splitShellWords("  node script.js  ")).toEqual(["node", "script.js"]);
  });

  test("keeps a double-quoted argument containing spaces as one word", () => {
    expect(splitShellWords('node "my script.js"')).toEqual(["node", "my script.js"]);
  });

  test("keeps a single-quoted argument containing spaces as one word", () => {
    expect(splitShellWords("node 'my script.js'")).toEqual(["node", "my script.js"]);
  });

  test('handles a quoted value glued to an unquoted prefix, e.g. --name="a b"', () => {
    expect(splitShellWords('node --name="a b" --other=c')).toEqual([
      "node",
      "--name=a b",
      "--other=c",
    ]);
  });

  test("does not treat single quotes as special when inside a double-quoted word", () => {
    expect(splitShellWords(`echo "it's fine"`)).toEqual(["echo", "it's fine"]);
  });

  test("resolves a backslash-escaped space outside quotes as a literal space in one word", () => {
    expect(splitShellWords("node my\\ script.js")).toEqual(["node", "my script.js"]);
  });

  test("resolves a backslash escape inside double quotes", () => {
    expect(splitShellWords('bash -c "echo \\"hi\\""')).toEqual(["bash", "-c", 'echo "hi"']);
  });

  test("keeps a backslash literal inside double quotes when not before an escapable character", () => {
    // POSIX only treats \ as an escape inside "..." before $ ` " \ <newline>;
    // before anything else (e.g. a Windows path separator) it's literal.
    expect(splitShellWords('node "C:\\Users\\name"')).toEqual(["node", "C:\\Users\\name"]);
  });

  test("throws on an unterminated double quote", () => {
    expect(() => splitShellWords('node "unterminated')).toThrow(/unterminated/i);
  });

  test("throws on an unterminated single quote", () => {
    expect(() => splitShellWords("node 'unterminated")).toThrow(/unterminated/i);
  });

  test("returns an empty array for an empty or whitespace-only string", () => {
    expect(splitShellWords("")).toEqual([]);
    expect(splitShellWords("   ")).toEqual([]);
  });

  test("a single word with no whitespace is returned as-is", () => {
    expect(splitShellWords("ls")).toEqual(["ls"]);
  });
});
