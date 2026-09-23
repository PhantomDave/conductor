import { randomUUID } from "node:crypto";
import type { CommandConfig } from "../config/schema";
import { ProcessWrapper, type LogHandler, type HealthChangeHandler } from "./wrapper";
import { waitForHealthy, type ProbeResult } from "./healthcheck";
import { FileWatcher, HealthMonitor } from "../monitor";

/** Consecutive auto-restarts allowed before the queue stops respawning a command. */
const MAX_RESTART_ATTEMPTS = 5;
/** Ceiling for the exponential backoff between auto-restarts. */
const MAX_RESTART_DELAY_MS = 30_000;
/** Uptime after which a process counts as stable and its attempt budget resets. */
const STABLE_UPTIME_MS = 60_000;

/**
 * Represents a failure event in the queue: process start failure,
 * dependency block, healthcheck timeout, or service recovery.
 */
export interface Notification {
  id: string;
  timestamp: number;
  type:
    | "failed_start"
    | "dependency_failed"
    | "healthcheck_failed"
    | "recovered"
    | "crashed"
    | "unhealthy";
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
  // `watch` glob watchers per command. They outlive restarts (only stopOne/
  // stopAll close them) so changes landing mid-restart are coalesced, not lost.
  private watchers = new Map<string, FileWatcher>();
  /** Watch-triggered restarts in flight, and those that saw more changes meanwhile. */
  private watchRestarting = new Set<string>();
  // commandId -> latest path for a change that arrived while a restart for
  // that command was already in flight (see onWatchChange).
  private watchPendingPath = new Map<string, string>();
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
  /** Consecutive auto-restarts per command id, for the attempt cap and backoff. */
  private restartAttempts = new Map<string, number>();
  /** Last log handler a caller supplied, so auto-restarts keep streaming logs. */
  private lastLogHandler?: LogHandler;
  /**
   * Profile that last launched each command. The store's single queue is
   * shared by every profile, so the queue's own name can't say which one a
   * process belongs to; restarts (manual, auto, watch) keep the tag.
   */
  private launchProfile = new Map<string, string>();

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

  /**
   * Applies the command's `restart` policy when its process exits.
   *
   * Capped and backed off deliberately: an `always` policy on a service that
   * dies at startup is otherwise an unbounded spawn loop inside the queue.
   */
  private onProcessExit(
    cmd: CommandConfig,
    wrapper: ProcessWrapper,
    exitCode: number,
    spawnedAt: number,
  ): void {
    const policy = cmd.restart ?? "manual";
    if (policy === "manual") return;
    // stop()/stopAll()/restartOne() all route through wrapper.stop(), which
    // sets this flag — without it every deliberate teardown looks like a crash.
    if (wrapper.stoppedIntentionally) return;
    if (policy === "on_failure" && exitCode === 0) return;
    // A wrapper from a previous lifecycle has already been replaced.
    if (this.wrappers.get(cmd.id) !== wrapper) return;

    // A process that stayed up a while earns a fresh budget, so a service
    // crashing once a day doesn't silently exhaust its attempts over a week.
    const stable = Date.now() - spawnedAt > STABLE_UPTIME_MS;
    const attempt = (stable ? 0 : (this.restartAttempts.get(cmd.id) ?? 0)) + 1;
    if (attempt > MAX_RESTART_ATTEMPTS) {
      wrapper.log(
        `[restart] giving up after ${MAX_RESTART_ATTEMPTS} consecutive restarts`,
        "stdout",
      );
      return;
    }
    this.restartAttempts.set(cmd.id, attempt);

    const delayMs = Math.min(1000 * 2 ** (attempt - 1), MAX_RESTART_DELAY_MS);
    wrapper.log(
      `[restart] ${policy}: exited ${exitCode}, restarting in ${delayMs}ms ` +
        `(attempt ${attempt}/${MAX_RESTART_ATTEMPTS})`,
      "stdout",
    );
    // Deliberately *not* unref'd: on the foreground `conductor run` path the
    // crashed child's pipes are gone, and signal listeners alone don't hold
    // Bun's loop — an unref'd timer would let the supervisor exit instead of
    // performing the restart it just scheduled.
    setTimeout(() => {
      // Re-check: the command may have been stopped or restarted during the wait.
      if (this.wrappers.get(cmd.id) !== wrapper || wrapper.stoppedIntentionally) return;
      this.restartQueued(cmd.id, this.lastLogHandler).catch(() => {});
    }, delayMs);
  }

  /**
   * Starts a file watcher for a command with `watch` globs, once — later
   * spawns reuse it. Globs edited via setCommands apply after a stop + start.
   */
  private ensureWatcher(cmd: CommandConfig, wrapper: ProcessWrapper): void {
    if (cmd.watch.length === 0 || this.watchers.has(cmd.id)) return;
    const watcher = new FileWatcher(wrapper.resolvedCwd(), cmd.watch, (path) => {
      void this.onWatchChange(cmd.id, path);
    });
    const error = watcher.start();
    if (error) {
      wrapper.log(`[watch] cannot watch ${wrapper.resolvedCwd()}: ${error}`, "stderr");
      return;
    }
    this.watchers.set(cmd.id, watcher);
  }

