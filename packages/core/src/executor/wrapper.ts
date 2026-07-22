import { spawn, type Subprocess } from "bun";
import { resolve as resolvePath, isAbsolute } from "node:path";
import type { CommandConfig } from "../config/schema";
import { interpolateString } from "../env/masker";
import { resolveShell } from "./shell";

export type ProcessStatus = "starting" | "running" | "stopping" | "stopped" | "failed";
export type HealthStatus = "unknown" | "healthy" | "unhealthy";

export interface ManagedProcess {
  commandId: string;
  profile: string;
  pid: number;
  status: ProcessStatus;
  health: HealthStatus;
  startedAt: Date;
  endedAt?: Date;
  exitCode?: number;
  subprocess: Subprocess<"ignore", "pipe", "pipe">;
}

/**
 * Plain-object snapshot of a process, safe to serialize over the HTTP API
 * (no subprocess handle, dates as ISO strings).
 */
export interface ProcessSnapshot {
  commandId: string;
  commandName: string;
  profile: string;
  pid: number;
  status: ProcessStatus;
  health: HealthStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
}

/**
 * A single emitted log line, carrying enough context (pid/commandId/
 * profile) for persistence and for the UI to filter per-process streams.
 */
export interface LogEntry {
  commandId: string;
  commandName: string;
  profile: string;
  pid: number;
  stream: "stdout" | "stderr";
  message: string;
  timestamp: string;
}

export type LogHandler = (entry: LogEntry) => void;

/**
 * Wraps a single command's lifecycle: spawn, stream output, and
 * gracefully terminate on request.
 */
export class ProcessWrapper {
  private process: ManagedProcess | null = null;
  private logHandlers: LogHandler[] = [];

  constructor(
    private readonly commandConfig: CommandConfig,
    private readonly profile: string,
    private readonly env: Record<string, string>,
  ) {}

  onLog(handler: LogHandler): void {
    this.logHandlers.push(handler);
  }

  private emitLog(message: string, stream: "stdout" | "stderr"): void {
    if (!this.process) return;

    const entry: LogEntry = {
      commandId: this.process.commandId,
      commandName: this.commandConfig.name,
      profile: this.process.profile,
      pid: this.process.pid,
      stream,
      message,
      timestamp: new Date().toISOString(),
    };

    for (const handler of this.logHandlers) {
      handler(entry);
    }
  }

  get status(): ProcessStatus {
    return this.process?.status ?? "stopped";
  }

