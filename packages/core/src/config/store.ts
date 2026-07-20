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
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
