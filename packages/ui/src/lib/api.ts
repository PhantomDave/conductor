export interface ProcessInfo {
  commandId: string;
  commandName: string;
  profile: string;
  pid: number;
  status: "starting" | "running" | "stopping" | "stopped" | "failed";
  health: "unknown" | "healthy" | "unhealthy";
  cpuPercent?: number;
  memoryBytes?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
}

export interface HealthcheckInfo {
  type: "none" | "port" | "http" | "command";
  port?: number;
  url?: string;
  command?: string;
  interval_ms: number;
  timeout_ms: number;
  retries: number;
}

export interface CommandInfo {
  id: string;
  name: string;
  description?: string;
  run: string;
  cwd: string;
  shell: boolean;
  deps: string[];
  env_overrides: Record<string, string>;
  watch: string[];
  readonly: boolean;
  stop_signal: string;
  stop_timeout_ms: number;
  stop_command?: string;
  healthcheck?: HealthcheckInfo;
}

export interface ProfileInfo {
  description?: string;
  command_ids: string[];
  commands: CommandInfo[]; // Always populated by useProfiles resolver
}

export interface EnvVarRow {
  id: number;
  scope: "global" | "profile";
  profile: string | null;
  key: string;
  value: string;
  is_secret: number;
  updated_at: string;
}

export interface LogRow {
  id: number;
  process_id: string;
  command_id: string;
  profile: string;
  timestamp: string;
  level: string;
  stream: "stdout" | "stderr";
  message: string;
}

const API_BASE = "/api";

async function parseJsonOrThrow(res: Response, fallbackMessage: string) {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? fallbackMessage);
  }
  return res.json();
}

export async function fetchProcesses(): Promise<ProcessInfo[]> {
  const res = await fetch(`${API_BASE}/processes`);
  const data = await parseJsonOrThrow(res, `Failed to fetch processes: ${res.status}`);
  return data.processes ?? [];
}

export async function fetchProfiles(): Promise<
  Record<string, ProfileInfo & { commands: CommandInfo[] }>
> {
  const res = await fetch(`${API_BASE}/profiles`);
  const data = await parseJsonOrThrow(res, `Failed to fetch profiles: ${res.status}`);
  const { profiles, commands } = data;

  // Resolve command_ids to full command objects
  const resolvedProfiles = Object.fromEntries(
    Object.entries(profiles ?? {}).map(([name, profile]: [string, any]) => [
      name,
      {
        description: profile.description,
        command_ids: profile.command_ids,
        commands: (profile.command_ids as string[])
          .map((id: string) => (commands as CommandInfo[]).find((c: CommandInfo) => c.id === id))
          .filter((c: CommandInfo | undefined): c is CommandInfo => c !== undefined),
      } as ProfileInfo & { commands: CommandInfo[] },
    ]),
  );

  return resolvedProfiles;
}

export async function createProfile(name: string, description?: string): Promise<void> {
  const res = await fetch(`${API_BASE}/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  await parseJsonOrThrow(res, `Failed to create profile "${name}"`);
}

export async function deleteProfile(profile: string): Promise<void> {
  const res = await fetch(`${API_BASE}/profiles/${profile}`, { method: "DELETE" });
  await parseJsonOrThrow(res, `Failed to delete profile "${profile}"`);
}

export async function renameProfile(oldName: string, newName: string): Promise<ProfileInfo> {
  const res = await fetch(`${API_BASE}/profiles/${oldName}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newName }),
  });
  const data = await parseJsonOrThrow(res, `Failed to rename profile "${oldName}"`);
  return data.profile;
}

