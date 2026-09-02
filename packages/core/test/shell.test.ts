import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveShell, listAvailableShells } from "../src/executor/shell";

describe("resolveShell", () => {
  const originalPlatform = process.platform;
  const originalShell = process.env.SHELL;
  const originalComspec = process.env.COMSPEC;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    if (originalComspec === undefined) delete process.env.COMSPEC;
    else process.env.COMSPEC = originalComspec;
  });

  test("uses the explicitly configured shell over everything else", () => {
    const { bin, flag } = resolveShell("/usr/local/bin/fish");
    expect(bin).toBe("/usr/local/bin/fish");
    expect(flag).toBe("-c");
  });

  test("trims whitespace on the configured shell and ignores blank strings", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.SHELL = "/bin/bash";
    const { bin } = resolveShell("   ");
    expect(bin).toBe("/bin/bash");
  });

  test("maps well-known Windows shells to their own flag instead of -c", () => {
    // Bare filenames only: `basename` is backslash-aware only when actually
    // running on win32 (node:path picks its flavor from the real host OS,
    // not from a mocked process.platform), so a full "C:\..." path can't be
    // parsed correctly from a non-Windows CI runner.
    expect(resolveShell("cmd.exe")).toEqual({ bin: "cmd.exe", flag: "/c" });
    expect(resolveShell("powershell.exe")).toEqual({ bin: "powershell.exe", flag: "-Command" });
    expect(resolveShell("pwsh.exe")).toEqual({ bin: "pwsh.exe", flag: "-Command" });
  });

  test("falls back to $SHELL on POSIX when nothing is configured", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.SHELL = "/usr/bin/zsh";
    const { bin, flag } = resolveShell(undefined);
    expect(bin).toBe("/usr/bin/zsh");
    expect(flag).toBe("-c");
  });

  test("falls back to /bin/sh on POSIX when $SHELL is unset", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    delete process.env.SHELL;
    const { bin } = resolveShell(undefined);
    expect(bin).toBe("/bin/sh");
  });

  test("falls back to %COMSPEC% on Windows when nothing is configured", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.COMSPEC = "cmd.exe";
    const { bin, flag } = resolveShell(undefined);
    expect(bin).toBe("cmd.exe");
    expect(flag).toBe("/c");
  });

  test("falls back to cmd.exe on Windows when %COMSPEC% is unset", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    delete process.env.COMSPEC;
    const { bin } = resolveShell(undefined);
    expect(bin).toBe("cmd.exe");
  });
});

describe("listAvailableShells", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: process.platform });
  });

  test("never throws and returns a deduplicated, sorted list", () => {
    const shells = listAvailableShells();
    expect(Array.isArray(shells)).toBe(true);

    const keys = shells.map((s) => s.path);
    expect(new Set(keys).size).toBe(keys.length);

    const names = shells.map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  test("every returned entry has a non-empty path and display name", () => {
    for (const shell of listAvailableShells()) {
      expect(shell.path.length).toBeGreaterThan(0);
      expect(shell.name.length).toBeGreaterThan(0);
    }
  });
});
