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
 * Owns the live in-memory config, the on-disk `.conductor.yml`, and a
 * single global SpawnQueue for all processes (shared across profiles).
 * Every mutation persists immediately so the UI, the CLI, and the file
 * on disk never drift apart.
 */
export class ConfigStore {
  private config: ConductorConfig;
  private mutableQueue: SpawnQueue;

  constructor(
    private readonly filePath: string,
    initialConfig: ConductorConfig,
    /** Resolves extra env layers (e.g. from SQLite) for a given profile. */
    private readonly resolveDbEnv: EnvVarLookup = () => ({}),
  ) {
    this.config = initialConfig;
    // Create a single global queue with all commands from all profiles
    this.mutableQueue = this.buildGlobalQueue();
  }

  private buildGlobalQueue(): SpawnQueue {
    // Use root-level commands directly
    return new SpawnQueue("__global__", this.config.commands, (cmd) =>
      this.resolveEnvForCommand(cmd),
    );
  }

  /**
   * Resolves environment for a command.
   * Finds which profiles reference this command to build correct env context.
   */
  private findProfilesForCommand(commandId: string): string[] {
    const profiles: string[] = [];
    for (const [profileName, profile] of Object.entries(this.config.profiles)) {
      if (profile.command_ids.includes(commandId)) {
        profiles.push(profileName);
      }
    }
    return profiles;
  }

  /**
   * Resolves environment for a command.
   * Uses the first profile that references this command for context.
   */
  private resolveEnvForCommand(cmd: CommandConfig): Record<string, string> {
    const profileNames = this.findProfilesForCommand(cmd.id);
    const profileName = profileNames[0]; // Use first matching profile

    if (!profileName) {
      // Fallback: use global env only
      return buildCommandEnv({
        configFilePath: this.filePath,
        config: this.config,
        profile: undefined,
        cmd,
        dbGlobalEnv: this.resolveDbEnv("__global__"),
        dbProfileEnv: {},
      });
    }
    return this.resolveEnv(profileName, cmd);
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
    this.mutableQueue = this.buildGlobalQueue();
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
    this.mutableQueue = this.buildGlobalQueue();
    this.persist();
  }

  private persist(): void {
    saveConfig(this.filePath, this.config);
  }

  getConfig(): ConductorConfig {
    return this.config;
  }

  /**
   * Returns all root-level command definitions.
   */
  getCommands(): CommandConfig[] {
    return this.config.commands;
  }

  /**
   * Returns a specific command by ID.
   */
  getCommand(commandId: string): CommandConfig | undefined {
    return this.config.commands.find((c) => c.id === commandId);
  }

  /**
   * Returns commands for a specific profile (resolved from command_ids).
   */
  getProfileCommands(profileName: string): CommandConfig[] {
    const profile = this.config.profiles[profileName];
    if (!profile) return [];
    return profile.command_ids
      .map((id) => this.config.commands.find((c) => c.id === id))
      .filter((c): c is CommandConfig => c !== undefined);
  }

  getQueues(): Map<string, SpawnQueue> {
    // For compatibility: return a map with a single entry for the global queue
    const map = new Map<string, SpawnQueue>();
    map.set("__global__", this.mutableQueue);
    return map;
  }

  getQueue(_profile?: string): SpawnQueue {
    // Returns the global queue (profile parameter ignored for compatibility)
    return this.mutableQueue;
  }

