import { randomUUID } from "node:crypto";
import { saveConfig } from "./writer";
import { validateConfig, ConfigError } from "./loader";
import type { ConductorConfig, CommandConfig, ProfileConfig } from "./schema";
import { SpawnQueue } from "../executor/queue";
import {
  buildCommandEnv,
  buildProfileEnv,
  declaredEnvKeys,
  sharedEnvKeys,
  resolveBasePath,
  type BuildCommandEnvParams,
  type BuildEnvParams,
} from "./env-resolution";
import { configureConfigFiles, type ConfigFilesReport } from "./config-files";
import { compileConfigExamples, type CompileReport } from "./example-compiler";
import type { ConductorQueries } from "../db/queries";

export interface EnvVarLookup {
  (profile: string): Record<string, string>;
}

/** Reads DB-stored env vars: "__global__" for the global scope, else a profile name. */
export function dbEnvLookup(queries: ConductorQueries): EnvVarLookup {
  return (scope) =>
    Object.fromEntries(
      (scope === "__global__"
        ? queries.listEnvVars("global")
        : queries.listEnvVars("profile", scope)
      ).map((row) => [row.key, row.value]),
    );
}

/** The profile a command's env resolves through when it's started outside a profile run. */
export function firstProfileOf(config: ConductorConfig, commandId: string): string | undefined {
  return Object.keys(config.profiles).find((name) =>
    config.profiles[name].command_ids.includes(commandId),
  );
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
    return new SpawnQueue(
      "__global__",
      this.config.commands,
      (cmd, profile) => buildCommandEnv(this.commandEnvParams(cmd, profile)),
      (cmd, profile) => ({
        declaredKeys: declaredEnvKeys(this.commandEnvParams(cmd, profile)),
        secretKeys: this.config.env_secrets,
      }),
    );
  }

  /** Env layers for a profile's scope, or just the global scope without one. */
  private envParams(profileName?: string): BuildEnvParams {
    return {
      configFilePath: this.filePath,
      config: this.config,
      profile: profileName ? this.config.profiles[profileName] : undefined,
      dbGlobalEnv: this.resolveDbEnv("__global__"),
      dbProfileEnv: profileName ? this.resolveDbEnv(profileName) : {},
    };
  }

  /**
   * Env params for a command, in the context of the profile that launched it
   * (so a command shared by dev and staging gets the env of the run it is
   * part of), or of the first profile that references it when it was started
   * outside a known profile.
   */
  private commandEnvParams(cmd: CommandConfig, launchedBy?: string): BuildCommandEnvParams {
    const scope =
      launchedBy && this.config.profiles[launchedBy]
        ? launchedBy
        : firstProfileOf(this.config, cmd.id);
    return { ...this.envParams(scope), cmd };
  }

  /** Absolute directory that relative `cwd`s resolve against (see `base_path`). */
  getResolvedBasePath(): string {
    return resolveBasePath(this.filePath, this.config.base_path);
  }

  /** Updates `base_path`, persisting it and re-resolving every command's env. */
  setBasePath(basePath: string): void {
    this.config = validateConfig({ ...this.config, base_path: basePath });
    this.persist();
    this.mutableQueue.setCommands(this.config.commands);
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
    this.persist();
    this.mutableQueue.setCommands(this.config.commands);
  }

  /**
   * Updates both log retention knobs together (they're edited as one
   * concern in the UI/CLI). Unlike setBasePath/setDefaultShell, retention
   * doesn't affect command env resolution, so no queue refresh is needed.
   */
  setLogRetention(input: { days: number; sessions: number }): void {
    this.config = validateConfig({
      ...this.config,
      log_retention_days: input.days,
      log_retention_sessions: input.sessions,
    });
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
    this.mutableQueue.setCommands(this.config.commands);
  }

  /**
   * Scans `base_path` for `.env.example`/`appsettings.example.json`-style
   * files and copies each to its real counterpart (`.env`,
   * `appsettings.json`, ...) with `${VAR}` tokens filled in from this
   * profile's resolved env - so there's no per-service "configurations"
   * command to author or maintain in `.conductor.yml`; any new service
   * that follows the example-file convention picks this up automatically.
   * An existing target isn't rewritten wholesale unless `opts.force` is
   * set, but the keys Conductor declares are converged into it on every
   * run, so its values can't drift from the env store.
   */
  compileConfigExamples(profileName?: string, opts: { force?: boolean } = {}): CompileReport {
    const params = this.envParams(profileName);
    const env = buildProfileEnv(params);
    return compileConfigExamples(this.getResolvedBasePath(), env, {
      ...opts,
      converge: {
        declaredKeys: new Set([...sharedEnvKeys(params), "BASE_PATH"]),
        secretKeys: this.config.env_secrets,
      },
    });
  }

  /**
   * Plans (or, with `apply`, converges) the declared `config_files` of the
   * profile's commands and lints the shared env against what those files
   * and the example templates use. Without a profile it covers every
   * command, each resolved the way a start resolves it (its first profile).
   */
  configureConfigFiles(
    profileName: string | undefined,
    opts: { apply: boolean },
  ): ConfigFilesReport {
    const ids = profileName ? this.config.profiles[profileName]?.command_ids : undefined;
    const commands = ids
      ? this.config.commands.filter((c) => ids.includes(c.id))
      : this.config.commands;
    return configureConfigFiles(this.envParams(profileName), commands, {
      apply: opts.apply,
      basePath: this.getResolvedBasePath(),
      envFor: profileName
        ? undefined
        : (cmd) => this.envParams(firstProfileOf(this.config, cmd.id)),
    });
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
    this.persist();
    this.mutableQueue.setCommands(this.config.commands);
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
    this.persist();
    this.mutableQueue.setCommands(this.config.commands);
    return this.config.profiles[name];
  }

  removeProfile(name: string): void {
    if (!this.config.profiles[name]) {
      throw new ConfigError(`Unknown profile "${name}"`);
    }
    const { [name]: _removed, ...rest } = this.config.profiles;
    this.config = validateConfig({ ...this.config, profiles: rest });
    this.mutableQueue.setCommands(this.config.commands);
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
    this.mutableQueue.setCommands(this.config.commands);
    this.persist();
    return this.config.profiles[newName];
  }

  updateProfile(name: string, changes: { newName?: string; description?: string }): ProfileConfig {
    const profile = this.config.profiles[name];
    if (!profile) {
      throw new ConfigError(`Unknown profile "${name}"`);
    }

    const { newName, description } = changes;

    // If renaming, check for conflicts (but same name is allowed when only updating description)
    if (newName && newName !== name && this.config.profiles[newName]) {
      throw new ConfigError(`Profile "${newName}" already exists`);
    }

    const nextProfiles: Record<string, ProfileConfig> = { ...this.config.profiles };
    // Omitted keeps the current description; "" clears it.
    const nextProfile = {
      ...profile,
      description: description === undefined ? profile.description : description || undefined,
    };

    if (newName && newName !== name) {
      delete nextProfiles[name];
      nextProfiles[newName] = nextProfile;
    } else {
      nextProfiles[name] = nextProfile;
    }

    const nextConfig: ConductorConfig = {
      ...this.config,
      profiles: nextProfiles,
    };
    this.config = validateConfig(nextConfig);
    this.mutableQueue.setCommands(this.config.commands);
    this.persist();
    return this.config.profiles[newName ?? name];
  }

  duplicateProfile(sourceName: string, targetName: string): ProfileConfig {
    const source = this.config.profiles[sourceName];
    if (!source) {
      throw new ConfigError(`Unknown profile "${sourceName}"`);
    }
    if (this.config.profiles[targetName]) {
      throw new ConfigError(`Profile "${targetName}" already exists`);
    }

    // Duplicate only the profile, not the commands
    // Reference the same command_ids so changes to commands affect both profiles
    const nextConfig: ConductorConfig = {
      ...this.config,
      profiles: {
        ...this.config.profiles,
        [targetName]: {
          description: source.description ? `${source.description} (copy)` : undefined,
          env: { ...source.env }, // Shallow copy of env vars
          command_ids: [...source.command_ids], // Reference same commands by ID
        },
      },
    };
    this.config = validateConfig(nextConfig);
    this.mutableQueue.setCommands(this.config.commands);
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
    if (!command.category) delete command.category;
    const nextConfig: ConductorConfig = {
      ...this.config,
      commands: [...this.config.commands, command],
    };
    this.config = validateConfig(nextConfig);
    this.mutableQueue.setCommands(this.config.commands);
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
    if ("category" in patch && !patch.category) delete updated.category;
    const nextConfig: ConductorConfig = {
      ...this.config,
      commands: this.config.commands.map((c) => (c.id === commandId ? updated : c)),
    };
    this.config = validateConfig(nextConfig);
    this.mutableQueue.setCommands(this.config.commands);
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
    this.mutableQueue.setCommands(this.config.commands);
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
    this.mutableQueue.setCommands(this.config.commands);
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
    this.mutableQueue.setCommands(this.config.commands);
    this.persist();
    return this.config.profiles[profileName];
  }

  /**
   * Applies membership changes to one profile in a single validated write:
   * every `add` is checked (known command, not already referenced) before
   * anything changes, so a bad id leaves the profile and the file untouched.
   */
  syncProfileCommands(profileName: string, add: string[], remove: string[]): ProfileConfig {
    const profile = this.config.profiles[profileName];
    if (!profile) {
      throw new ConfigError(`Unknown profile "${profileName}"`);
    }
    for (const commandId of add) {
      if (!this.config.commands.some((c) => c.id === commandId)) {
        throw new ConfigError(`Unknown command "${commandId}"`);
      }
      if (profile.command_ids.includes(commandId)) {
        throw new ConfigError(`Profile "${profileName}" already references command "${commandId}"`);
      }
    }
    return this.setProfileCommands({
      [profileName]: [...profile.command_ids.filter((id) => !remove.includes(id)), ...add],
    })[profileName];
  }

  /**
   * Moves a command reference from one profile to another in a single
   * write, so a failing target (unknown, or already referencing it) can't
   * leave the command dropped from the source.
   */
  moveCommand(sourceName: string, targetName: string, commandId: string): void {
    const source = this.config.profiles[sourceName];
    const target = this.config.profiles[targetName];
    if (!source) throw new ConfigError(`Unknown profile "${sourceName}"`);
    if (!target) throw new ConfigError(`Unknown profile "${targetName}"`);
    if (!this.config.commands.some((c) => c.id === commandId)) {
      throw new ConfigError(`Unknown command "${commandId}"`);
    }
    if (sourceName === targetName) return;
    if (target.command_ids.includes(commandId)) {
      throw new ConfigError(`Profile "${targetName}" already references command "${commandId}"`);
    }
    this.setProfileCommands({
      [sourceName]: source.command_ids.filter((id) => id !== commandId),
      [targetName]: [...target.command_ids, commandId],
    });
  }

  /** Replaces `command_ids` of the given profiles, validated and persisted once. */
  private setProfileCommands(changes: Record<string, string[]>): Record<string, ProfileConfig> {
    const profiles = { ...this.config.profiles };
    for (const [name, commandIds] of Object.entries(changes)) {
      profiles[name] = { ...profiles[name], command_ids: commandIds };
    }
    this.config = validateConfig({ ...this.config, profiles });
    this.mutableQueue.setCommands(this.config.commands);
    this.persist();
    return this.config.profiles;
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
    this.mutableQueue.setCommands(this.config.commands);
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
