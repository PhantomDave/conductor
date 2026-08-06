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
  cpuPercent?: number;
  memoryBytes?: number;
  startedAt: Date;
  endedAt?: Date;
  exitCode?: number;
  subprocess: Subprocess<"ignore", "pipe", "pipe">;
}

/** Callback signature for health-state change notifications. */
export type HealthChangeHandler = (oldHealth: HealthStatus, newHealth: HealthStatus) => void;
/** Callback signature for status change notifications. */
export type StatusChangeHandler = (oldStatus: ProcessStatus, newStatus: ProcessStatus) => void;

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
  cpuPercent?: number;
  memoryBytes?: number;
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Sends a signal to the entire process group (POSIX) or terminates the
 * whole process tree (Windows). Commands often run through a shell
 * (`bash -c "dotnet watch ..."`), and killing only the shell leader would
 * orphan the real service — which keeps running and holds its port after
 * a restart. Because every managed process is spawned with
 * `detached: true` (setsid), the leader is its own process-group leader,
 * so a negative-pid kill reaches every member.
 */
function killTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    try {
      Bun.spawnSync(["taskkill", ...args], { stdout: "ignore", stderr: "ignore" });
    } catch {
      /* process tree already gone */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    /* ESRCH: process group already gone */
  }
}

/** True if any member of the process group led by `pid` is still alive (POSIX). */
function groupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits (up to `timeoutMs`) for every member of the process group led by
 * `pid` to exit. A shell leader can die while its children keep running,
 * so awaiting `subprocess.exited` alone is not enough to know the
 * process is really gone. On Windows the `taskkill /T` tree kill is
 * synchronous, so this resolves immediately.
 */
async function waitForGroupDeath(pid: number, timeoutMs: number): Promise<boolean> {
  if (process.platform === "win32") return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return true;
    await sleep(50);
  }
  return !groupAlive(pid);
}

/**
 * SIGKILLs the process group led by `subprocess` and blocks until every
 * member has exited: waits for the leader, then sweeps for stragglers
 * (members that ignored earlier graceful signals), re-killing once if
 * needed.
 */
async function killTreeAndWait(subprocess: Subprocess, sweepTimeoutMs = 3000): Promise<void> {
  const pid = subprocess.pid;
  killTree(pid, "SIGKILL");
  await subprocess.exited.catch(() => {});
  if (!(await waitForGroupDeath(pid, sweepTimeoutMs))) {
    killTree(pid, "SIGKILL"); // second pass for stubborn members
    await waitForGroupDeath(pid, 1000);
  }
}

/**
 * Wraps a single command's lifecycle: spawn, stream output, and
 * gracefully terminate on request.
 */
export class ProcessWrapper {
  private process: ManagedProcess | null = null;
  private logHandlers: LogHandler[] = [];
  private healthObservers: HealthChangeHandler[] = [];
  private statusObservers: StatusChangeHandler[] = [];
  private exitHandlers: Array<(exitCode: number) => void> = [];

  constructor(
    private readonly commandConfig: CommandConfig,
    private readonly profile: string,
    private readonly env: Record<string, string>,
  ) {}

  onLog(handler: LogHandler): void {
    this.logHandlers.push(handler);
  }

  /** Subscribe to health-state change notifications. */
  onHealthChange(cb: HealthChangeHandler): () => void {
    this.healthObservers.push(cb);
    return () => {
      const idx = this.healthObservers.indexOf(cb);
      if (idx !== -1) this.healthObservers.splice(idx, 1);
    };
  }

  /** Subscribe to status change notifications. */
  onStatusChange(cb: StatusChangeHandler): () => void {
    this.statusObservers.push(cb);
    return () => {
      const idx = this.statusObservers.indexOf(cb);
      if (idx !== -1) this.statusObservers.splice(idx, 1);
    };
  }

  /**
   * Subscribe to subprocess exit (fires once when the managed process
   * terminates for any reason: natural exit, stop, or kill).
   */
  onExit(cb: (exitCode: number) => void): void {
    this.exitHandlers.push(cb);
  }

