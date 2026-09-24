import { dirname, join } from "node:path";
import pc from "picocolors";
import {
  discoverConfigPath,
  loadConfig,
  ConfigError,
  ConductorQueries,
  DEFAULT_DB_PATH,
  openDatabase,
} from "@conductor/core";

export function requireConfig() {
  const configPath = discoverConfigPath();
  if (!configPath) {
    console.error(pc.red("✗ No .conductor.yml found in this directory or any parent."));
    process.exit(1);
  }

  try {
    return { configPath, config: loadConfig(configPath) };
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(pc.red(`✗ ${err.message}`));
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Opens the same SQLite DB the server uses (the Environment tab's vars live
 * there). The server opens `DEFAULT_DB_PATH` relative to its cwd, which is
 * normally the config's directory, so resolve it against that.
 */
export function openQueries(configPath: string): ConductorQueries {
  return new ConductorQueries(openDatabase(join(dirname(configPath), DEFAULT_DB_PATH)));
}
