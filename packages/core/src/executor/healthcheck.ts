import { connect } from "node:net";
import { resolve as resolvePath, isAbsolute } from "node:path";
import type { HealthcheckConfig } from "../config/schema";
import { interpolateString } from "../env/masker";
import { resolveShell } from "./shell";

export class HealthcheckError extends Error {}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

/**
 * Polls a TCP port until a connection succeeds or retries are exhausted.
 */
async function checkPort(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "localhost", port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(2000, () => finish(false));
  });
}

/**
 * Requests a URL and considers anything below 500 "healthy".
 */
async function checkHttp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Runs a shell command and considers exit code 0 as healthy.
 */
async function checkCommand(
  command: string,
  cwd?: string,
  configuredShell?: string,
): Promise<boolean> {
  try {
    const { bin, flag } = resolveShell(configuredShell);
    const proc = Bun.spawn({
      cmd: [bin, flag, command],
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** Runs exactly one probe and returns structured results. */
export async function probeOnce(
  healthcheck: HealthcheckConfig,
  env: Record<string, string>,
): Promise<ProbeResult> {
  const start = Date.now();
  try {
    switch (healthcheck.type) {
      case "port": {
        if (!healthcheck.port)
          return {
            ok: false,
            latencyMs: start - start,
            detail: "healthcheck.port is required" as never,
          };
        const ok = await checkPort(healthcheck.port);
        return { ok, latencyMs: Date.now() - start, detail: `port ${healthcheck.port}` };
      }
      case "http": {
        if (!healthcheck.url) {
          console.error("probeOnce bug: url required");
          return { ok: false, latencyMs: start - start, detail: "url required" };
        }
        const url = interpolateString(healthcheck.url, env);
        const ok = await checkHttp(url);
        return { ok, latencyMs: Date.now() - start, detail: `HTTP ${url}` };
      }
      case "command": {
        if (!healthcheck.command)
          return {
            ok: false,
            latencyMs: start - start,
            detail: "healthcheck.command is required" as never,
          };
        const resolvedCmd = interpolateString(healthcheck.command, env);
        const cwd =
          env.BASE_PATH && isAbsolute(env.BASE_PATH) ? resolvePath(env.BASE_PATH) : undefined;
        const ok = await checkCommand(resolvedCmd, cwd, env.CONDUCTOR_SHELL);
        return { ok, latencyMs: Date.now() - start, detail: `command "${resolvedCmd}"` };
      }
      case "none":
      default:
        return { ok: true, latencyMs: Date.now() - start, detail: "none" };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs: Date.now() - start, detail };
  }
}

/**
 * Polls the configured healthcheck until it passes, or throws once
 * `retries` attempts (spaced `interval_ms` apart) have all failed.
 */
export async function waitForHealthy(
  commandLabel: string,
  healthcheck: HealthcheckConfig | undefined,
  env: Record<string, string> = {},
  opts?: { onAttempt?: (attempt: number, result: ProbeResult) => void },
): Promise<void> {
  if (!healthcheck || healthcheck.type === "none") return;

  const deadline = Date.now() + healthcheck.timeout_ms;
  let lastDetail = "";

  for (let attempt = 0; attempt < healthcheck.retries; attempt++) {
    const result = await probeOnce(healthcheck, env);

    if (opts?.onAttempt) opts.onAttempt(attempt, result);

    if (result.ok) return;
    lastDetail = result.detail;

    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, healthcheck.interval_ms));
  }

  throw new HealthcheckError(
    `Healthcheck for "${commandLabel}" did not pass within ${healthcheck.timeout_ms}ms (${lastDetail})`,
  );
}