  private notifyHealth(oldHealth: HealthStatus, newHealth: HealthStatus): void {
    for (const cb of this.healthObservers) cb(oldHealth, newHealth);
  }

  private notifyStatus(oldStatus: ProcessStatus, newStatus: ProcessStatus): void {
    for (const cb of this.statusObservers) cb(oldStatus, newStatus);
  }

  /** Emit a log entry directly through the wrapper's pipeline. */
  public log(message: string, stream: "stdout" | "stderr" = "stdout"): void {
    if (!this.process) return;
    this.emitLog(message, stream);
  }

  /** Called by the metrics collector to update CPU/memory for the running process. */
  updateMetrics(cpuPercent: number, memoryBytes: number): void {
    if (!this.process) return;
    this.process.cpuPercent = cpuPercent;
    this.process.memoryBytes = memoryBytes;
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
   * Transitions the process to "running" after its healthcheck passes.
   * No-op if called when status is not "starting".
   * Also sets `health` in-process — callers no longer need to mutate health separately.
   * Notifies observers on any health-state flip.
   */
  markHealthy(health: HealthStatus): void {
    if (this.process?.status !== "starting") return;
    this.process.status = "running";
    const oldHealth = this.process.health;
    this.process.health = health;
    if (oldHealth !== health) this.notifyHealth(oldHealth, health);
  }

  /**
   * Updates health for a process that is already running (e.g. from the
   * continuous health monitor). Notifies observers on any flip, including
   * healthy → unhealthy (went-unhealthy) and unhealthy → healthy (recovered).
   */
  updateHealth(newHealth: HealthStatus): void {
    if (!this.process || this.process.status !== "running") return;
    const oldHealth = this.process.health;
    if (oldHealth === newHealth) return;
    this.process.health = newHealth;
    this.notifyHealth(oldHealth, newHealth);
  }

  /**
   * Transitions the process to "failed" (e.g. when a healthcheck timed out
   * or a dependency failure blocked startup). Safe to call from any state.
   */
  markFailed(): void {
    if (!this.process) return;
    const oldHealth = this.process.health;
    // Allow starting → failed transition for healthcheck timeouts
    // Ignore redundant transitions from already terminal states
    if (this.process.status === "starting" || this.process.status === "running") {
      const oldStatus = this.process.status;
      this.process.status = "failed";
      this.process.health = "unhealthy";
      if (oldHealth !== "unhealthy") this.notifyHealth(oldHealth, "unhealthy");
      this.notifyStatus(oldStatus, "failed");
    }
  }

  /**
   * Marks the process as down: sets health to "unhealthy" so the UI and
   * health observers reflect that the service is no longer serving.
   * No-op when there is no process or it is already unhealthy.
   */
  private markUnhealthy(): void {
    if (!this.process) return;
    const oldHealth = this.process.health;
    if (oldHealth === "unhealthy") return;
    this.process.health = "unhealthy";
    this.notifyHealth(oldHealth, "unhealthy");
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
      cpuPercent: this.process.cpuPercent,
      memoryBytes: this.process.memoryBytes,
      startedAt: this.process.startedAt.toISOString(),
      endedAt: this.process.endedAt?.toISOString(),
      exitCode: this.process.exitCode,
    };
  }

