import { readFileSync, writeFileSync, existsSync } from "node:fs";
import pc from "picocolors";
import { requireConfig } from "../config-context";

function envFilePath(profile: string): string {
  return `.env.${profile}.local`;
}

function readLocalEnv(profile: string): Record<string, string> {
  const path = envFilePath(profile);
  if (!existsSync(path)) return {};

  const content = readFileSync(path, "utf-8");
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key) env[key] = rest.join("=");
  }
  return env;
}

function writeLocalEnv(profile: string, env: Record<string, string>): void {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envFilePath(profile), lines.join("\n") + "\n");
}

export function registerEnvCommand(program: import("commander").Command) {
  const env = program.command("env").description("Manage per-profile environment overrides");

  env
    .command("get <profile> <key>")
    .description("Read an env var for a profile")
    .action((profile: string, key: string) => {
      const { config } = requireConfig();
      const selected = config.profiles[profile];
      if (!selected) {
        console.error(pc.red(`✗ Unknown profile "${profile}"`));
        process.exit(1);
      }

      const local = readLocalEnv(profile);
      const value = local[key] ?? selected.env[key];
      console.log(value ?? pc.dim("(not set)"));
    });

  env
    .command("set <profile> <key> <value>")
    .description("Set a local env var override for a profile")
    .action((profile: string, key: string, value: string) => {
      requireConfig();
      const local = readLocalEnv(profile);
      local[key] = value;
      writeLocalEnv(profile, local);
      console.log(pc.green(`✓ Set ${key} in ${envFilePath(profile)}`));
    });
}
