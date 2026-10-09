import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface EndpointInfo {
  url: string;
  pid: number;
  startedAt: string;
}

/** Where a running core advertises its URL (the desktop sidecar binds a random port). */
export function endpointFilePath(): string {
  return process.env.CONDUCTOR_ENDPOINT_FILE || join(homedir(), ".conductor", "endpoint.json");
}

export function writeEndpointFile(url: string): void {
  const path = endpointFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const info: EndpointInfo = { url, pid: process.pid, startedAt: new Date().toISOString() };
  // Write-then-rename so a reader never sees a half-written file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info));
  renameSync(tmp, path);
}

function readRaw(): EndpointInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(endpointFilePath(), "utf8")) as Partial<EndpointInfo>;
    if (
      typeof parsed?.url !== "string" ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid)
    ) {
      return null;
    }
    return {
      url: parsed.url,
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The advertised endpoint, or null when missing, corrupt, or left behind by a dead process. */
export function readEndpointFile(): EndpointInfo | null {
  const info = readRaw();
  return info && isAlive(info.pid) ? info : null;
}

/** Removes the file only if this process wrote it; another instance's file is left alone. */
export function removeEndpointFile(): void {
  const info = readRaw();
  if (info?.pid !== process.pid) return;
  try {
    rmSync(endpointFilePath(), { force: true });
  } catch {
    // Best effort on shutdown.
  }
}
