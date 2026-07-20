import { connect } from "node:net";
import { resolve as resolvePath, isAbsolute } from "node:path";
import type { HealthcheckConfig } from "../config/schema";
import { interpolateString } from "../env/masker";
import { resolveShell } from "./shell";

export class HealthcheckError extends Error {}

/**
 * Polls a TCP port until a connection succeeds or retries are exhausted.
 * Uses node:net (rather than Bun.connect) since we only need a plain
 * connect-then-close probe, no data exchange.
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
 * Requests a URL and considers anything below 500 "healthy" (the service
 * is at least responding, even if it 404s on the root path).
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
 * Runs a shell command and considers exit code 0 as healthy. Runs with
 * `cwd` set to BASE_PATH (if present in env) so a relative check command
 * behaves the same as a relative command `run`/`cwd`.
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

async function runProbe(
  healthcheck: HealthcheckConfig,
  env: Record<string, string>,
): Promise<boolean> {
  switch (healthcheck.type) {
    case "port":
      if (!healthcheck.port) throw new HealthcheckError("healthcheck.port is required");
      return checkPort(healthcheck.port);
    case "http":
      if (!healthcheck.url) throw new HealthcheckError("healthcheck.url is required");
      return checkHttp(interpolateString(healthcheck.url, env));
    case "command": {
      if (!healthcheck.command) throw new HealthcheckError("healthcheck.command is required");
      const cwd =
        env.BASE_PATH && isAbsolute(env.BASE_PATH) ? resolvePath(env.BASE_PATH) : undefined;
      return checkCommand(interpolateString(healthcheck.command, env), cwd, env.CONDUCTOR_SHELL);
    }
    case "none":
    default:
      return true;
  }
}

/**
 * Polls the configured healthcheck until it passes, or throws once
 * `retries` attempts (spaced `interval_ms` apart) have all failed.
 * `env` is used to resolve `${VAR}` references in `url`/`command` (e.g. a
 * shared `${APP_DIR}` base path) - pass the same resolved env used to
 * start the command so healthchecks stay in sync with it.
 */
export async function waitForHealthy(
  commandLabel: string,
  healthcheck: HealthcheckConfig | undefined,
  env: Record<string, string> = {},
): Promise<void> {
  if (!healthcheck || healthcheck.type === "none") return;

  const deadline = Date.now() + healthcheck.timeout_ms;

  for (let attempt = 0; attempt < healthcheck.retries; attempt++) {
    if (await runProbe(healthcheck, env)) return;

    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, healthcheck.interval_ms));
  }

  throw new HealthcheckError(
    `Healthcheck for "${commandLabel}" did not pass within ${healthcheck.timeout_ms}ms`,
  );
}
