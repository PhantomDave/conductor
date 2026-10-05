import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ConfigError, createDefaultConfig, loadConfig } from "../config/loader";
import type { ConductorConfig } from "../config/schema";
import { ConfigStore, dbEnvLookup } from "../config/store";
import { saveConfig } from "../config/writer";
import { DEFAULT_DB_PATH, openDatabase } from "../db/init";
import { ConductorQueries } from "../db/queries";
import type { LogEntry, LogHandler } from "../executor/wrapper";
import { createLogger, type ConductorLogger } from "../logger/pino";
import type { LogBroadcaster } from "../logs/broadcaster";
import { MetricCollector } from "../monitor";

/**
 * Resolves a user-supplied workspace path to the directory containing its
 * `.conductor.yml`: expands a leading `~`, accepts either the folder itself
 * or the config file path within it, and requires the folder to exist.
 */
export function resolveWorkspaceDir(input: string): string {
  let dir = input;
  if (dir === "~" || dir.startsWith("~/")) {
    dir = join(homedir(), dir.slice(1));
  }
  dir = resolve(dir);
  if (basename(dir) === ".conductor.yml") {
    dir = dirname(dir);
  }
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ConfigError(`Folder not found: ${dir}`);
  }
  return dir;
}

export interface WorkspaceSession {
  dir: string;
  name: string;
  store: ConfigStore;
  queries: ConductorQueries;
  logger: ConductorLogger;
  onLog: LogHandler;
  close(): Promise<void>;
}

export interface SessionOptions {
  dbPath?: string;
  broadcaster: LogBroadcaster;
  logLevel?: string;
}

/**
 * Validates (and if missing, creates) `<dir>/.conductor.yml` without
 * touching the database. Split out from `openSession` so callers that just
 * need to know whether a folder is a valid workspace don't pay for a DB
 * open.
 */
export function prepareSession(dir: string): { configPath: string; config: ConductorConfig } {
  const configPath = join(dir, ".conductor.yml");
  if (!existsSync(configPath)) {
    const config = createDefaultConfig();
    config.name = basename(dir);
    saveConfig(configPath, config);
    const conductorDir = join(dir, ".conductor");
    mkdirSync(conductorDir, { recursive: true });
    writeFileSync(join(conductorDir, ".gitignore"), "*\n");
  }
  return { configPath, config: loadConfig(configPath) };
}

/**
 * Opens a full per-config session: validates/creates `.conductor.yml`,
 * opens its SQLite DB, and wires up the store, queries, logger and log
 * pipeline that `buildApi` needs. Call `close()` to stop every managed
 * process and release the DB before switching workspaces or exiting.
 */
export function openSession(dir: string, opts: SessionOptions): WorkspaceSession {
  const { configPath, config } = prepareSession(dir);
  const logger = createLogger({ secretKeys: config.env_secrets, level: opts.logLevel });
  // Next to the config (not cwd), so the CLI's `openQueries` finds the same DB.
  const dbPath = opts.dbPath ?? join(dir, DEFAULT_DB_PATH);
  const db = openDatabase(dbPath);
  const queries = new ConductorQueries(db);
  const broadcaster = opts.broadcaster;

  const store = new ConfigStore(configPath, config, dbEnvLookup(queries));

  // CPU/memory metrics collector — samples process-group totals every 5s
  // and persists them to SQLite for historical query by the UI.
  const collector = new MetricCollector(
    () =>
      [...store.getQueues().values()]
        .flatMap((q) => q.listSnapshots())
        .filter((s) => s.status === "running")
        .map((s) => ({ pid: s.pid })),
    queries,
    {
      intervalMs: 5000,
      retentionHours: 24,
      // Write live values back into the wrapper so snapshots served by
      // /api/processes carry current CPU/memory for the UI's live columns.
      onSample: (pid, cpuPercent, memoryBytes) => {
        for (const queue of store.getQueues().values()) {
          const wrapper = queue.findByPid(pid);
          if (wrapper) {
            wrapper.updateMetrics(cpuPercent, memoryBytes);
            break;
          }
        }
      },
    },
  );
  collector.start();

  // Every log line from any managed process is persisted and broadcast
  // so both the CLI (via `conductor logs`) and the UI's live SSE stream
  // can see it, regardless of who started the process.
  const onLog: LogHandler = (entry: LogEntry) => {
    const row = queries.insertLog({
      process_id: String(entry.pid),
      command_id: entry.commandId,
      profile: entry.profile,
      timestamp: entry.timestamp,
      level: entry.stream === "stderr" ? "error" : "info",
      stream: entry.stream,
      message: entry.message,
    });
    broadcaster.publish(row);
  };

  // Time-window log retention sweep. Session-scoped retention doesn't need
  // its own timer - it runs inline on every /api/profiles/:profile/run.
  const logRetentionInterval = setInterval(
    () => {
      const days = store.getConfig().log_retention_days;
      if (days <= 0) return;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      try {
        queries.deleteLogsBefore(cutoff);
      } catch (err) {
        logger.error({ err }, "Log retention sweep failed");
      }
    },
    60 * 60 * 1000,
  );

  return {
    dir,
    name: config.name ?? basename(dir),
    store,
    queries,
    logger,
    onLog,
    async close() {
      await Promise.all([...store.getQueues().values()].map((q) => q.stopAll()));
      collector.stop();
      clearInterval(logRetentionInterval);
      db.close();
    },
  };
}
