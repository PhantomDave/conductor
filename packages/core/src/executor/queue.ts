import type { CommandConfig } from "../config/schema";
import { ProcessWrapper, type LogHandler, type HealthChangeHandler } from "./wrapper";
import { waitForHealthy, type ProbeResult } from "./healthcheck";

/**
 * Represents a failure event in the queue: process start failure,
 * dependency block, healthcheck timeout, or service recovery.
 */
export interface Notification {
  id: string;
  timestamp: number;
  type: "failed_start" | "dependency_failed" | "healthcheck_failed" | "recovered";
  profile: string;
  commandId: string;
  commandName?: string;
  reason: string;
  exitCode?: number;
  affectedDownstream: string[]; // Command IDs that were blocked by this failure
}

/**
 * Orchestrates a set of commands within a profile: resolves `deps` order
 * and manages the lifecycle of each ProcessWrapper.
 */
export class SpawnQueue {
  private wrappers = new Map<string, ProcessWrapper>();
  private notifications: Notification[] = [];
  private readonly MAX_NOTIFICATIONS = 1000;

  // Track per-command health for recovery detection during restarts
  private failedPids = new Set<number>();

  constructor(
    private readonly profile: string,
    private commands: CommandConfig[],
    private readonly resolveEnv: (cmd: CommandConfig) => Record<string, string>,
  ) {}

  /**
   * Replaces the command list this queue orchestrates (e.g. after the
   * config is edited from the UI). Already-running wrappers are
   * unaffected since they're keyed separately in `this.wrappers`.
   */
  setCommands(commands: CommandConfig[]): void {
    this.commands = commands;
  }

  listCommands(): CommandConfig[] {
    return this.commands;
  }

  /**
   * Checks if a dependency is ready: either currently running,
   * or already ran and completed correctly (stopped with exit code 0).
   */
  private isDependencyReady(depId: string): boolean {
    const wrapper = this.wrappers.get(depId);
    if (!wrapper) return false;
    const snapshot = wrapper.getSnapshot();
    if (!snapshot) return false;
    if (snapshot.status === "running") return true;
    if (snapshot.status === "stopped" && snapshot.exitCode === 0) return true;
    return false;
  }