  /**
   * Spawns the command via the shell and begins streaming stdout/stderr
   * line-by-line to registered log handlers.
   * Always kills any stale subprocess from a previous lifecycle before spawning
   * so there is never an overlap of two processes for one command.
   */
  async start(): Promise<void> {
    // CRITICAL: Kill any lingering subprocess (and its process group) before
    // spawning the new one. Even if stop() was called, a zombie process may
    // still be alive (SIGTERM/exit races, stop_command not working, etc.).
    // We always force-kill the whole group first.
    if (this.process?.subprocess) {
      await killTreeAndWait(this.process.subprocess);
    }

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
      // Run in its own process group/session (setsid on POSIX) so we can
      // later kill the whole tree — the shell leader alone is not the
      // real service and can exit while its children keep running.
      detached: true,
    });

    this.process = {
      commandId: this.commandConfig.id,
      profile: this.profile,
      pid: subprocess.pid,
      status: "starting",
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
        this.markUnhealthy();
      }
      for (const cb of this.exitHandlers) cb(exitCode);
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
   * Waits for the current subprocess to fully terminate (SIGTERM + SIGKILL),
   * updating wrapper state when it does. If no process is running, returns immediately.
   */
  /**
   * Force-kill the current subprocess's whole process group and wait until
   * everything has exited. This is used by the restart logic which owns
   * wrapper lifecycle across boundaries — it needs a plain "terminate now"
   * that doesn't inspect process state/flags.
   */
  async forceKillAndWait(): Promise<void> {
    if (!this.process || this.process.subprocess == null) return;
    await killTreeAndWait(this.process.subprocess);
  }

  async stop(): Promise<void> {
    if (!this.process || this.process.subprocess == null) return;

    // Always attempt to kill the subprocess regardless of current status.
    // During healthcheck the status may still be "starting"; during restart
    // it may be "stopping" mid-flight. We must always terminate the process,
    // not just record an intention to stop.
    this.process.status = "stopping";
    const { subprocess } = this.process;
    const pid = subprocess.pid;
    const timeoutMs = this.commandConfig.stop_timeout_ms;
    const startedAt = Date.now();

    if (this.commandConfig.stop_command) {
      try {
        const { bin, flag } = resolveShell(this.env.CONDUCTOR_SHELL);
        // Resolve cwd the same way the main process does so that relative
        // stop commands (e.g. `docker compose stop`) run from the correct dir.
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
          detached: true,
        });
        // Give the stop command the same deadline as the overall stop timeout.
        // If it hangs, kill it (and its group) and fall through to the
        // SIGKILL path for the main process.
        const stopResult = await Promise.race([
          stopProc.exited.then((code) => ({ timedOut: false as const, code })),
          new Promise<{ timedOut: true }>((resolve) =>
            setTimeout(() => resolve({ timedOut: true }), timeoutMs),
          ),
        ]);
        if (stopResult.timedOut) {
          this.emitLog(`stop_command timed out after ${timeoutMs}ms`, "stderr");
          killTree(stopProc.pid, "SIGKILL");
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
      killTree(pid, this.commandConfig.stop_signal as NodeJS.Signals);
    }

    // Use only the remaining time budget so total shutdown stays within stop_timeout_ms.
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));

    // If the budget is exhausted (e.g. stop_command consumed all of it), SIGKILL immediately.
    if (remainingMs === 0) {
      await killTreeAndWait(subprocess);
      this.process.status = "stopped";
      this.process.exitCode ??= -1;
      this.process.endedAt = new Date();
      this.markUnhealthy();
      return;
    }

    // Wait for the process to actually exit (or timeout), then update state immediately
    const exitedInTime = await Promise.race([
      new Promise<boolean>((resolve) => {
        subprocess.exited.then((code) => {
          if (this.process) {
            this.process.status = "stopped";
            this.process.exitCode ??= code;
            this.process.endedAt = new Date();
            this.markUnhealthy();
          }
          resolve(true);
        });
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remainingMs)),
    ]);

    if (!exitedInTime) {
      await killTreeAndWait(subprocess);
      this.process.status = "stopped";
      this.process.exitCode ??= -1;
      this.process.endedAt = new Date();
      this.markUnhealthy();
      return;
    }

    // The leader exited in time — but children that ignored the graceful
    // signal (e.g. services spawned by a shell) may still be alive and
    // holding ports. Sweep the group and hard-kill any stragglers.
    if (!(await waitForGroupDeath(pid, 2000))) {
      killTree(pid, "SIGKILL");
      await waitForGroupDeath(pid, 1000);
    }
  }
}
