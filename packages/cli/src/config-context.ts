import pc from "picocolors";
import { discoverConfigPath, loadConfig, ConfigError } from "@conductor/core";

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
