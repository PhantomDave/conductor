import { spawn, type Subprocess } from "bun";
import { resolve as resolvePath, isAbsolute } from "node:path";
import type { CommandConfig } from "../config/schema";
import { interpolateString } from "../env/masker";
import { resolveShell } from "./shell";

export type ProcessStatus = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface ManagedProcess {
  commandId: string;
  profile: string;
  pid: number;
  status: ProcessStatus;
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
    if (this.commandConfig.shell) {
      const { bin, flag } = resolveShell(this.env.CONDUCTOR_SHELL);
      cmd = [bin, flag, this.commandConfig.run];
    } else {
      cmd = this.commandConfig.run.split(" ");
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

    if (this.commandConfig.stop_command) {
      try {
        const { bin, flag } = resolveShell(this.env.CONDUCTOR_SHELL);
        const stopProc = spawn({
          cmd: [bin, flag, this.commandConfig.stop_command],
          env: this.env,
          stdout: "inherit",
          stderr: "inherit",
        });
        // Give the stop command the same deadline as the overall stop timeout.
        // If it hangs, we fall through and SIGKILL the main process anyway.
        let timerId: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          stopProc.exited.then(() => {
            clearTimeout(timerId);
          }),
          new Promise<void>((resolve) => {
            timerId = setTimeout(resolve, timeoutMs);
          }),
        ]);
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

    let exitTimerId: ReturnType<typeof setTimeout> | undefined;
    const exitedInTime = await Promise.race([
      subprocess.exited.then(() => {
        clearTimeout(exitTimerId);
        return true;
      }),
      new Promise<boolean>((resolve) => {
        exitTimerId = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);

    if (!exitedInTime) {
      subprocess.kill("SIGKILL");
      await subprocess.exited;
    }
  }
}
