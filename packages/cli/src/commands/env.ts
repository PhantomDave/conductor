import pc from "picocolors";
import { buildProfileEnv, dbEnvLookup, looksSecret } from "@conductor/core";
import { openQueries, requireConfig } from "../config-context";

function requireProfile(profile: string) {
  const ctx = requireConfig();
  const selected = ctx.config.profiles[profile];
  if (!selected) {
    console.error(pc.red(`✗ Unknown profile "${profile}"`));
    process.exit(1);
  }
  return { ...ctx, selected };
}

export function registerEnvCommand(program: import("commander").Command) {
  const env = program.command("env").description("Manage per-profile environment overrides");

  env
    .command("get <profile> <key>")
    .description("Read the value a profile's commands will see for an env var")
    .action((profile: string, key: string) => {
      const { config, configPath, selected } = requireProfile(profile);
      const dbEnv = dbEnvLookup(openQueries(configPath));
      const resolved = buildProfileEnv({
        configFilePath: configPath,
        config,
        profile: selected,
        dbGlobalEnv: dbEnv("__global__"),
        dbProfileEnv: dbEnv(profile),
      });
      console.log(resolved[key] ?? pc.dim("(not set)"));
    });

  env
    .command("set <profile> <key> <value>")
    .description("Set an env var for a profile (same store as the UI's Environment tab)")
    .action((profile: string, key: string, value: string) => {
      const { configPath } = requireProfile(profile);
      openQueries(configPath).upsertEnvVar({
        scope: "profile",
        profile,
        key,
        value,
        isSecret: looksSecret(key),
      });
      console.log(pc.green(`✓ Set ${key} for profile "${profile}"`));
    });
}
