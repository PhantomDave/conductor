import { WorkspacePathSchema } from "../../api-schemas";
import { DESTROY, MUTATE, READ, defineTool, type McpToolDef } from "../route";

export const workspaceTools: McpToolDef[] = [
  defineTool({
    name: "workspace_list",
    description:
      "List the workspaces Conductor knows about (recently opened project directories) and which one is currently open. Works even when no workspace is open; use it first to discover what can be opened.",
    input: {},
    annotations: READ,
    request: () => ({ method: "GET", url: "/api/workspaces" }),
  }),
  defineTool({
    name: "workspace_open",
    description:
      "Open a project directory as the active workspace (creates a .conductor.yml there if missing). Stops every process of the currently open workspace first. Every other tool needs a workspace open.",
    input: WorkspacePathSchema.shape,
    annotations: MUTATE,
    request: (args) => ({ method: "POST", url: "/api/workspaces/open", payload: args }),
  }),
  defineTool({
    name: "workspace_close",
    description:
      "Close the active workspace, stopping all of its running processes. After this only the workspace_* tools work until another workspace is opened.",
    input: {},
    annotations: DESTROY,
    request: () => ({ method: "POST", url: "/api/workspaces/close" }),
  }),
  defineTool({
    name: "workspace_forget",
    description:
      "Remove a directory from the recent-workspaces list. Does not touch the directory or its .conductor.yml.",
    input: WorkspacePathSchema.shape,
    annotations: DESTROY,
    request: (args) => ({ method: "DELETE", url: "/api/workspaces", query: { path: args.path } }),
  }),
];
