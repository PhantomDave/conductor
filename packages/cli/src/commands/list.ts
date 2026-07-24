import pc from "picocolors";
import type { CommandConfig } from "@conductor/core";
import { requireConfig } from "../config-context";

export function registerListCommand(program: import("commander").Command) {
  program
    .command("list [profile]")
    .description("List available profiles, or commands within a profile")
    .action((profile?: string) => {
      const { config } = requireConfig();

      if (!profile) {
        console.log(pc.bold("Available profiles:"));
        for (const [name, p] of Object.entries(config.profiles)) {
          console.log(`  ${pc.cyan(name)}  ${p.description ?? ""}`);
        }
        return;
      }

      const selected = config.profiles[profile];
      if (!selected) {
        console.error(pc.red(`✗ Unknown profile "${profile}"`));
        process.exit(1);
      }

      // Resolve command_ids to full command objects
      const commands = selected.command_ids
        .map((id) => config.commands.find((c) => c.id === id))
        .filter((c): c is CommandConfig => c !== undefined);

      console.log(pc.bold(`Commands in "${profile}":`));
      for (const cmd of commands) {
        const deps = cmd.deps.length ? pc.dim(` (deps: ${cmd.deps.join(", ")})`) : "";
        console.log(`  ${pc.cyan(cmd.id)}  ${cmd.name}${deps}`);
      }
    });
}
