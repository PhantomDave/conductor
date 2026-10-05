import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverConfigPath, createDefaultConfig } from "../src";
import { saveConfig } from "../src";
import { LogBroadcaster } from "../src";
import { buildApi } from "../src";
import { openSession } from "../src";

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

  const broadcaster = new LogBroadcaster();
  const session = openSession(dirname(configPath), { broadcaster });

  const app = await buildApi({
    logger: session.logger,
    queries: session.queries,
    store: session.store,
    broadcaster,
    onLog: session.onLog,
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
  session.logger.info(`Conductor core listening on http://localhost:${PORT}`);

  // Stop every managed process cleanly (respecting each command's
  // stop_signal/stop_timeout_ms) before exiting, so killing the server -
  // whether via Ctrl+C, `systemctl stop`, or an Electron shell quitting
  // its sidecar - never orphans the child processes it started.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    session.logger.info(`Received ${signal}, stopping all managed processes...`);
    await session.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start Conductor core:", err);
  process.exit(1);
});
