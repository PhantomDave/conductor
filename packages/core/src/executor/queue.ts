import type { CommandConfig } from "../config/schema";
import { ProcessWrapper, type LogHandler, type ProcessSnapshot } from "./wrapper";
import { waitForHealthy } from "./healthcheck";

/**
 * Orchestrates a set of commands within a profile: resolves `deps` order
 * and manages the lifecycle of each ProcessWrapper.
 */
export class SpawnQueue {
  private wrappers = new Map<string, ProcessWrapper>();

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
      for (const dep of cmd.deps) {
        visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
      ordered.push(cmd);
    };

    for (const cmd of this.commands) {
      visit(cmd.id);
    }

    return ordered;
  }

  /**
   * Starts all commands in dependency order. Commands with no shared
   * dependency chain still start sequentially in this simple MVP queue;
   * true parallelism across independent branches is a future enhancement.
   * Each command waits for its own healthcheck (if configured) to pass
   * before the loop moves on to commands that depend on it.
   */
  async startAll(onLog?: LogHandler): Promise<void> {
    const ordered = this.topologicalOrder();

    for (const cmd of ordered) {
      const env = this.resolveEnv(cmd);
      const wrapper = new ProcessWrapper(cmd, this.profile, env);
      if (onLog) wrapper.onLog(onLog);
      this.wrappers.set(cmd.id, wrapper);
      await wrapper.start();
      await waitForHealthy(`${this.profile}/${cmd.id}`, cmd.healthcheck, env);
    }
  }

  async startOne(commandId: string, onLog?: LogHandler): Promise<void> {
    const cmd = this.commands.find((c) => c.id === commandId);
    if (!cmd) {
      throw new Error(`Unknown command "${commandId}" in profile "${this.profile}"`);
    }

    // Dependencies are started (and awaited-healthy) first so a single
    // command can be launched without manually starting its whole chain.
    for (const depId of cmd.deps) {
      if (this.wrappers.get(depId)?.status === "running") continue;
      await this.startOne(depId, onLog);
    }

    const env = this.resolveEnv(cmd);
    const wrapper = new ProcessWrapper(cmd, this.profile, env);
    if (onLog) wrapper.onLog(onLog);
    this.wrappers.set(cmd.id, wrapper);
    await wrapper.start();
    await waitForHealthy(`${this.profile}/${cmd.id}`, cmd.healthcheck, env);
  }

  /**
   * Stops a command (if running) and starts it fresh with a new pid -
   * unlike `stopOne` alone, this leaves the command ready to serve
   * traffic/logs again immediately. Dependencies are left untouched
   * (assumed already healthy), matching `startOne`'s behavior of
   * skipping deps that are already running.
   */
  async restartOne(commandId: string, onLog?: LogHandler): Promise<void> {
    await this.stopOne(commandId);
    await this.startOne(commandId, onLog);
  }

  async stopAll(): Promise<void> {
    const stops = [...this.wrappers.values()].map((w) => w.stop());
    await Promise.all(stops);
  }

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
  listSnapshots(): ProcessSnapshot[] {
    return this.listWrappers()
      .map((w) => w.getSnapshot())
      .filter((s): s is ProcessSnapshot => s !== null);
  }

  /**
   * Finds the wrapper managing the given OS pid, if any command in this
   * queue currently owns it.
   */
  findByPid(pid: number): ProcessWrapper | undefined {
    return this.listWrappers().find((w) => w.pid === pid);
  }
}