  get health(): HealthStatus {
    return this.process?.health ?? "unknown";
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  /**
   * Returns a serializable snapshot of the current process state, or
   * null if the process has never been started.
   */
  getSnapshot(): ProcessSnapshot | null {
    if (!this.process) return null;

    return {
      commandId: this.process.commandId,
      commandName: this.commandConfig.name,
      profile: this.process.profile,
      pid: this.process.pid,
      status: this.process.status,
      health: this.process.health,
      startedAt: this.process.startedAt.toISOString(),
      endedAt: this.process.endedAt?.toISOString(),
      exitCode: this.process.exitCode,
    };
  }

  /**
   * Spawns the command via the shell and begins streaming stdout/stderr
   * line-by-line to registered log handlers.
   */
  async start(): Promise<void> {
    // Allow `cwd` to reference resolved env vars (e.g. "${BASE_PATH}/backend/Api")
    // so a single value can drive every command's working directory. If the
    // result is still relative (including the default "."), resolve it
    // against BASE_PATH rather than leaving it for the OS to interpret
    // relative to wherever the Conductor server process itself was
    // launched from - that's what caused relative `cwd`s to silently
    // resolve inside the Conductor repo instead of the target project.
    const interpolatedCwd = interpolateString(this.commandConfig.cwd, this.env);
    const cwd = isAbsolute(interpolatedCwd)
      ? interpolatedCwd
      : resolvePath(this.env.BASE_PATH ?? process.cwd(), interpolatedCwd);

    let cmd: string[];
    // A command containing newlines is always multi-statement and must run
    // through a shell regardless of the explicit `shell` setting, because
    // there is no way to exec multiple commands in a single process otherwise.
    const useShell = this.commandConfig.shell || this.commandConfig.run.includes("\n");
    if (useShell) {
      const { bin, flag } = resolveShell(this.env.CONDUCTOR_SHELL);
      cmd = [bin, flag, this.commandConfig.run];
    } else {
      // Split on any run of whitespace so leading/trailing spaces and tabs
      // don't produce empty tokens.
      cmd = this.commandConfig.run.trim().split(/\s+/);
    }

    const subprocess = spawn({
      cmd,
      cwd,
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    this.process = {
      commandId: this.commandConfig.id,
      profile: this.profile,
      pid: subprocess.pid,
      status: "running",
      health: "unknown",
      startedAt: new Date(),
      subprocess,
    };

    this.pumpStream(subprocess.stdout, "stdout");
    this.pumpStream(subprocess.stderr, "stderr");

    subprocess.exited.then((exitCode) => {
      if (this.process) {
        this.process.status = exitCode === 0 ? "stopped" : "failed";
        this.process.exitCode = exitCode;
        this.process.endedAt = new Date();
      }
    });
  }

  private async pumpStream(
    stream: ReadableStream<Uint8Array>,
    kind: "stdout" | "stderr",
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        this.emitLog(line, kind);
      }
    }

    if (buffer.length > 0) {
      this.emitLog(buffer, kind);
    }
  }

  /**
   * Gracefully stops the process: if `stop_command` is configured, runs
   * that command first (giving the process a chance to shut down cleanly).
   * Otherwise sends stop_signal directly. In both cases, if the process
   * has not exited within stop_timeout_ms, it is force-killed with SIGKILL.
   */
  async stop(): Promise<void> {
    if (!this.process || this.process.status !== "running") return;

    this.process.status = "stopping";
    const { subprocess } = this.process;
    const timeoutMs = this.commandConfig.stop_timeout_ms;
    const startedAt = Date.now();

    if (this.commandConfig.stop_command) {
      try {
        const { bin, flag } = resolveShell(this.env.CONDUCTOR_SHELL);
        // Resolve cwd the same way the main process does so that relative
        // stop commands (e.g. `docker-compose stop`) run from the correct dir.
        const interpolatedCwd = interpolateString(this.commandConfig.cwd, this.env);
        const cwd = isAbsolute(interpolatedCwd)
          ? interpolatedCwd
          : resolvePath(this.env.BASE_PATH ?? process.cwd(), interpolatedCwd);
        const stopProc = spawn({
          cmd: [bin, flag, this.commandConfig.stop_command],
          cwd,
          env: this.env,
          stdout: "inherit",
          stderr: "inherit",
        });
        // Give the stop command the same deadline as the overall stop timeout.
        // If it hangs, kill it and fall through to the SIGKILL path for the main process.
        const stopResult = await Promise.race([
          stopProc.exited.then((code) => ({ timedOut: false as const, code })),
          new Promise<{ timedOut: true }>((resolve) =>
            setTimeout(() => resolve({ timedOut: true }), timeoutMs),
          ),
        ]);
        if (stopResult.timedOut) {
          this.emitLog(`stop_command timed out after ${timeoutMs}ms`, "stderr");
          try {
            stopProc.kill("SIGKILL");
          } catch {
            // Best-effort: the stop process may have already exited.
          }
        } else if (stopResult.code !== 0) {
          this.emitLog(`stop_command exited with code ${stopResult.code}`, "stderr");
        }
      } catch (err) {
        // If the stop command itself fails, log and fall through to the SIGKILL path.
        this.emitLog(
          `stop_command failed: ${err instanceof Error ? err.message : String(err)}`,
          "stderr",
        );
      }
    } else {
      subprocess.kill(this.commandConfig.stop_signal as NodeJS.Signals);
    }

    // Use only the remaining time budget so total shutdown stays within stop_timeout_ms.
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));

    // If the budget is exhausted (e.g. stop_command consumed all of it), SIGKILL immediately.
    if (remainingMs === 0) {
      subprocess.kill("SIGKILL");
      await subprocess.exited;
      return;
    }

    const exitedInTime = await Promise.race([
      subprocess.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), remainingMs)),
    ]);

    if (!exitedInTime) {
      subprocess.kill("SIGKILL");
      await subprocess.exited;
    }
  }
}
