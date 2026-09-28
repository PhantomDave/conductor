import { relative } from "node:path";
import pc from "picocolors";
import {
  buildProfileEnv,
  compileConfigExamples,
  configureConfigFiles,
  dbEnvLookup,
  firstProfileOf,
  type ConfigFilesReport,
} from "@conductor/core";
import { openQueries, requireConfig } from "../config-context";

export function registerConfigureCommand(program: import("commander").Command) {
  program
    .command("configure [profile]")
    .description(
      "Compile .env/appsettings.json (etc.) from their .example templates under base_path, " +
        "and converge each command's declared config_files. " +
        "Omit [profile] to resolve env from global scope only.",
    )
    .option("-f, --force", "Overwrite files that already exist")
    .option("--plan", "Show what config_files would change, without writing anything")
    .action(async (profile: string | undefined, opts: { force?: boolean; plan?: boolean }) => {
      const { config, configPath } = requireConfig();
      const selected = profile ? config.profiles[profile] : undefined;
      if (profile && !selected) {
        console.error(pc.red(`✗ Unknown profile "${profile}"`));
        process.exit(1);
      }

      const dbEnv = dbEnvLookup(openQueries(configPath));
      const envParams = {
        configFilePath: configPath,
        config,
        profile: selected,
        dbGlobalEnv: dbEnv("__global__"),
        dbProfileEnv: profile ? dbEnv(profile) : {},
      };
      const env = buildProfileEnv(envParams);
      const basePath = env.BASE_PATH ?? process.cwd();

      // The example compile is a write, so a plan skips it.
      if (!opts.plan) {
        const report = compileConfigExamples(basePath, env, { force: opts.force });
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
      }

      const ids = selected?.command_ids;
      const commands = ids ? config.commands.filter((c) => ids.includes(c.id)) : config.commands;
      const report = configureConfigFiles(envParams, commands, {
        apply: !opts.plan,
        basePath,
        // Without a profile, resolve each command the way a server start does.
        envFor: profile
          ? undefined
          : (cmd) => {
              const name = firstProfileOf(config, cmd.id);
              return {
                ...envParams,
                profile: name ? config.profiles[name] : undefined,
                dbProfileEnv: name ? dbEnv(name) : {},
              };
            },
      });
      printConfigFiles(report, basePath, Boolean(opts.plan));
    });
}

function printConfigFiles(report: ConfigFilesReport, basePath: string, plan: boolean) {
  const rel = (path: string) => relative(basePath, path) || path;

  if (report.configFiles.length > 0) {
    console.log(pc.bold(`\nConfig files${plan ? " (plan - nothing written)" : ""}`));
    let total = 0;
    for (const file of report.configFiles) {
      const name = `${rel(file.path)} ${pc.dim(`[${file.commandId}]`)}`;
      if (file.error) {
        console.log(pc.red(`  ✗ ${name}: ${file.error}`));
        continue;
      }
      if (!file.exists && file.changes.length === 0) {
        console.log(pc.dim(`  - ${name} (doesn't exist, nothing to set)`));
      } else if (file.changes.length === 0) {
        console.log(pc.dim(`  = ${name} up to date`));
      } else {
        console.log(`  ${file.exists ? pc.yellow("~") : pc.green("+")} ${name}`);
      }
      total += file.changes.length;
      for (const change of file.changes) {
        console.log(
          change.action === "add"
            ? pc.green(`      + ${change.key} = "${change.to}"`)
            : pc.yellow(`      ~ ${change.key}: "${change.from}" → "${change.to}"`),
        );
      }
      if (file.missingVars.length > 0) {
        console.log(
          pc.red(
            `      ! no value for ${file.missingVars.join(", ")} - keys using them left as is`,
          ),
        );
      }
      for (const key of file.skipped) {
        console.log(pc.dim(`      - ${key}: Conductor's value is empty, kept the file's`));
      }
    }
    console.log(pc.bold(`\n${total} change(s) ${plan ? "to apply" : "applied"}`));
  }

  const { unusedEnv, unmatchedFileKeys } = report.lint;
  if (unusedEnv.length === 0 && unmatchedFileKeys.length === 0) return;
  console.log(pc.yellow(pc.bold("\n⚠ Unused / did you mean")));
  const hint = (suggestion?: string) =>
    suggestion ? pc.cyan(` - did you mean ${suggestion}?`) : "";
  for (const { key, suggestion } of unusedEnv) {
    console.log(
      pc.yellow(`  ${key}`) + pc.dim(" is set but no config file uses it") + hint(suggestion),
    );
  }
  for (const { path, key, suggestion } of unmatchedFileKeys) {
    console.log(
      pc.yellow(`  ${rel(path)}: ${key}`) +
        pc.dim(" isn't provided by Conductor") +
        hint(suggestion),
    );
  }
  console.log(
    pc.dim(
      "  (a process may still read these straight from its env - these are hints, not errors)",
    ),
  );
}