export async function duplicateProfile(sourceName: string, newName: string): Promise<ProfileInfo> {
  const res = await fetch(`${API_BASE}/profiles/${sourceName}/duplicate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newName }),
  });
  const data = await parseJsonOrThrow(res, `Failed to duplicate profile "${sourceName}"`);
  return data.profile;
}

export async function exportProfile(profile: string): Promise<string> {
  const res = await fetch(`${API_BASE}/profiles/${profile}/export`);
  const data = await parseJsonOrThrow(res, `Failed to export profile "${profile}"`);
  return data.yaml;
}

export type CommandInput = Partial<Omit<CommandInfo, "id">> & {
  id?: string;
  name: string;
  run: string;
};

export async function createCommand(profile: string, input: CommandInput): Promise<CommandInfo> {
  const res = await fetch(`${API_BASE}/profiles/${profile}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseJsonOrThrow(res, `Failed to create command "${input.name}"`);
  return data.command;
}

export async function updateCommand(
  profile: string,
  commandId: string,
  patch: Partial<Omit<CommandInfo, "id">>,
): Promise<CommandInfo> {
  const res = await fetch(`${API_BASE}/profiles/${profile}/commands/${commandId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await parseJsonOrThrow(res, `Failed to update command "${commandId}"`);
  return data.command;
}

export async function deleteCommand(profile: string, commandId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/profiles/${profile}/commands/${commandId}`, {
    method: "DELETE",
  });
  await parseJsonOrThrow(res, `Failed to delete command "${commandId}"`);
}

export async function executeCommand(profile: string, commandId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/commands/${commandId}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  });
  await parseJsonOrThrow(res, `Failed to execute "${commandId}"`);
}

export async function restartCommand(
  profile: string,
  commandId: string,
): Promise<ProcessInfo | undefined> {
  const res = await fetch(`${API_BASE}/commands/${commandId}/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  });
  const data = await parseJsonOrThrow(res, `Failed to restart "${commandId}"`);
  return data.process;
}

export async function runProfile(profile: string): Promise<void> {
  const res = await fetch(`${API_BASE}/profiles/${profile}/run`, { method: "POST" });
  await parseJsonOrThrow(res, `Failed to run profile "${profile}"`);
}

export async function stopProfile(profile: string): Promise<void> {
  const res = await fetch(`${API_BASE}/profiles/${profile}/stop`, { method: "POST" });
  await parseJsonOrThrow(res, `Failed to stop profile "${profile}"`);
}

export async function stopProcess(pid: number): Promise<void> {
  const res = await fetch(`${API_BASE}/processes/${pid}`, { method: "DELETE" });
  await parseJsonOrThrow(res, `Failed to stop process ${pid}`);
}

export async function fetchLogs(params: {
  pid?: number;
  commandId?: string;
  profile?: string;
  limit?: number;
}): Promise<LogRow[]> {
  const query = new URLSearchParams();
  if (params.pid) query.set("pid", String(params.pid));
  if (params.commandId) query.set("commandId", params.commandId);
  if (params.profile) query.set("profile", params.profile);
  if (params.limit) query.set("limit", String(params.limit));

  const res = await fetch(`${API_BASE}/logs?${query.toString()}`);
  const data = await parseJsonOrThrow(res, "Failed to fetch logs");
  return data.logs ?? [];
}

export function streamLogs(pid: number, onEntry: (entry: LogRow) => void): () => void {
  const source = new EventSource(`${API_BASE}/logs/stream?pid=${pid}`);
  source.addEventListener("log", (event) => {
    onEntry(JSON.parse((event as MessageEvent).data));
  });
  return () => source.close();
}

export interface BasePathInfo {
  base_path: string;
  resolved: string;
}

export async function fetchBasePath(): Promise<BasePathInfo> {
  const res = await fetch(`${API_BASE}/base-path`);
  return parseJsonOrThrow(res, "Failed to fetch base path");
}

export async function updateBasePath(basePath: string): Promise<BasePathInfo> {
  const res = await fetch(`${API_BASE}/base-path`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_path: basePath }),
  });
  return parseJsonOrThrow(res, "Failed to update base path");
}

export interface ShellOption {
  path: string;
  name: string;
}

export interface ShellsInfo {
  available: ShellOption[];
  default_shell: string | null;
}

export async function fetchShells(): Promise<ShellsInfo> {
  const res = await fetch(`${API_BASE}/shells`);
  return parseJsonOrThrow(res, "Failed to fetch shells");
}

/** Pass `null` to clear the override and fall back to the OS default again. */
export async function updateDefaultShell(shell: string | null): Promise<ShellsInfo> {
  const res = await fetch(`${API_BASE}/shells`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ default_shell: shell }),
  });
  return parseJsonOrThrow(res, "Failed to update default shell");
}

export interface ConductorConfigInfo {
  version: string;
  name?: string;
  description?: string;
  base_path: string;
  profiles: Record<string, ProfileInfo>;
}

/**
 * Replaces the entire config (profiles, commands, base_path, ...) from a
 * `.conductor.yml` file's raw text - e.g. one shared by a teammate or
 * downloaded as a project template - instead of recreating everything
 * by hand through the UI.
 */
export async function importConfig(yamlText: string): Promise<ConductorConfigInfo> {
  const res = await fetch(`${API_BASE}/config/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml: yamlText }),
  });
  const data = await parseJsonOrThrow(res, "Failed to import config");
  return data.config;
}

