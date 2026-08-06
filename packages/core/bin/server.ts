import { existsSync } from "node:fs";
import { join } from "node:path";
import { discoverConfigPath, loadConfig, createDefaultConfig } from "../src";
import { saveConfig } from "../src";
import { ConfigStore } from "../src";
import { createLogger } from "../src";
import { openDatabase, DEFAULT_DB_PATH } from "../src";
import { ConductorQueries } from "../src";
import { LogBroadcaster } from "../src";
import type { LogEntry } from "../src";
import { buildApi } from "../src";
import { MetricCollector } from "../src";

const PORT = Number(process.env.CONDUCTOR_PORT ?? 4000);

async function main() {
  // Bootstrap: if no .conductor.yml exists anywhere up the tree, create
  // one in the current directory so the UI/API have something to persist
  // into immediately, instead of requiring a config file up front.
  let configPath = discoverConfigPath();
  if (!configPath) {
    configPath = join(process.cwd(), ".conductor.yml");
    if (!existsSync(configPath)) {
      saveConfig(configPath, createDefaultConfig());
    }
  }

  const config = loadConfig(configPath);
  const logger = createLogger({ secretKeys: config.env_secrets });
  const db = openDatabase(DEFAULT_DB_PATH);
  const queries = new ConductorQueries(db);
  const broadcaster = new LogBroadcaster();

  const resolveDbEnv = (scope: string): Record<string, string> => {
    const rows =
      scope === "__global__"
        ? queries.listEnvVars("global")
        : queries.listEnvVars("profile", scope);
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  };

  const store = new ConfigStore(configPath, config, resolveDbEnv);

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

  // Every log line from any managed process is persisted and broadcast
  // so both the CLI (via `conductor logs`) and the UI's live SSE stream
  // can see it, regardless of who started the process.
  const onLog = (entry: LogEntry) => {
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

  const app = await buildApi({
    logger,
    queries,
    store,
    broadcaster,
    onLog,
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info(`Conductor core listening on http://localhost:${PORT}`);

  // Start the metrics collector now that the API is running
  collector.start();

  // Stop every managed process cleanly (respecting each command's
  // stop_signal/stop_timeout_ms) before exiting, so killing the server -
  // whether via Ctrl+C, `systemctl stop`, or an Electron shell quitting
  // its sidecar - never orphans the child processes it started.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, stopping all managed processes...`);
    await Promise.all([...store.getQueues().values()].map((queue) => queue.stopAll()));
    collector.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start Conductor core:", err);
  process.exit(1);
});
