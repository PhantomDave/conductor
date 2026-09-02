import type { CommandConfig } from "../config/schema";
import { ProcessWrapper, type LogHandler, type HealthChangeHandler } from "./wrapper";
import { waitForHealthy, type ProbeResult } from "./healthcheck";
import { HealthMonitor } from "../monitor";

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

  // Track command IDs that need recovery detection after restart
  private pendingRecovery = new Set<string>();
  // Continuous health monitors per command (running services probed on interval)
  private monitors = new Map<string, HealthMonitor>();
  // Single-flight in-progress starts, keyed by command id. Ensures a
  // dependency shared by multiple commands (or a command started twice in
  // quick succession) is only ever spawned once concurrently, instead of
  // racing two ProcessWrapper instances under the same id.
  private startPromises = new Map<string, Promise<void>>();
  // Commands that never got a wrapper at all because one of *their own*
  // deps failed first (so there's nothing in `wrappers` for
  // waitForDependency to poll). Without this, a dependent would poll for
  // the full 60s timeout instead of failing immediately on a transitive
  // failure two or more levels down.
  private blockedCommands = new Set<string>();

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
    return snapshot.status === "stopped" && snapshot.exitCode === 0;
  }

  /**
   * Waits for `depId` to become ready on behalf of `dependentId`. Throws
   * (and records a single "dependency_failed" notification attributed to
   * the *blocked* command, not the dependency) on failure or timeout.
   *
   * Polls `this.wrappers` directly rather than taking a wrapper reference
   * up front, so it also catches the case where `depId` never gets a
   * wrapper at all — a dangling dep reference to a command id that isn't
   * in this profile. That used to return immediately as if the dependency
   * were satisfied, silently masking a config error.
   */
  private async waitForDependency(dependentId: string, depId: string): Promise<void> {
    const maxWaitMs = 60_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const wrapper = this.wrappers.get(depId);

      if (wrapper) {
        const status = wrapper.status;
        if (status === "running") return;

        const snapshot = wrapper.getSnapshot();
        if (snapshot?.exitCode === 0) return;

        if (status === "stopped" || status === "failed") {
          const reason = `Blocked: dependency "${depId}" failed (exit code ${snapshot?.exitCode ?? "?"})`;
          this.recordNotification(
            "dependency_failed",
            dependentId,
            reason,
            snapshot?.exitCode,
            this.transitiveDependents(dependentId),
          );
          throw new Error(reason);
        }
      } else if (this.blockedCommands.has(depId)) {
        const reason = `Blocked: dependency "${depId}" could not start because one of its own dependencies failed`;
        this.recordNotification(
          "dependency_failed",
          dependentId,
          reason,
          undefined,
          this.transitiveDependents(dependentId),
        );
        throw new Error(reason);
      } else if (!this.commands.some((c) => c.id === depId)) {
        const reason = `Blocked: dependency "${depId}" is not a known command in this profile`;
        this.recordNotification(
          "dependency_failed",
          dependentId,
          reason,
          undefined,
          this.transitiveDependents(dependentId),
        );
        throw new Error(reason);
      }
      // Known command, just not spawned yet (another in-flight start will
      // create its wrapper shortly) — keep polling.

      await new Promise((r) => setTimeout(r, 100));
    }

    const reason = `Dependency "${depId}" did not become ready within ${maxWaitMs}ms`;
    this.recordNotification(
      "dependency_failed",
      dependentId,
      reason,
      undefined,
      this.transitiveDependents(dependentId),
    );
    throw new Error(reason);
  }

  /** Maps each command id to the ids of commands that directly declare it as a dep. */
  private reverseDeps(): Map<string, string[]> {
    const rev = new Map<string, string[]>();
    for (const cmd of this.commands) {
      for (const dep of cmd.deps) {
        if (!dep) continue;
        if (!rev.has(dep)) rev.set(dep, []);
        rev.get(dep)!.push(cmd.id);
      }
    }
    return rev;
  }

  /** Every command (direct or transitive) that depends on `commandId`, for Notification.affectedDownstream. */
  private transitiveDependents(commandId: string): string[] {
    const rev = this.reverseDeps();
    const seen = new Set<string>();
    const queue = [...(rev.get(commandId) ?? [])];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of rev.get(id) ?? []) queue.push(next);
    }

    return [...seen];
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
    const label = hc.type !== "none" ? `${hc.retries}` : "none";
    if (result.ok) {
      wrapper.log(
        `[healthcheck] attempt ${attempt + 1}/${label} healthy (${result.latencyMs}ms)`,
        "stdout",
      );
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

    return wrapper.onHealthChange(onHealthChange);
  }

  /** Internal: spawn one process and await its healthcheck. Returns whether it became healthy. */
  private async startSingleProcess(
    cmd: CommandConfig,
    env: Record<string, string>,
    onLog?: LogHandler,
  ): Promise<boolean> {
    const wrapper = new ProcessWrapper(cmd, this.profile, env);
    if (onLog) wrapper.onLog(onLog);

    // Track health transitions for recovery detection during restart
    this.setupHealthObserver(wrapper, cmd);

    this.wrappers.set(cmd.id, wrapper);

    // Attempt a start — if we throw here (e.g. spawn failure), record failed_start
    try {
      await wrapper.start();
      wrapper.log(`[startup] command started (pid ${wrapper.pid})`, "stdout");

      // Await healthcheck with per-attempt logging
      await waitForHealthy(`${this.profile}/${cmd.id}`, cmd.healthcheck, env, {
        onAttempt: (attempt, result) =>
          this.recordHealthProbeAttempt(wrapper, cmd, attempt, result),
      });

      // Mark wrapper running once the healthcheck (or its absence) has passed
      wrapper.markHealthy("healthy");

      // Start continuous monitoring so the service going unhealthy after
      // startup (crash, port loss, OOM) is detected and health flips.
      this.startHealthMonitor(cmd, wrapper, env);

      // Successful start — if previous version failed → recovered notification
      if (this.pendingRecovery.has(cmd.id)) {
        wrapper.log("[healthcheck] service recovered after restart", "stdout");
        this.recordNotification("recovered", cmd.id, `${cmd.name} is back up after restart`);
      }

      // Remove from recovery-pending set on successful start
      this.pendingRecovery.delete(cmd.id);
      return true;
    } catch (err) {
      wrapper.markFailed();
      const reason = err instanceof Error ? err.message : String(err);
      const affectedDownstream = this.transitiveDependents(cmd.id);
      // Determine notification type based on where it failed
      if (this.isSpawnError(reason)) {
        // Spawn-level failure: process never started properly at all
        this.recordNotification(
          "failed_start",
          cmd.id,
          `Failed to start: ${reason}`,
          undefined,
          affectedDownstream,
        );
        wrapper.log(`[healthcheck] startup failed: ${reason}`, "stdout");
      } else {
        // Healthcheck timed out after retries
        const label = cmd.healthcheck
          ? `Healthcheck failed after ${cmd.healthcheck.retries} attempts`
          : "No healthcheck configured";
        this.recordNotification(
          "healthcheck_failed",
          cmd.id,
          `${label}: ${reason}`,
          undefined,
          affectedDownstream,
        );
        wrapper.log(
          `[healthcheck] failed after all ${cmd.healthcheck?.retries ?? 0} attempts`,
          "stdout",
        );
      }
      return false;
    }
  }

  /**
   * Starts a continuous health monitor for a running command so that the
   * service going unhealthy after startup (crash, port loss, OOM killer)
   * flips the wrapper's health and emits logs. Probes stop when the
   * process terminates for any reason (stop, restart, natural exit).
   */
  private startHealthMonitor(
    cmd: CommandConfig,
    wrapper: ProcessWrapper,
    env: Record<string, string>,
  ): void {
    const hc = cmd.healthcheck;
    if (!hc || hc.type === "none") return;

    // Stop any monitor from a previous lifecycle of this command
    this.monitors.get(cmd.id)?.stop();

    const monitor = new HealthMonitor(
      hc,
      () => env,
      (isHealthy, detail) => {
        wrapper.updateHealth(isHealthy ? "healthy" : "unhealthy");
        wrapper.log(
          isHealthy
            ? "[healthcheck] service healthy"
            : `[healthcheck] service unhealthy: ${detail}`,
          "stdout",
        );
      },
      { intervalMs: hc.interval_ms },
    );
    monitor.start();
    this.monitors.set(cmd.id, monitor);

    // Stop probing once this process terminates for any reason
    wrapper.onExit(() => monitor.stop());
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
   * Fail-fast cycle check scoped to `commandIds` and their transitive
   * dependencies only. Every profile shares one global `SpawnQueue` (see
   * ConfigStore), so checking every command in the queue instead would
   * make a cycle accidentally introduced in one profile block starts for
   * every other, unrelated profile too.
   */
  private checkForCycles(commandIds: string[]): void {
    const byId = new Map(this.commands.map((c) => [c.id, c]));
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Circular dependency detected involving "${id}"`);
      }
      const cmd = byId.get(id);
      if (!cmd) return;

      visiting.add(id);
      for (const dep of cmd.deps) if (dep) visit(dep);
      visiting.delete(id);
      visited.add(id);
    };

    for (const id of commandIds) visit(id);
  }

  /**
   * Starts every command in this queue concurrently. See `startMany` for
   * the concurrency/failure-handling contract.
   */
  async startAll(onLog?: LogHandler): Promise<void> {
    await this.startMany(
      this.commands.map((cmd) => cmd.id),
      onLog,
    );
  }

  /**
   * Starts a specific set of commands concurrently, respecting the
   * dependency graph: each one starts as soon as its own deps are ready,
   * without waiting for unrelated branches. A command (or dependency) that
   * fails to become healthy records a notification and blocks only its own
   * dependents — sibling branches of the graph keep starting regardless, and
   * this never rejects for an individual command's failure (check
   * `listNotifications()`/`listSnapshots()` afterward for the outcome).
   *
   * This is what "run profile" actually needs: the queue holds every
   * command from every profile (see ConfigStore's single global queue), so
   * `startAll` would start far more than just this profile's commands —
   * `startMany` lets a caller scope the batch to `profile.command_ids`
   * while still getting the same concurrent, dependency-aware startup.
   */
  async startMany(commandIds: string[], onLog?: LogHandler): Promise<void> {
    this.checkForCycles(commandIds); // fail fast on a real cycle instead of a 60s timeout per node
    await Promise.all(commandIds.map((id) => this.ensureStarted(id, onLog).catch(() => {})));
  }

  /**
   * Starts a single command standalone, starting (and waiting on) any deps
   * first — recursively, at every level, so a dependency-of-a-dependency
   * that fails still blocks this command instead of being silently ignored.
   * Rejects if a dependency never becomes ready; always (re)spawns the
   * target itself even if it's already running.
   */
  async startOne(commandId: string, onLog?: LogHandler): Promise<void> {
    this.checkForCycles([commandId]); // fail fast on a real cycle instead of a 60s timeout per node
    await this.ensureStarted(commandId, onLog);
  }

  /** Alias for startOne. */
  async run(commandId: string, onLog?: LogHandler): Promise<void> {
    return this.startOne(commandId, onLog);
  }

  /**
   * Starts `commandId` if it isn't already in flight, joining the existing
   * attempt instead of racing a second spawn if it is (single-flight per
   * command id — closes a real bug where two overlapping calls for the same
   * command used to create two competing ProcessWrapper instances).
   */
  private ensureStarted(commandId: string, onLog?: LogHandler): Promise<void> {
    const existing = this.startPromises.get(commandId);
    if (existing) return existing;

    const promise = this.ensureStartedInner(commandId, onLog);
    this.startPromises.set(commandId, promise);
    // `.finally()` returns a *new* derived promise that rejects whenever
    // `promise` does; the real `promise` returned below is what callers
    // await/catch, so leaving this derived one unhandled would surface as
    // a spurious unhandled-rejection on every failed start.
    promise
      .finally(() => {
        if (this.startPromises.get(commandId) === promise) this.startPromises.delete(commandId);
      })
      .catch(() => {});
    return promise;
  }

  private async ensureStartedInner(commandId: string, onLog?: LogHandler): Promise<void> {
    const cmd = this.commands.find((c) => c.id === commandId);
    if (!cmd) {
      throw new Error(`Unknown command "${commandId}" in profile "${this.profile}"`);
    }

    const depIds = cmd.deps.filter((d): d is string => Boolean(d));
    if (depIds.length > 0) {
      try {
        // Kick off (or join) every dependency concurrently, then confirm each
        // one actually became ready — independent branches of the graph
        // never wait on each other here.
        await Promise.all(
          depIds.map(async (depId) => {
            if (!this.isDependencyReady(depId)) {
              await this.ensureStarted(depId).catch(() => {}); // failure surfaces via waitForDependency below
            }
            await this.waitForDependency(commandId, depId);
          }),
        );
      } catch (err) {
        // We never reached startSingleProcess, so no wrapper exists for
        // `commandId` — mark it explicitly so anything depending on *this*
        // command fails fast via waitForDependency instead of polling for
        // 60s waiting for a wrapper that will never appear.
        this.blockedCommands.add(commandId);
        throw err;
      }
    }
    this.blockedCommands.delete(commandId); // clear a stale mark from a previous failed attempt

    // Before spawning, force-kill any existing orphan for this command.
    const orphan = this.wrappers.get(commandId);
    if (orphan != null) {
      await orphan.forceKillAndWait();
      await new Promise<void>((r) => setTimeout(r, 50));
    }

    await this.startSingleProcess(cmd, this.resolveEnv(cmd), onLog);
  }

  /**
   * Stops a command (if running) and starts it fresh with a new pid.
   * Dependencies are left untouched, matching `startOne`'s behavior.
   *
   * Routed through the same `startPromises` single-flight map as
   * `ensureStarted` — otherwise a restart racing a concurrent
   * startOne/startMany for the same command id could each independently
   * call `startSingleProcess` and `this.wrappers.set(commandId, ...)`,
   * silently orphaning whichever wrapper's process loses the race (the
   * exact bug `startPromises` exists to close, just via a different entry
   * point).
   */
  async restartOne(commandId: string, onLog?: LogHandler): Promise<void> {
    const cmd = this.commands.find((c) => c.id === commandId);
    if (!cmd) throw new Error(`Unknown command "${commandId}" in profile "${this.profile}"`);

    // If a start is already in flight for this command, let it finish
    // first rather than racing it — our stop+restart runs after.
    const inFlight = this.startPromises.get(commandId);
    if (inFlight) await inFlight.catch(() => {});

    const promise = this.restartOneInner(commandId, cmd, onLog);
    this.startPromises.set(commandId, promise);
    promise
      .finally(() => {
        if (this.startPromises.get(commandId) === promise) this.startPromises.delete(commandId);
      })
      .catch(() => {});
    return promise;
  }

  private async restartOneInner(
    commandId: string,
    cmd: CommandConfig,
    onLog?: LogHandler,
  ): Promise<void> {
    // Snapshot health *before* stopping — stop() always leaves health
    // "unhealthy" (it's no longer serving), so checking after would make
    // every restart look like a recovery, even one triggered by hand on an
    // already-healthy service.
    const oldWrapper = this.wrappers.get(commandId);
    const wasUnhealthy =
      oldWrapper != null && (oldWrapper.status === "failed" || oldWrapper.health === "unhealthy");

    await this.stopOne(commandId);

    if (wasUnhealthy) {
      this.pendingRecovery.add(commandId);
    }

    await this.startSingleProcess(cmd, this.resolveEnv(cmd), onLog);
  }

  async stopAll(): Promise<void> {
    for (const monitor of this.monitors.values()) monitor.stop();
    this.monitors.clear();
    const stops = [...this.wrappers.values()].map((w) => w.stop());
    await Promise.all(stops);
  }

  /** Stops the given command's process (if any) and its continuous health monitor. */
  async stopOne(commandId: string): Promise<void> {
    this.monitors.get(commandId)?.stop();
    this.monitors.delete(commandId);
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