  /**
   * Restarts a command after a watched file changed, plus every running
   * command that transitively depends on it. Changes arriving while that
   * restart is in flight collapse into a single follow-up restart.
   */
  private async onWatchChange(commandId: string, path: string): Promise<void> {
    if (this.watchRestarting.has(commandId)) {
      this.watchPendingPath.set(commandId, path);
      return;
    }
    this.watchRestarting.add(commandId);
    try {
      do {
        // A change that arrived while the previous iteration was mid-restart
        // wins over the path this call started with - it's the more recent one.
        path = this.watchPendingPath.get(commandId) ?? path;
        this.watchPendingPath.delete(commandId);
        const wrapper = this.wrappers.get(commandId);
        // Stopped on purpose (stop button, stopByPid) → leave it stopped.
        if (!wrapper || wrapper.stoppedIntentionally) return;
        wrapper.log(`[watch] ${path} changed — restarting`, "stdout");

        const dependents = this.transitiveDependents(commandId).filter(
          (id) => this.wrappers.get(id)?.status === "running",
        );
        // Take dependents down first so none of them talks to a half-restarted
        // dependency; startMany then brings them back up in dependency order.
        await Promise.all(dependents.map((id) => this.stopProcess(id)));
        await this.restartOne(commandId).catch(() => {}); // failure is already notified
        if (dependents.length > 0) await this.startMany(dependents);
      } while (this.watchPendingPath.has(commandId));
    } finally {
      this.watchRestarting.delete(commandId);
      this.watchPendingPath.delete(commandId);
    }
  }

