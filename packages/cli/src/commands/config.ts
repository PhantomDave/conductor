import pc from "picocolors";
import { discoverConfigPath, loadConfig, ConfigError } from "@conductor/core";

export function registerConfigCommand(program: import("commander").Command) {
  const config = program.command("config").description("Config file utilities");

  config
    .command("validate [file]")
    .description("Validate a .conductor.yml file")
    .action((file?: string) => {
      const path = file ?? discoverConfigPath();
      if (!path) {
        console.error(pc.red("✗ No .conductor.yml found."));
        process.exit(1);
      }

      try {
        loadConfig(path);
        console.log(pc.green(`✓ Schema valid: ${path}`));
      } catch (err) {
        if (err instanceof ConfigError) {
          console.error(pc.red(`✗ ${err.message}`));
          process.exit(1);
        }
        throw err;
      }
    });
}
