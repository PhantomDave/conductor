import { randomUUID } from "node:crypto";
import { saveConfig } from "./writer";
import { validateConfig, ConfigError } from "./loader";
import type { ConductorConfig, CommandConfig, ProfileConfig } from "./schema";
import { SpawnQueue } from "../executor/queue";
import { buildCommandEnv, buildProfileEnv, resolveBasePath } from "./env-resolution";
import { compileConfigExamples, type CompileReport } from "./example-compiler";

export interface EnvVarLookup {
  (profile: string): Record<string, string>;
}

/**
 * Owns the live in-memory config, the on-disk `.conductor.yml`, and the
 * SpawnQueue for each profile. Every mutation persists immediately so
 * the UI, the CLI, and the file on disk never drift apart.
 */
export class ConfigStore {
  private config: ConductorConfig;
  private readonly queues = new Map<string, SpawnQueue>();

  constructor(
    private readonly filePath: string,
    initialConfig: ConductorConfig,
    /** Resolves extra env layers (e.g. from SQLite) for a given profile. */
    private readonly resolveDbEnv: EnvVarLookup = () => ({}),
  ) {
    this.config = initialConfig;
    this.rebuildQueues();
  }

  private rebuildQueues(): void {
    for (const [profileName, profile] of Object.entries(this.config.profiles)) {
      const existing = this.queues.get(profileName);
      if (existing) {
        existing.setCommands(profile.commands);
      } else {
        this.queues.set(
          profileName,
          new SpawnQueue(profileName, profile.commands, (cmd) => this.resolveEnv(profileName, cmd)),
        );
      }
    }

    // Drop queues for profiles that no longer exist.
    for (const profileName of [...this.queues.keys()]) {
      if (!this.config.profiles[profileName]) {
        this.queues.delete(profileName);
      }
    }
  }

  private resolveEnv(profileName: string, cmd: CommandConfig): Record<string, string> {
    const profile = this.config.profiles[profileName];
    return buildCommandEnv({
      configFilePath: this.filePath,
      config: this.config,
      profile,
      cmd,
      dbGlobalEnv: this.resolveDbEnv("__global__"),
      dbProfileEnv: this.resolveDbEnv(profileName),
    });
  }

  /** Absolute directory that relative `cwd`s resolve against (see `base_path`). */
  getResolvedBasePath(): string {
    return resolveBasePath(this.filePath, this.config.base_path);
  }

  /** Updates `base_path`, persisting it and re-resolving every command's env. */
  setBasePath(basePath: string): void {
    this.config = validateConfig({ ...this.config, base_path: basePath });
    this.rebuildQueues();
    this.persist();
  }

  getDefaultShell(): string | undefined {
    return this.config.default_shell;
  }

  /**
   * Updates `default_shell` (the binary used for `shell: true` commands
   * and command-type healthchecks), persisting it and re-resolving every
   * command's env so `${CONDUCTOR_SHELL}`/spawn calls pick it up
   * immediately. Pass `undefined` to fall back to the OS default again.
   */
  setDefaultShell(shell: string | undefined): void {
    this.config = validateConfig({ ...this.config, default_shell: shell });
    this.rebuildQueues();
    this.persist();
  }

  private persist(): void {
    saveConfig(this.filePath, this.config);
  }

  getConfig(): ConductorConfig {
    return this.config;
  }

  getQueues(): Map<string, SpawnQueue> {
    return this.queues;
  }

  getQueue(profile: string): SpawnQueue | undefined {
    return this.queues.get(profile);
  }

  /** Re-runs env resolution for every queue, e.g. after env vars change. */
  refreshEnv(): void {
    this.rebuildQueues();
  }

  /**
   * Scans `base_path` for `.env.example`/`appsettings.example.json`-style
   * files and copies each to its real counterpart (`.env`,
   * `appsettings.json`, ...) with `${VAR}` tokens filled in from this
   * profile's resolved env - so there's no per-service "configurations"
   * command to author or maintain in `.conductor.yml`; any new service
   * that follows the example-file convention picks this up automatically.
   * Existing target files are left untouched unless `opts.force` is set.
   */
  compileConfigExamples(profileName?: string, opts: { force?: boolean } = {}): CompileReport {
    const profile = profileName ? this.config.profiles[profileName] : undefined;
    const env = buildProfileEnv({
      configFilePath: this.filePath,
      config: this.config,
      profile,
      dbGlobalEnv: this.resolveDbEnv("__global__"),
      dbProfileEnv: profileName ? this.resolveDbEnv(profileName) : undefined,
    });
    return compileConfigExamples(this.getResolvedBasePath(), env, opts);
  }

  /**
   * Replaces the entire live config from an imported `.conductor.yml`
   * (or any object matching the schema) - e.g. a teammate's file, or one
   * downloaded from a shared template - instead of manually recreating
   * every profile/command through the UI. Validates before touching
   * anything on disk, so a malformed import leaves the current config
   * untouched and surfaces a readable error instead of silently
   * corrupting the file.
   */
  importConfig(raw: unknown): ConductorConfig {
    this.config = validateConfig(raw);
    this.rebuildQueues();
    this.persist();
    return this.config;
  }

  addProfile(name: string, input: { description?: string }): ProfileConfig {
    if (this.config.profiles[name]) {
      throw new ConfigError(`Profile "${name}" already exists`);
    }

    const nextConfig: ConductorConfig = {
      ...this.config,
      profiles: {
        ...this.config.profiles,
        [name]: { description: input.description, env: {}, commands: [] },
      },
    };
    this.config = validateConfig(nextConfig);
    this.rebuildQueues();
    this.persist();
    return this.config.profiles[name];
  }

