import pc from "picocolors";
import { SpawnQueue, buildCommandEnv, buildProfileEnv, compileConfigExamples, type LogEntry } from "@conductor/core";
import { requireConfig } from "../config-context";

export function registerRunCommand(program: import("commander").Command) {
  program
    .command("run <profile> [command]")
    .description("Run all commands in a profile, or a single command by id")
    .action(async (profile: string, commandId?: string) => {
      const { config, configPath } = requireConfig();
      const selected = config.profiles[profile];

      if (!selected) {
        console.error(pc.red(`✗ Unknown profile "${profile}"`));
        process.exit(1);
      }

      // Auto-compile any missing .env/appsettings.json from their
      // .example counterparts before starting anything - mirrors the
      // server's /api/profiles/:profile/run behavior so `conductor run`
      // works the same on a fresh checkout with no manual config step.
      const env = buildProfileEnv({ configFilePath: configPath, config, profile: selected });
      const report = compileConfigExamples(env.BASE_PATH ?? process.cwd(), env);
      if (report.created > 0) {
        console.log(pc.dim(`Compiled ${report.created} config file(s) from their .example templates.`));
      }
      if (report.missingVars.length > 0) {
        console.log(
          pc.yellow(
            `⚠ Missing values for: ${report.missingVars.join(", ")} - fill these in via the Environment tab (or .conductor.yml), then run "conductor configure --force" to re-compile.`,
          ),
        );
      }

      const queue = new SpawnQueue(profile, selected.commands, (cmd) =>
        buildCommandEnv({ configFilePath: configPath, config, profile: selected, cmd }),
      );

      const onLog = (entry: LogEntry) => {
        const prefix = entry.stream === "stderr" ? pc.red("│") : pc.dim("│");
        console.log(`${prefix} ${entry.message}`);
      };

      console.log(pc.bold(`Starting profile "${profile}"...`));

      const shutdown = async () => {
        console.log(pc.yellow("\nShutting down..."));
        await queue.stopAll();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      if (commandId) {
        await queue.startOne(commandId, onLog);
      } else {
        await queue.startAll(onLog);
      }
    });
}