  /** Re-runs env resolution for every command, e.g. after env vars change. */
  refreshEnv(): void {
    this.mutableQueue = this.buildGlobalQueue();
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
    this.mutableQueue = this.buildGlobalQueue();
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
        [name]: { description: input.description, env: {}, command_ids: [] },
      },
    };
    this.config = validateConfig(nextConfig);
    this.mutableQueue = this.buildGlobalQueue();
    this.persist();
    return this.config.profiles[name];
  }

  removeProfile(name: string): void {
    if (!this.config.profiles[name]) {
      throw new ConfigError(`Unknown profile "${name}"`);
    }
    const { [name]: _removed, ...rest } = this.config.profiles;
    this.config = validateConfig({ ...this.config, profiles: rest });
    this.mutableQueue = this.buildGlobalQueue();
    this.persist();
  }

  renameProfile(oldName: string, newName: string): ProfileConfig {
    const oldProfile = this.config.profiles[oldName];
    if (!oldProfile) {
      throw new ConfigError(`Unknown profile "${oldName}"`);
    }
    if (this.config.profiles[newName]) {
      throw new ConfigError(`Profile "${newName}" already exists`);
    }

    // Simply move the profile entry (no command updates needed since commands are at root)
    const { [oldName]: profile, ...rest } = this.config.profiles;
    this.config = validateConfig({
      ...this.config,
      profiles: {
        ...rest,
        [newName]: profile!,
      },
    });
    this.mutableQueue = this.buildGlobalQueue();
    this.persist();
    return this.config.profiles[newName];
  }

  duplicateProfile(sourceName: string, targetName: string): ProfileConfig {
    const source = this.config.profiles[sourceName];
    if (!source) {
      throw new ConfigError(`Unknown profile "${sourceName}"`);
    }
    if (this.config.profiles[targetName]) {
      throw new ConfigError(`Profile "${targetName}" already exists`);
    }

    // Get commands for this profile
    const sourceCommands = source.command_ids
      .map((id) => this.config.commands.find((c) => c.id === id))
      .filter((c): c is CommandConfig => c !== undefined);

    // Create new commands at root level with new IDs
    const newCommands = sourceCommands.map((cmd) => ({
      ...cmd,
      id: randomUUID().slice(0, 8), // New IDs for cloned commands
    }));

    const newCommandIds = newCommands.map((c) => c.id);

    const nextConfig: ConductorConfig = {
      ...this.config,
      commands: [...this.config.commands, ...newCommands],
      profiles: {
        ...this.config.profiles,
        [targetName]: {
          description: source.description ? `${source.description} (copy)` : undefined,
          env: { ...source.env }, // Shallow copy of env vars
          command_ids: newCommandIds,
        },
      },
    };
    this.config = validateConfig(nextConfig);
    this.mutableQueue = this.buildGlobalQueue();
    this.persist();
    return this.config.profiles[targetName];
  }

  /**
   * Adds a new command at the root level.
   */
  addCommand(
    input: Partial<Omit<CommandConfig, "id">> & { name: string; run: string; id?: string },
  ): CommandConfig {
    const id = input.id?.trim() || slugify(input.name) || randomUUID().slice(0, 8);
    if (this.config.commands.some((c) => c.id === id)) {
      throw new ConfigError(`Command "${id}" already exists`);
    }

    const command = { ...input, id } as CommandConfig;
    const nextConfig: ConductorConfig = {
      ...this.config,
      commands: [...this.config.commands, command],
    };
    this.config = validateConfig(nextConfig);
    this.mutableQueue = this.buildGlobalQueue();
    this.persist();
    return this.config.commands.find((c) => c.id === id)!;
  }

  /**
   * Updates a root-level command.
   */
  updateCommand(commandId: string, patch: Partial<Omit<CommandConfig, "id">>): CommandConfig {
    const existing = this.config.commands.find((c) => c.id === commandId);
    if (!existing) {
      throw new ConfigError(`Unknown command "${commandId}"`);
    }

    const updated = { ...existing, ...patch, id: commandId };
    const nextConfig: ConductorConfig = {
      ...this.config,
      commands: this.config.commands.map((c) => (c.id === commandId ? updated : c)),
    };
    this.config = validateConfig(nextConfig);
    this.mutableQueue = this.buildGlobalQueue();
    this.persist();
    return this.config.commands.find((c) => c.id === commandId)!;
  }

  /**
   * Removes a command and all references to it from profiles.
   */
  removeCommand(commandId: string): void {
    // Remove from root commands
    const nextConfig: ConductorConfig = {
      ...this.config,
      commands: this.config.commands.filter((c) => c.id !== commandId),
      // Also remove from all profiles
      profiles: Object.fromEntries(
        Object.entries(this.config.profiles).map(([name, profile]) => [
          name,
          {
            ...profile,
            command_ids: profile.command_ids.filter((id) => id !== commandId),
          },
        ]),
      ),
    };
    this.config = validateConfig(nextConfig);
    this.mutableQueue = this.buildGlobalQueue();
    this.persist();
  }

  /**
   * Duplicates a root-level command with a new ID.
   */
  duplicateCommand(commandId: string): CommandConfig {
    const existing = this.config.commands.find((c) => c.id === commandId);
    if (!existing) {
      throw new ConfigError(`Unknown command "${commandId}"`);
    }

    // Generate a new ID for the duplicate, avoiding collisions
    let newId = `${existing.id}-copy`;
    let suffix = 2;
    while (this.config.commands.some((c) => c.id === newId)) {
      newId = `${existing.id}-copy-${suffix}`;
      suffix++;
    }

    const duplicated = { ...existing, id: newId };
    const nextConfig: ConductorConfig = {
      ...this.config,
      commands: [...this.config.commands, duplicated],
    };

    this.config = validateConfig(nextConfig);
    this.mutableQueue = this.buildGlobalQueue();
    this.persist();
    return this.config.commands.find((c) => c.id === newId)!;
  }

  /**
   * Adds a command to a profile by reference (command_ids).
   */
  addCommandToProfile(profileName: string, commandId: string): ProfileConfig {
    const profile = this.config.profiles[profileName];
    if (!profile) {
      throw new ConfigError(`Unknown profile "${profileName}"`);
    }

    if (!this.config.commands.some((c) => c.id === commandId)) {
      throw new ConfigError(`Unknown command "${commandId}"`);
    }

    if (profile.command_ids.includes(commandId)) {
      throw new ConfigError(`Profile "${profileName}" already references command "${commandId}"`);
    }

    const nextProfile: ProfileConfig = {
      ...profile,
      command_ids: [...profile.command_ids, commandId],
    };

    this.config = validateConfig({
      ...this.config,
      profiles: { ...this.config.profiles, [profileName]: nextProfile },
    });
    this.mutableQueue = this.buildGlobalQueue();
    this.persist();
    return this.config.profiles[profileName];
  }

  /**
   * Removes a command reference from a profile.
   */
  removeCommandFromProfile(profileName: string, commandId: string): ProfileConfig {
    const profile = this.config.profiles[profileName];
    if (!profile) {
      throw new ConfigError(`Unknown profile "${profileName}"`);
    }

    const nextProfile: ProfileConfig = {
      ...profile,
      command_ids: profile.command_ids.filter((id) => id !== commandId),
    };

    this.config = validateConfig({
      ...this.config,
      profiles: { ...this.config.profiles, [profileName]: nextProfile },
    });
    this.mutableQueue = this.buildGlobalQueue();
    this.persist();
    return this.config.profiles[profileName];
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