  /**
   * Waits for a dependency to become ready. Throws on failure or timeout.
   */
  private async waitForDependency(depId: string): Promise<void> {
    const wrapper = this.wrappers.get(depId);
    if (!wrapper) return;

    const maxWaitMs = 60_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const status = wrapper.status;
      if (status === "running") return;

      const snapshot = wrapper.getSnapshot();

      if (snapshot?.exitCode === 0) return;

      if (["stopped", "failed"].includes(status)) {
        // Record any unrecorded failed_start for the dependency itself
        if (!this.failedPids.has(snapshot.pid)) {
          this.recordNotification(
            "failed_start",
            depId,
            `Dependency exited: code ${snapshot.exitCode ?? "?"}`,
            snapshot.exitCode,
          );
          this.failedPids.add(snapshot.pid);
        }

        const reason = `Dependency failed with exit code ${snapshot?.exitCode ?? "?"}`;
        this.recordNotification("dependency_failed", depId, reason, snapshot?.exitCode);
        throw new Error(reason);
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    const reason = `Dependency did not become ready within ${maxWaitMs}ms`;
    this.recordNotification("dependency_failed", depId, reason);
    throw new Error(reason);
  }

  /** Marks a wrapper as healthy after successful healthcheck. */
  private markHealthy(wrapper: ProcessWrapper): void {
    wrapper.markHealthy("healthy");
  }

  /** Records a probe attempt as a log line through the wrapper's pipeline. */
  private recordHealthProbeAttempt(
    wrapper: ProcessWrapper,
    cmd: CommandConfig,
    attempt: number,
    result: ProbeResult,
  ): void {
    const hc = cmd.healthcheck;
    if (!hc) return;
    const label = hc.type !== "none" ? `${hc.retries}` : "";
    if (result.ok) {
      wrapper.log(`[healthcheck] attempt ${attempt + 1}/${label} healthy (${result.latencyMs}ms)`, "stdout");
    } else {
      wrapper.log(
        `[healthcheck] attempt ${attempt + 1}/${label} failed: ${result.detail} (${result.latencyMs}ms)`,
        "stdout",
      );
    }
  }

  /** Sets up health-transition observer for recovery detection. Returns a cleanup function. */
  private setupHealthObserver(wrapper: ProcessWrapper, cmd: CommandConfig): () => void {
    let wentUnhealthy = false;

    const onHealthChange: HealthChangeHandler = (_oldHealth, newHealth) => {
      if (newHealth === "unhealthy") {
        wentUnhealthy = true;
      } else if (wentUnhealthy && newHealth === "healthy") {
        // Recovery detected
        wentUnhealthy = false;
        wrapper.log("[healthcheck] service recovered", "stdout");
        this.recordNotification("recovered", cmd.id, `${cmd.name} is back up`);
      }
    };

    wrapper.onHealthChange(onHealthChange);
    return () => {}; // cleanup for observer list — not critical for short-lived wrappers
  }

  /** Internal: spawn one process and await its healthcheck. */
  private async startSingleProcess(
    cmd: CommandConfig,
    env: Record<string, string>,
    onLog?: LogHandler,
  ): Promise<number | null> {
    const wrapper = new ProcessWrapper(cmd, this.profile, env);
    if (onLog) wrapper.onLog(onLog);

    // Track health transitions for recovery detection during restart
    this.setupHealthObserver(wrapper, cmd);

    this.wrappers.set(cmd.id, wrapper);

    let exitCode: number | null = null;

    // Attempt a start — if we throw here (e.g. spawn failure), record failed_start
    try {
      await wrapper.start();
      wrapper.log(`[startup] command started (pid ${wrapper.pid})`, "stdout");

      // Await healthcheck with per-attempt logging
      await waitForHealthy(
        `${this.profile}/${cmd.id}`,
        cmd.healthcheck,
        env,
        { onAttempt: (attempt, result) => this.recordHealthProbeAttempt(wrapper, cmd, attempt, result) },
      );

      // Successful start — if previous version failed → recovered notification
      if (this.failedPids.has(wrapper.pid)) {
        wrapper.log("[healthcheck] service recovered after restart", "stdout");
        this.recordNotification("recovered", cmd.id, `${cmd.name} is back up after restart`);
      }

      // Remove from failed set on successful start
      this.failedPids.delete(wrapper.pid);
    } catch (err) {
      wrapper.markFailed();
      const reason = err instanceof Error ? err.message : String(err);
      // Determine notification type based on where it failed
      if (this.isSpawnError(reason)) {
        // Spawn-level failure: process never started properly at all
        this.recordNotification("failed_start", cmd.id, `Failed to start: ${reason}`);
        wrapper.log(`[healthcheck] startup failed: ${reason}`, "stdout");
      } else {
        // Healthcheck timed out after retries
        const label = cmd.healthcheck ? `Healthcheck failed after ${cmd.healthcheck.retries} attempts` : "No healthcheck configured";
        this.recordNotification("healthcheck_failed", cmd.id, `${label}: ${reason}`);
        wrapper.log(`[healthcheck] failed after all ${cmd.healthcheck?.retries ?? 0} attempts`, "stdout");
      }
    }

    // Return exit code for use by callers
    return null;
  }

  /** Checks if an error is likely a spawn-level failure (process couldn't be created). */
  private isSpawnError(message: string): boolean {
    const lower = message.toLowerCase();
    // These patterns indicate the process couldn't even start (ENOENT, ENOEXEC, etc.)
    return (
      lower.includes("enoent") ||
      lower.includes("spawn") ||
      lower.includes("no such file") ||
      lower.includes("permission denied") ||
      lower.includes("(os error 2)")
    );
  }

  /**
   * Returns commands ordered so that dependencies always start before
   * the commands that depend on them. Throws on circular dependencies.
   */
  private topologicalOrder(): CommandConfig[] {
    const byId = new Map(this.commands.map((c) => [c.id, c]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const ordered: CommandConfig[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Circular dependency detected involving "${id}"`);
      }
      const cmd = byId.get(id);
      if (!cmd) return;

      visiting.add(id);
      for (const dep of cmd.deps) visit(dep);
      visiting.delete(id);
      visited.add(id);
      ordered.push(cmd);
    };

    for (const cmd of this.commands) {
      if (cmd.id) visit(cmd.id);
    }

    return ordered;
  }

  async startAll(onLog?: LogHandler): Promise<void> {
    const ordered = this.topologicalOrder();
    for (const cmd of ordered) {
      await this.startSingleProcess(cmd, this.resolveEnv(cmd), onLog);
    }
  }

  async startOne(commandId: string, onLog?: LogHandler): Promise<void> {
    const cmd = this.commands.find((c) => c.id === commandId);
    if (!cmd) {
      throw new Error(`Unknown command "${commandId}" in profile "${this.profile}"`);
    }

    // Start dependencies first (recursively). Note: this also awaits their healthchecks.
    for (const depId of cmd.deps) {
      if (!depId) continue;
      if (!this.isDependencyReady(depId)) {
        await this.startOneInternal_(depId);
      }
      // Wait for the dependency to reach a stable state
      await this.waitForDependency(depId);
    }

    // Before spawning, force-kill any existing orphan for this command
    const orphan = this.wrappers.get(commandId);
    if (orphan != null) {
      await orphan.forceKillAndWait();
      await new Promise<void>((r) => setTimeout(r, 50));
    }

    await this.startSingleProcess(cmd, this.resolveEnv(cmd), onLog);
  }

  /** Internal-only recursive startOne that handles deps without env/onLog noise. */
  private async startOneInternal_(commandId: string): Promise<void> {
    const cmd = this.commands.find((c) => c.id === commandId);
    if (!cmd) return;
    for (const depId of cmd.deps) {
      if (!depId) continue;
      if (!this.isDependencyReady(depId)) {
        await this.startOneInternal_(depId);
      }
      // We already handled the waitForDependency in startOne (caller owns that). Return here instead.
    }
  }

  /**
   * Stops a command (if running) and starts it fresh with a new pid.
   * Dependencies are left untouched, matching `startOne`'s behavior.
   */
  async restartOne(commandId: string, onLog?: LogHandler): Promise<void> {
    const cmd = this.commands.find((c) => c.id === commandId);
    if (!cmd) throw new Error(`Unknown command "${commandId}" in profile "${this.profile}"`);

    await this.stopOne(commandId);

    // Clean up the old wrapper — its process is dead now
    const oldWrapper = this.wrappers.get(commandId);
    this.failedPids.add(oldWrapper?.pid ?? 0); // track that previous pid failed (for recovery detection)

    await this.startSingleProcess(cmd, this.resolveEnv(cmd), onLog);
  }

  async run(commandId: string, onLog?: LogHandler): Promise<void> {
    return this.startOne(commandId, onLog);
  }

  async stopAll(): Promise<void> {
    const stops = [...this.wrappers.values()].map((w) => w.stop());
    await Promise.all(stops);
  }

  /** Alias of startOne: runs a single command standalone, starting (and waiting on) any deps first. */
  async stopOne(commandId: string): Promise<void> {
    const wrapper = this.wrappers.get(commandId);
    if (wrapper) await wrapper.stop();
  }

  /**
   * Stops whichever command owns the given pid. Returns false if no
   * command in this queue owns that pid.
   */
  async stopByPid(pid: number): Promise<boolean> {
    const wrapper = this.findByPid(pid);
    if (!wrapper) return false;
    await wrapper.stop();
    return true;
  }

  getWrapper(commandId: string): ProcessWrapper | undefined {
    return this.wrappers.get(commandId);
  }

  listWrappers(): ProcessWrapper[] {
    return [...this.wrappers.values()];
  }

  /**
   * Returns serializable snapshots for every command that has been
   * started at least once in this queue (running or finished).
   */
  listSnapshots(): import("./wrapper").ProcessSnapshot[] {
    return this.listWrappers()
      .map((w) => w.getSnapshot())
      .filter((s): s is import("./wrapper").ProcessSnapshot => s !== null);
  }

  /**
   * Finds the wrapper managing the given OS pid, if any command in this
   * queue currently owns it.
   */
  findByPid(pid: number): ProcessWrapper | undefined {
    return this.listWrappers().find((w) => w.pid === pid);
  }

  /**
   * Records a failure notification for a command. Maintains a bounded
   * history (max 1000 notifications).
   */
  private recordNotification(
    type: Notification["type"],
    commandId: string,
    reason: string,
    exitCode?: number,
    affectedDownstream: string[] = [],
  ): void {
    const cmd = this.commands.find((c) => c.id === commandId);
    const notification: Notification = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: Date.now(),
      type,
      profile: this.profile,
      commandId,
      commandName: cmd?.name,
      reason,
      exitCode,
      affectedDownstream,
    };

    if (this.notifications.length >= this.MAX_NOTIFICATIONS) {
      this.notifications.shift();
    }
    this.notifications.push(notification);
  }

  /**
   * Returns all recorded notifications, most recent first.
   */
  listNotifications(): Notification[] {
    return [...this.notifications].reverse();
  }

  /**
   * Returns paginated notifications with optional limit and offset.
   */
  getNotifications(limit = 100, offset = 0): Notification[] {
    const reversed = this.listNotifications();
    return reversed.slice(offset, offset + limit);
  }
}