  removeProfile(name: string): void {
    if (!this.config.profiles[name]) {
      throw new ConfigError(`Unknown profile "${name}"`);
    }
    const { [name]: _removed, ...rest } = this.config.profiles;
    this.config = validateConfig({ ...this.config, profiles: rest });
    this.rebuildQueues();
    this.persist();
  }

  addCommand(
    profileName: string,
    input: Partial<Omit<CommandConfig, "id">> & { name: string; run: string; id?: string },
  ): CommandConfig {
    const profile = this.config.profiles[profileName];
    if (!profile) {
      throw new ConfigError(`Unknown profile "${profileName}"`);
    }

    const id = input.id?.trim() || slugify(input.name) || randomUUID().slice(0, 8);
    if (profile.commands.some((c) => c.id === id)) {
      throw new ConfigError(`Command "${id}" already exists in profile "${profileName}"`);
    }

    const command = { ...input, id } as CommandConfig;
    const nextProfile: ProfileConfig = {
      ...profile,
      commands: [...profile.commands, command],
    };
    this.config = validateConfig({
      ...this.config,
      profiles: { ...this.config.profiles, [profileName]: nextProfile },
    });
    this.rebuildQueues();
    this.persist();
    return this.config.profiles[profileName].commands.find((c) => c.id === id)!;
  }

  updateCommand(
    profileName: string,
    commandId: string,
    patch: Partial<Omit<CommandConfig, "id">>,
  ): CommandConfig {
    const profile = this.config.profiles[profileName];
    if (!profile) {
      throw new ConfigError(`Unknown profile "${profileName}"`);
    }
    const existing = profile.commands.find((c) => c.id === commandId);
    if (!existing) {
      throw new ConfigError(`Unknown command "${commandId}" in profile "${profileName}"`);
    }

    const updated = { ...existing, ...patch, id: commandId };
    const nextProfile: ProfileConfig = {
      ...profile,
      commands: profile.commands.map((c) => (c.id === commandId ? updated : c)),
    };
    this.config = validateConfig({
      ...this.config,
      profiles: { ...this.config.profiles, [profileName]: nextProfile },
    });
    this.rebuildQueues();
    this.persist();
    return this.config.profiles[profileName].commands.find((c) => c.id === commandId)!;
  }

  removeCommand(profileName: string, commandId: string): void {
    const profile = this.config.profiles[profileName];
    if (!profile) {
      throw new ConfigError(`Unknown profile "${profileName}"`);
    }

    const nextProfile: ProfileConfig = {
      ...profile,
      commands: profile.commands.filter((c) => c.id !== commandId),
    };
    this.config = validateConfig({
      ...this.config,
      profiles: { ...this.config.profiles, [profileName]: nextProfile },
    });
    this.rebuildQueues();
    this.persist();
  }

  duplicateCommand(
    sourceProfile: string,
    commandId: string,
    targetProfile: string,
  ): CommandConfig {
    const source = this.config.profiles[sourceProfile];
    if (!source) {
      throw new ConfigError(`Unknown profile "${sourceProfile}"`);
    }

    const target = this.config.profiles[targetProfile];
    if (!target) {
      throw new ConfigError(`Unknown profile "${targetProfile}"`);
    }

    const existing = source.commands.find((c) => c.id === commandId);
    if (!existing) {
      throw new ConfigError(`Unknown command "${commandId}" in profile "${sourceProfile}"`);
    }

    // Generate a new ID for the duplicate, avoiding collisions
    let newId = `${existing.id}-copy`;
    let suffix = 2;
    while (
      target.commands.some((c) => c.id === newId) ||
      source.commands.some((c) => c.id === newId)
    ) {
      newId = `${existing.id}-copy-${suffix}`;
      suffix++;
    }

    const duplicated = { ...existing, id: newId };
    const nextTarget: ProfileConfig = {
      ...target,
      commands: [...target.commands, duplicated],
    };

    this.config = validateConfig({
      ...this.config,
      profiles: { ...this.config.profiles, [targetProfile]: nextTarget },
    });
    this.rebuildQueues();
    this.persist();
    return this.config.profiles[targetProfile].commands.find((c) => c.id === newId)!;
  }

  moveCommand(
    sourceProfile: string,
    commandId: string,
    targetProfile: string,
  ): CommandConfig {
    const source = this.config.profiles[sourceProfile];
    if (!source) {
      throw new ConfigError(`Unknown profile "${sourceProfile}"`);
    }

    const target = this.config.profiles[targetProfile];
    if (!target) {
      throw new ConfigError(`Unknown profile "${targetProfile}"`);
    }

    const existing = source.commands.find((c) => c.id === commandId);
    if (!existing) {
      throw new ConfigError(`Unknown command "${commandId}" in profile "${sourceProfile}"`);
    }

    // Check if other commands in source depend on this command
    const dependents = source.commands.filter(
      (c) => c.deps && c.deps.includes(commandId) && c.id !== commandId,
    );
    if (dependents.length > 0) {
      throw new ConfigError(
        `Cannot move command "${commandId}": other commands depend on it (${dependents.map((c) => c.id).join(", ")})`,
      );
    }

    // Remove from source
    const nextSource: ProfileConfig = {
      ...source,
      commands: source.commands.filter((c) => c.id !== commandId),
    };

    // Add to target
    const nextTarget: ProfileConfig = {
      ...target,
      commands: [...target.commands, existing],
    };

    this.config = validateConfig({
      ...this.config,
      profiles: {
        ...this.config.profiles,
        [sourceProfile]: nextSource,
        [targetProfile]: nextTarget,
      },
    });
    this.rebuildQueues();
    this.persist();
    return this.config.profiles[targetProfile].commands.find((c) => c.id === commandId)!;
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
