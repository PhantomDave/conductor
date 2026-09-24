// Boots the real core API (same wiring as bin/server.ts, minus the metrics
// collector and retention timer) against a temp copy of sample.conductor.yml
// and an in-memory DB. Shared by the CLI and UI test suites so both are
// exercised against actual routes rather than mocks.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildApi,
  ConductorQueries,
  ConfigStore,
  createLogger,
  dbEnvLookup,
  loadConfig,
  LogBroadcaster,
  openDatabase,
  type LogEntry,
} from "../../src";

export async function startCore() {
  const dir = mkdtempSync(join(tmpdir(), "conductor-test-"));
  const configPath = join(dir, ".conductor.yml");
  copyFileSync(join(import.meta.dir, "sample.conductor.yml"), configPath);

  const queries = new ConductorQueries(openDatabase(":memory:"));
  const broadcaster = new LogBroadcaster();
  const store = new ConfigStore(configPath, loadConfig(configPath), dbEnvLookup(queries));

  const app = await buildApi({
    logger: createLogger({ level: "silent" }),
    queries,
    store,
    broadcaster,
    onLog: (entry: LogEntry) =>
      broadcaster.publish(
        queries.insertLog({
          process_id: String(entry.pid),
          command_id: entry.commandId,
          profile: entry.profile,
          timestamp: entry.timestamp,
          level: entry.stream === "stderr" ? "error" : "info",
          stream: entry.stream,
          message: entry.message,
        }),
      ),
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });

  return {
    url,
    dir,
    configPath,
    async stop() {
      await Promise.all([...store.getQueues().values()].map((q) => q.stopAll()));
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
