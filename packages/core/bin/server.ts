import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  buildApi,
  createDefaultConfig,
  createLogger,
  discoverConfigPath,
  loadConfig,
  LogBroadcaster,
  readRecent,
  recordRecent,
  removeEndpointFile,
  saveConfig,
  WorkspaceManager,
  writeEndpointFile,
  type ApiDependencies,
} from "../src";

const PORT = Number(process.env.CONDUCTOR_PORT ?? 4000);

async function main() {
  const broadcaster = new LogBroadcaster();
  // ponytail: deps fields are unset until a workspace opens; the onRequest guard keeps handlers from running before that
  const deps = { broadcaster } as ApiDependencies;
  const logger = createLogger();

  // Discovery mode resolves a config path before the data dir can default
  // correctly (it lives next to the config, not wherever `conductor` was
  // launched from); start-screen mode has no config yet, so cwd stands in.
  let configPath: string | null = null;
  let dataDir: string;
  if (process.env.CONDUCTOR_START_SCREEN === "1") {
    dataDir = resolve(process.env.CONDUCTOR_DATA_DIR ?? process.cwd());
  } else {
    // Bootstrap: if no .conductor.yml exists anywhere up the tree, create
    // one in the current directory so the UI/API have something to persist
    // into immediately, instead of requiring a config file up front.
    configPath = discoverConfigPath();
    if (!configPath) {
      configPath = join(process.cwd(), ".conductor.yml");
      if (!existsSync(configPath)) {
        saveConfig(configPath, createDefaultConfig());
      }
    }
    dataDir = resolve(
      process.env.CONDUCTOR_DATA_DIR ?? join(dirname(configPath), ".conductor", "data"),
    );
  }

  const manager = new WorkspaceManager({ dataDir, deps, session: { broadcaster } });
  deps.workspaces = manager;

  if (configPath) {
    await manager.open(dirname(configPath));
  } else {
    // Start-screen mode (the desktop app): open nothing, let the UI pick.
    // Seed the recent list with the legacy single-config desktop setup.
    const legacy = join(dataDir, ".conductor.yml");
    if (existsSync(legacy) && readRecent(dataDir).length === 0) {
      let name = basename(dataDir);
      try {
        name = loadConfig(legacy).name ?? name;
      } catch {
        // A broken legacy config must not block boot; opening it reports the error.
      }
      recordRecent(dataDir, { path: dataDir, name });
    }
  }

  const app = await buildApi(deps);

  await app.listen({ port: PORT, host: "0.0.0.0" });
  // PORT 0 asks the OS for a free port; advertise the one actually bound.
  const address = app.server.address();
  const boundPort = typeof address === "object" && address ? address.port : PORT;
  logger.info(`Conductor core listening on http://localhost:${boundPort}`);

  // Let `conductor mcp` find this instance (the desktop sidecar's port is random).
  // ponytail: one file per machine, last core to start wins; running two cores at
  // once leaves the bridge pointing at whichever started later (or at :4000 once it exits)
  try {
    writeEndpointFile(`http://127.0.0.1:${boundPort}`);
  } catch (err) {
    logger.warn({ err }, "Could not write the endpoint discovery file");
  }

  // Stop every managed process cleanly (respecting each command's
  // stop_signal/stop_timeout_ms) before exiting, so killing the server -
  // whether via Ctrl+C, `systemctl stop`, or an Electron shell quitting
  // its sidecar - never orphans the child processes it started.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    removeEndpointFile();
    logger.info(`Received ${signal}, stopping all managed processes...`);
    try {
      // A switch mid-flight is still stopping the old workspace (maybe
      // waiting to SIGKILL a child that ignores TERM): let it finish first.
      await manager.idle();
      await manager.close();
    } catch (err) {
      logger.error({ err }, "Failed to close the workspace cleanly");
    }
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