export interface CompileResult {
  examplePath: string;
  targetPath: string;
  action: "created" | "skipped-exists" | "error";
  missingVars: string[];
  error?: string;
}

export interface CompileReport {
  basePath: string;
  results: CompileResult[];
  created: number;
  skipped: number;
  errors: number;
  missingVars: string[];
}

export async function compileConfigExamples(input: {
  profile?: string;
  force?: boolean;
}): Promise<CompileReport> {
  const res = await fetch(`${API_BASE}/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJsonOrThrow(res, "Failed to compile config files");
}

export async function fetchEnvVars(
  scope: "global" | "profile",
  profile?: string,
): Promise<EnvVarRow[]> {
  const query = new URLSearchParams({ scope });
  if (profile) query.set("profile", profile);
  const res = await fetch(`${API_BASE}/env?${query.toString()}`);
  const data = await parseJsonOrThrow(res, "Failed to fetch env vars");
  return data.vars ?? [];
}

export async function upsertEnvVar(input: {
  scope: "global" | "profile";
  profile?: string | null;
  key: string;
  value: string;
  secret?: boolean;
}): Promise<EnvVarRow> {
  const res = await fetch(`${API_BASE}/env`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseJsonOrThrow(res, `Failed to save env var "${input.key}"`);
  return data.var;
}

export async function deleteEnvVar(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/env/${id}`, { method: "DELETE" });
  await parseJsonOrThrow(res, "Failed to delete env var");
}

export async function importEnvVars(input: {
  scope: "global" | "profile";
  profile?: string | null;
  text: string;
  secret?: boolean;
}): Promise<number> {
  const res = await fetch(`${API_BASE}/env/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseJsonOrThrow(res, "Failed to import env vars");
  return data.imported ?? 0;
}

// --- Command movement, duplication, and export ----

export async function duplicateCommand(
  sourceProfile: string,
  commandId: string,
  targetProfile: string,
): Promise<CommandInfo> {
  const res = await fetch(`${API_BASE}/profiles/${sourceProfile}/commands/${commandId}/duplicate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetProfile }),
  });
  const data = await parseJsonOrThrow(res, `Failed to duplicate command "${commandId}"`);
  return data.command;
}

export async function moveCommand(
  sourceProfile: string,
  commandId: string,
  targetProfile: string,
): Promise<CommandInfo> {
  const res = await fetch(`${API_BASE}/profiles/${sourceProfile}/commands/${commandId}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetProfile }),
  });
  const data = await parseJsonOrThrow(res, `Failed to move command "${commandId}"`);
  return data.command;
}

export async function exportConfig(): Promise<string> {
  const res = await fetch(`${API_BASE}/config/export`);
  const data = await parseJsonOrThrow(res, "Failed to export config");
  return data.yaml;
}

export interface SuggestedCommand {
  id: string;
  name: string;
  run: string;
  stop_command: string;
  healthcheck?: HealthcheckInfo;
  deps: string[];
  needsBuild: boolean;
  buildContext?: string;
}

export async function parseDockerCompose(yamlText: string): Promise<SuggestedCommand[]> {
  const res = await fetch(`${API_BASE}/docker compose/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml: yamlText }),
  });
  const data = await parseJsonOrThrow(res, "Failed to parse docker compose.yml");
  return data.commands ?? [];
}
