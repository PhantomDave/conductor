import { z } from "zod";
import {
  CommandDuplicateSchema,
  CommandInputSchema,
  CommandMoveSchema,
  CommandPatchSchema,
  CommandSyncSchema,
  ProfileUpdateSchema,
} from "../../api-schemas";
import { DESTROY, MUTATE, READ, defineTool, enc, type McpToolDef } from "../route";

const profileName = z.string().min(1).describe("Profile name");
const commandId = z.string().min(1).describe("Command id");

/**
 * The API transforms a null/empty `category` to undefined, which JSON drops;
 * the update route then cannot tell "clear it" from "leave it". Tools accept the raw
 * value and let the route do its own normalisation, so null still clears.
 */
const category = z
  .string()
  .nullable()
  .optional()
  .describe("Grouping label; null or empty on update clears it");

const commandCreateShape = { ...CommandInputSchema.shape, category };
const commandPatchShape = { ...CommandPatchSchema.shape, category };

export const profileTools: McpToolDef[] = [
  defineTool({
    name: "profile_list",
    description:
      "List the profiles (named groups of commands) defined in the open workspace's .conductor.yml, along with every command definition. Use this to see what can be started.",
    input: {},
    annotations: READ,
    request: () => ({ method: "GET", url: "/api/profiles" }),
  }),
  defineTool({
    name: "profile_create",
    description:
      "Create an empty profile (a named group of commands, e.g. 'dev'). Add commands to it afterwards with profile_command_add or profile_command_sync.",
    input: {
      name: z.string().min(1).describe("New profile name"),
      description: z.string().optional(),
    },
    annotations: MUTATE,
    request: (args) => ({ method: "POST", url: "/api/profiles", payload: args }),
  }),
  defineTool({
    name: "profile_update",
    description:
      "Rename a profile and/or change its description. Provide at least one of newName or description.",
    input: { profile: profileName, ...ProfileUpdateSchema.shape },
    annotations: MUTATE,
    request: ({ profile, ...body }) => ({
      method: "PUT",
      url: `/api/profiles/${enc(profile)}`,
      payload: body,
    }),
  }),
  defineTool({
    name: "profile_delete",
    description:
      "Delete a profile. The commands it contained are kept (they stay in command_list); only the grouping is removed.",
    input: { profile: profileName },
    annotations: DESTROY,
    request: ({ profile }) => ({ method: "DELETE", url: `/api/profiles/${enc(profile)}` }),
  }),
  defineTool({
    name: "profile_duplicate",
    description: "Copy a profile under a new name. The copy references the same commands.",
    input: { profile: profileName.describe("Profile to copy"), newName: z.string().min(1) },
    annotations: MUTATE,
    request: ({ profile, ...body }) => ({
      method: "POST",
      url: `/api/profiles/${enc(profile)}/duplicate`,
      payload: body,
    }),
  }),
  defineTool({
    name: "profile_export",
    description:
      "Export one profile and its commands as a standalone .conductor.yml document (returned as YAML text in the result). Does not write any file.",
    input: { profile: profileName },
    annotations: READ,
    request: ({ profile }) => ({ method: "GET", url: `/api/profiles/${enc(profile)}/export` }),
  }),

  defineTool({
    name: "command_list",
    description:
      "List every command defined in the open workspace (id, name, run line, env overrides, restart policy, healthcheck). Use this to look up command ids before starting or editing one.",
    input: {},
    annotations: READ,
    request: () => ({ method: "GET", url: "/api/command" }),
  }),
  defineTool({
    name: "command_create",
    description:
      "Define a new command (a shell/process line Conductor can run) in the workspace, not attached to any profile. The id is generated from the name if omitted. This only defines it; start it with command_execute, or attach it to a profile with profile_command_sync.",
    input: commandCreateShape,
    annotations: MUTATE,
    request: (args) => ({ method: "POST", url: "/api/command", payload: args }),
  }),
  defineTool({
    name: "command_update",
    description:
      "Change fields of an existing command (only the fields you pass are changed). A running process keeps the old definition until it is restarted with command_restart.",
    input: { id: commandId, ...commandPatchShape },
    annotations: MUTATE,
    request: ({ id, ...patch }) => ({
      method: "PUT",
      url: `/api/command/${enc(id)}`,
      payload: patch,
    }),
  }),
  defineTool({
    name: "command_delete",
    description:
      "Permanently delete a command definition. This also unlinks it from every profile that referenced it.",
    input: { id: commandId },
    annotations: DESTROY,
    request: ({ id }) => ({ method: "DELETE", url: `/api/command/${enc(id)}` }),
  }),

  defineTool({
    name: "profile_command_add",
    description:
      "Create a new command and add it to a profile in one step. Use command_create + profile_command_sync instead to attach an already-defined command.",
    input: { profile: profileName, ...commandCreateShape },
    annotations: MUTATE,
    request: ({ profile, ...command }) => ({
      method: "POST",
      url: `/api/profiles/${enc(profile)}/commands`,
      payload: command,
    }),
  }),
  defineTool({
    name: "profile_command_update",
    description:
      "Change fields of a command via a profile (same effect as command_update; the profile is only used for the audit trail). Only the fields you pass are changed.",
    input: { profile: profileName, id: commandId, ...commandPatchShape },
    annotations: MUTATE,
    request: ({ profile, id, ...patch }) => ({
      method: "PUT",
      url: `/api/profiles/${enc(profile)}/commands/${enc(id)}`,
      payload: patch,
    }),
  }),
  defineTool({
    name: "profile_command_sync",
    description:
      "Attach and/or detach existing commands to a profile in one batch (ids in 'add' are linked, ids in 'remove' are unlinked). Command definitions themselves are never deleted.",
    input: { profile: profileName, ...CommandSyncSchema.shape },
    annotations: MUTATE,
    request: ({ profile, ...body }) => ({
      method: "POST",
      url: `/api/profiles/${enc(profile)}/commands/sync`,
      payload: body,
    }),
  }),
  defineTool({
    name: "profile_command_remove",
    description:
      "Unlink a command from a profile. The command definition is kept and still appears in command_list; use command_delete to delete it entirely.",
    input: { profile: profileName, id: commandId },
    annotations: DESTROY,
    request: ({ profile, id }) => ({
      method: "DELETE",
      url: `/api/profiles/${enc(profile)}/commands/${enc(id)}`,
    }),
  }),
  defineTool({
    name: "profile_command_duplicate",
    description:
      "Clone a command under a new generated id, optionally linking the copy to a profile via targetProfile. The profile argument only identifies where the original is listed.",
    input: { profile: profileName, id: commandId, ...CommandDuplicateSchema.shape },
    annotations: MUTATE,
    request: ({ profile, id, ...body }) => ({
      method: "POST",
      url: `/api/profiles/${enc(profile)}/commands/${enc(id)}/duplicate`,
      payload: body,
    }),
  }),
  defineTool({
    name: "profile_command_move",
    description:
      "Move a command from one profile to another (unlinks it from 'profile', links it to targetProfile).",
    input: {
      profile: profileName.describe("Source profile"),
      id: commandId,
      ...CommandMoveSchema.shape,
    },
    annotations: MUTATE,
    request: ({ profile, id, ...body }) => ({
      method: "POST",
      url: `/api/profiles/${enc(profile)}/commands/${enc(id)}/move`,
      payload: body,
    }),
  }),
];
