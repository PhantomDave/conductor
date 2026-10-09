import {
  BasePathSchema,
  ConfigImportSchema,
  ConfigureInputSchema,
  DefaultShellSchema,
  DockerComposeParseSchema,
  LogRetentionSchema,
} from "../../api-schemas";
import { DESTROY, MUTATE, READ, defineTool, type McpToolDef } from "../route";

export const configTools: McpToolDef[] = [
  defineTool({
    name: "config_export",
    description:
      "Return the whole workspace configuration (.conductor.yml) as YAML text in the 'yaml' field. Does not write any file.",
    input: {},
    annotations: READ,
    request: () => ({ method: "GET", url: "/api/config/export" }),
  }),
  defineTool({
    name: "config_import",
    description:
      "Replace the entire workspace configuration (commands, profiles, settings) with the given .conductor.yml text. Everything currently configured is overwritten; run config_export first if you may need it back.",
    input: ConfigImportSchema.shape,
    annotations: DESTROY,
    request: (args) => ({ method: "POST", url: "/api/config/import", payload: args }),
  }),
  defineTool({
    name: "configure",
    description:
      "Compile config example files (.env.example, appsettings.example.json, ...) into real config files and apply each command's config_files settings. Set plan to true to only preview the changes without writing; set force to overwrite files that already exist. Optionally scope to one profile.",
    input: ConfigureInputSchema.shape,
    annotations: MUTATE,
    request: (args) => ({ method: "POST", url: "/api/configure", payload: args }),
  }),
  defineTool({
    name: "base_path_get",
    description:
      "Get the workspace base path (the directory where the target application is installed, used to resolve relative command working directories) and its resolved absolute form.",
    input: {},
    annotations: READ,
    request: () => ({ method: "GET", url: "/api/base-path" }),
  }),
  defineTool({
    name: "base_path_set",
    description: "Set the workspace base path. Affects where commands with a relative cwd run.",
    input: BasePathSchema.shape,
    annotations: MUTATE,
    request: (args) => ({ method: "PUT", url: "/api/base-path", payload: args }),
  }),
  defineTool({
    name: "shell_get",
    description:
      "List the shells available on this machine and the configured default shell (used for commands with shell: true and for command healthchecks).",
    input: {},
    annotations: READ,
    request: () => ({ method: "GET", url: "/api/shells" }),
  }),
  defineTool({
    name: "shell_set",
    description:
      "Set the default shell for shell commands and healthchecks, or pass null to restore the system default.",
    input: DefaultShellSchema.shape,
    annotations: MUTATE,
    request: (args) => ({ method: "PUT", url: "/api/shells", payload: args }),
  }),
  defineTool({
    name: "log_retention_get",
    description:
      "Get the log retention settings: how many days of logs to keep and how many sessions per profile (0 disables that limit).",
    input: {},
    annotations: READ,
    request: () => ({ method: "GET", url: "/api/log-retention" }),
  }),
  defineTool({
    name: "log_retention_set",
    description:
      "Set both log retention limits (days and sessions per profile; 0 disables a limit). Applied on the next sweep, or immediately with log_prune.",
    input: LogRetentionSchema.shape,
    annotations: MUTATE,
    request: (args) => ({ method: "PUT", url: "/api/log-retention", payload: args }),
  }),
  defineTool({
    name: "docker_compose_parse",
    description:
      "Convert docker-compose YAML text into Conductor command definitions (returned, not saved). Create the ones you want with command_create.",
    input: DockerComposeParseSchema.shape,
    annotations: READ,
    request: (args) => ({ method: "POST", url: "/api/docker-compose/parse", payload: args }),
  }),
];
