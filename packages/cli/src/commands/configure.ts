import pc from "picocolors";
import { buildProfileEnv, compileConfigExamples } from "@conductor/core";
import { requireConfig } from "../config-context";

export function registerConfigureCommand(program: import("commander").Command) {
  program
    .command("configure [profile]")
    .description(
      "Compile .env/appsettings.json (etc.) from their .example templates under base_path. " +
        "Omit [profile] to resolve env from global scope only.",
    )
    .option("-f, --force", "Overwrite files that already exist")
    .action(async (profile: string | undefined, opts: { force?: boolean }) => {
      const { config, configPath } = requireConfig();
      const selected = profile ? config.profiles[profile] : undefined;
      if (profile && !selected) {
        console.error(pc.red(`✗ Unknown profile "${profile}"`));
        process.exit(1);
      }

      const env = buildProfileEnv({ configFilePath: configPath, config, profile: selected });
      const report = compileConfigExamples(env.BASE_PATH ?? process.cwd(), env, {
        force: opts.force,
      });

      console.log(pc.bold(`Scanned ${pc.dim(report.basePath)}`));
      for (const result of report.results) {
        const rel = result.targetPath.replace(`${report.basePath}/`, "");
        if (result.action === "created") {
          console.log(pc.green(`  ✓ ${rel}`));
        } else if (result.action === "skipped-exists") {
          console.log(pc.dim(`  - ${rel} (already exists, use --force to overwrite)`));
        } else {
          console.log(pc.red(`  ✗ ${rel}: ${result.error}`));
        }
      }

      console.log(
        pc.bold(
          `\n${report.created} created, ${report.skipped} skipped, ${report.errors} error(s)`,
        ),
      );
      if (report.missingVars.length > 0) {
        console.log(
          pc.yellow(
            `⚠ These vars had no value and were left blank: ${report.missingVars.join(", ")}`,
          ),
        );
      }
    });
}