  /** Internal: spawn one process and await its healthcheck. Returns whether it became healthy. */
  private async startSingleProcess(
    cmd: CommandConfig,
    env: Record<string, string>,
    onLog?: LogHandler,
  ): Promise<boolean> {
    const profile = this.profileOf(cmd.id);
    const wrapper = new ProcessWrapper(cmd, profile, env);
    if (onLog) this.lastLogHandler = onLog;
    const logHandler = onLog ?? this.lastLogHandler;
    if (logHandler) wrapper.onLog(logHandler);

    // Track health transitions for recovery detection during restart
    this.setupHealthObserver(wrapper, cmd);

    this.wrappers.set(cmd.id, wrapper);
    this.ensureWatcher(cmd, wrapper);

    // Attempt a start — if we throw here (e.g. spawn failure), record failed_start
    try {
      await wrapper.start();
      wrapper.log(`[startup] command started (pid ${wrapper.pid})`, "stdout");

      // Auto-restart keys on process exit, not on the health flip: a service
      // that crashes outright never flips (HealthMonitor only reports state
      // *changes*, and a crash with no healthcheck configured reports nothing).
      const spawnedAt = Date.now();
      wrapper.onExit((exitCode) => this.onProcessExit(cmd, wrapper, exitCode, spawnedAt));
      // A crash *after* startup has no other path to a notification — startup
      // crashes are reported by the catch below instead.
      let started = false;
      wrapper.onExit((exitCode) => {
        if (!started || exitCode === 0 || wrapper.stoppedIntentionally) return;
        if (this.wrappers.get(cmd.id) !== wrapper) return;
        this.pendingRecovery.add(cmd.id);
        this.recordNotification(
          "crashed",
          cmd.id,
          `${cmd.name} crashed (exit code ${exitCode})`,
          exitCode,
          this.transitiveDependents(cmd.id),
        );
      });

      // Await healthcheck with per-attempt logging
      await waitForHealthy(`${profile}/${cmd.id}`, cmd.healthcheck, env, {
        onAttempt: (attempt, result) =>
          this.recordHealthProbeAttempt(wrapper, cmd, attempt, result),
        logLineState: wrapper,
        // Stop probing a process that already died instead of burning every retry.
        isAlive: () => wrapper.status === "starting",
      });

      // A probe can pass against something else (e.g. an orphan still holding
      // the port) after this process already died — don't call that healthy.
      if (wrapper.status !== "starting") {
        throw new Error(`process exited before becoming healthy`);
      }

      // Mark wrapper running once the healthcheck (or its absence) has passed
      wrapper.markHealthy("healthy");
      started = true;

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
      const exitCode = wrapper.getSnapshot()?.exitCode;
      // Determine notification type based on where it failed
      if (exitCode != null && exitCode !== 0 && !wrapper.stoppedIntentionally) {
        this.recordNotification(
          "crashed",
          cmd.id,
          `${cmd.name} crashed during startup (exit code ${exitCode})`,
          exitCode,
          affectedDownstream,
        );
        wrapper.log(`[startup] process exited with code ${exitCode}`, "stdout");
      } else if (this.isSpawnError(reason)) {
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
    // `log_line` is a startup-only signal: a line either appeared in output
    // or it didn't, and it can't un-appear, so re-probing it on an interval
    // would just report "healthy" forever after the first match (or
    // "unhealthy" forever if the pattern never showed) — unlike port/http/
    // command probes, it has no way to detect the service going down later.
    if (!hc || hc.type === "none" || hc.type === "log_line") return;

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
        // The exit handler reports crashes; only notify for a live-but-unhealthy service.
        if (!isHealthy && wrapper.status === "running") {
          this.recordNotification(
            "unhealthy",
            cmd.id,
            `${cmd.name} unhealthy: ${detail}`,
            undefined,
            this.transitiveDependents(cmd.id),
          );
        }
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
  async startAll(onLog?: LogHandler, profile?: string): Promise<void> {
    await this.startMany(
      this.commands.map((cmd) => cmd.id),
      onLog,
      profile,
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
  async startMany(commandIds: string[], onLog?: LogHandler, profile?: string): Promise<void> {
    this.checkForCycles(commandIds); // fail fast on a real cycle instead of a 60s timeout per node
    await Promise.all(
      commandIds.map((id) => this.ensureStarted(id, onLog, profile).catch(() => {})),
    );
  }

  /**
   * Starts a single command standalone, starting (and waiting on) any deps
   * first — recursively, at every level, so a dependency-of-a-dependency
   * that fails still blocks this command instead of being silently ignored.
   * Rejects if a dependency never becomes ready; always (re)spawns the
   * target itself even if it's already running.
   *
   * `profile` tags the process (and any deps it starts) with the profile
   * that launched it; omitted, a command keeps its previous tag.
   */
  async startOne(commandId: string, onLog?: LogHandler, profile?: string): Promise<void> {
    this.checkForCycles([commandId]); // fail fast on a real cycle instead of a 60s timeout per node
    // Starting by hand is the same fresh intent as restarting by hand: don't
    // let attempts spent before an operator stopped the command count here.
    this.restartAttempts.delete(commandId);
    await this.ensureStarted(commandId, onLog, profile);
  }

  /** Alias for startOne. */
  async run(commandId: string, onLog?: LogHandler, profile?: string): Promise<void> {
    return this.startOne(commandId, onLog, profile);
  }

  /**
   * Starts `commandId` if it isn't already in flight, joining the existing
   * attempt instead of racing a second spawn if it is (single-flight per
   * command id — closes a real bug where two overlapping calls for the same
   * command used to create two competing ProcessWrapper instances).
   */
  private ensureStarted(commandId: string, onLog?: LogHandler, profile?: string): Promise<void> {
    const existing = this.startPromises.get(commandId);
    if (existing) return existing;

    const promise = this.ensureStartedInner(commandId, onLog, profile);
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

  private async ensureStartedInner(
    commandId: string,
    onLog?: LogHandler,
    profile?: string,
  ): Promise<void> {
    const cmd = this.commands.find((c) => c.id === commandId);
    if (!cmd) {
      throw new Error(`Unknown command "${commandId}" in profile "${profile ?? this.profile}"`);
    }
    // Set here, not in ensureStarted: a caller joining an in-flight start
    // must not re-tag the spawn it didn't own.
    if (profile) this.launchProfile.set(commandId, profile);

    const depIds = cmd.deps.filter((d): d is string => Boolean(d));
    if (depIds.length > 0) {
      try {
        // Kick off (or join) every dependency concurrently, then confirm each
        // one actually became ready — independent branches of the graph
        // never wait on each other here.
        await Promise.all(
          depIds.map(async (depId) => {
            if (!this.isDependencyReady(depId)) {
              await this.ensureStarted(depId, undefined, profile).catch(() => {}); // failure surfaces via waitForDependency below
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
    // A restart the operator asked for restores the auto-restart budget.
    this.restartAttempts.delete(commandId);
    return this.restartQueued(commandId, onLog);
  }

  /** `restartOne` without the budget reset — the path auto-restarts take. */
  private async restartQueued(commandId: string, onLog?: LogHandler): Promise<void> {
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

    await this.stopProcess(commandId);

    if (wasUnhealthy) {
      this.pendingRecovery.add(commandId);
    }

    await this.startSingleProcess(cmd, this.resolveEnv(cmd), onLog);
  }

  async stopAll(): Promise<void> {
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
    for (const monitor of this.monitors.values()) monitor.stop();
    this.monitors.clear();
    const stops = [...this.wrappers.values()].map((w) => w.stop());
    await Promise.all(stops);
  }

  /** Stops the given command's process (if any), its health monitor and its file watcher. */
  async stopOne(commandId: string): Promise<void> {
    this.watchers.get(commandId)?.stop();
    this.watchers.delete(commandId);
    await this.stopProcess(commandId);
  }

  /** Stops the process and health monitor but keeps the file watcher (restarts use this). */
  private async stopProcess(commandId: string): Promise<void> {
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
      id: randomUUID(),
      timestamp: Date.now(),
      type,
      profile: this.profileOf(commandId),
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

  private profileOf(commandId: string): string {
    return this.launchProfile.get(commandId) ?? this.profile;
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
