import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endpointFilePath, readEndpointFile, removeEndpointFile, writeEndpointFile } from "../src";

let dir: string;
let file: string;
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conductor-endpoint-"));
  file = join(dir, "nested", "endpoint.json");
  saved = process.env.CONDUCTOR_ENDPOINT_FILE;
  process.env.CONDUCTOR_ENDPOINT_FILE = file;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CONDUCTOR_ENDPOINT_FILE;
  else process.env.CONDUCTOR_ENDPOINT_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("endpoint file", () => {
  test("honours CONDUCTOR_ENDPOINT_FILE and defaults to ~/.conductor/endpoint.json", () => {
    expect(endpointFilePath()).toBe(file);
    delete process.env.CONDUCTOR_ENDPOINT_FILE;
    expect(endpointFilePath().endsWith(join(".conductor", "endpoint.json"))).toBe(true);
  });

  test("write then read round-trips url and own pid, creating the directory", () => {
    writeEndpointFile("http://127.0.0.1:5123");
    const info = readEndpointFile();
    expect(info?.url).toBe("http://127.0.0.1:5123");
    expect(info?.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(info?.startedAt ?? ""))).toBe(false);
  });

  test("returns null when the file is missing", () => {
    expect(readEndpointFile()).toBeNull();
  });

  test("returns null for corrupt or mis-shaped content", () => {
    writeEndpointFile("http://127.0.0.1:1");
    writeFileSync(file, "{not json");
    expect(readEndpointFile()).toBeNull();
    writeFileSync(file, JSON.stringify({ url: 42, pid: process.pid }));
    expect(readEndpointFile()).toBeNull();
    writeFileSync(file, JSON.stringify({ url: "http://x", pid: "123" }));
    expect(readEndpointFile()).toBeNull();
  });

  test.skipIf(process.platform === "win32")("returns null when the pid is dead", async () => {
    const proc = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    writeEndpointFile("http://127.0.0.1:1");
    writeFileSync(
      file,
      JSON.stringify({ url: "http://127.0.0.1:1", pid: proc.pid, startedAt: "2026-01-01" }),
    );
    expect(readEndpointFile()).toBeNull();
  });

  test("removeEndpointFile removes its own file", () => {
    writeEndpointFile("http://127.0.0.1:1");
    removeEndpointFile();
    expect(existsSync(file)).toBe(false);
  });

  test("removeEndpointFile leaves a file that holds a different pid", () => {
    writeEndpointFile("http://127.0.0.1:1");
    const other = JSON.stringify({
      url: "http://127.0.0.1:2",
      pid: process.pid + 1,
      startedAt: "x",
    });
    writeFileSync(file, other);
    removeEndpointFile();
    expect(readFileSync(file, "utf8")).toBe(other);
  });

  test("removeEndpointFile is a no-op when nothing exists", () => {
    expect(() => removeEndpointFile()).not.toThrow();
  });
});
