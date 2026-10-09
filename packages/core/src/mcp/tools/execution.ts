import { z } from "zod";
import type { ProcessSnapshot } from "../../executor/wrapper";
import {
  DESTROY,
  MUTATE,
  READ,
  callRoute,
  defineTool,
  enc,
  textResult,
  type McpToolDef,
} from "../route";

const profileName = z.string().min(1).describe("Profile name");
const commandId = z.string().min(1).describe("Command id");
const pid = z.number().int().positive().describe("OS process id, as shown by process_list");

/** Poll interval, default and ceiling for process_wait. */
const POLL_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

const WAIT_STATES = ["running", "healthy", "stopped", "exited"] as const;
type WaitState = (typeof WAIT_STATES)[number];

function reached(until: WaitState, snapshot: ProcessSnapshot): boolean {
  switch (until) {
    case "running":
      return snapshot.status === "running";
    case "healthy":
      return snapshot.health === "healthy";
    case "stopped":
      return snapshot.status === "stopped";
    // "completed" is a clean exit on its own (e.g. a one-shot task), which is
    // an exit as far as a caller waiting for the process to end is concerned.
    case "exited":
      return (
        snapshot.status === "stopped" ||
        snapshot.status === "completed" ||
        snapshot.status === "failed"
      );
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const executionTools: McpToolDef[] = [
  defineTool({
    name: "profile_run",
    description:
      "Start every command of a profile concurrently (respecting each command's deps), after auto-creating any missing .env files from their .example templates. Returns once startup has been attempted; check process_list, process_wait or notification_list for the outcome of each command.",
    input: { profile: profileName },
    annotations: MUTATE,
    request: ({ profile }) => ({ method: "POST", url: `/api/profiles/${enc(profile)}/run` }),
  }),
  defineTool({
    name: "profile_stop",
    description: "Stop all running processes belonging to the commands of a profile.",
    input: { profile: profileName },
    annotations: DESTROY,
    request: ({ profile }) => ({ method: "POST", url: `/api/profiles/${enc(profile)}/stop` }),
  }),
  defineTool({
    name: "command_execute",
    description:
      "Start a single command (and wait for its healthcheck, if it has one, before returning). Fails if the command is unknown or does not become healthy. Optionally tag the process with the profile it belongs to for log filtering.",
    input: {
      id: commandId,
      profile: z.string().min(1).optional().describe("Profile to tag the process with"),
    },
    annotations: MUTATE,
    request: ({ id, profile }) => ({
      method: "POST",
      url: `/api/commands/${enc(id)}/execute`,
      payload: profile === undefined ? {} : { profile },
    }),
  }),
  defineTool({
    name: "command_restart",
    description:
      "Stop a command if it is running and start it again with its current definition. Use after command_update or env_set to pick up changes.",
    input: {
      id: commandId,
      profile: z.string().min(1).optional().describe("Profile label for the audit trail"),
    },
    annotations: MUTATE,
    request: ({ id, profile }) => ({
      method: "POST",
      url: `/api/commands/${enc(id)}/restart`,
      payload: profile === undefined ? {} : { profile },
    }),
  }),
  defineTool({
    name: "process_list",
    description:
      "List the latest process snapshot of every command started in this workspace: pid, status (starting/running/stopping/stopped/completed/failed), health (unknown/healthy/unhealthy), timestamps and exit code.",
    input: {},
    annotations: READ,
    request: () => ({ method: "GET", url: "/api/processes" }),
  }),
  defineTool({
    name: "process_stop",
    description:
      "Stop a running process by pid (graceful signal first, then force). Use process_list to find the pid.",
    input: { pid },
    annotations: DESTROY,
    request: ({ pid }) => ({ method: "DELETE", url: `/api/processes/${pid}` }),
  }),
  defineTool({
    name: "process_metrics",
    description:
      "CPU and memory samples recorded for a process, optionally limited to an ISO-8601 time range.",
    input: {
      pid,
      from: z.string().optional().describe("ISO-8601 start of the range"),
      to: z.string().optional().describe("ISO-8601 end of the range"),
    },
    annotations: READ,
    request: ({ pid, from, to }) => ({
      method: "GET",
      url: `/api/processes/${pid}/metrics`,
      query: { from, to },
    }),
  }),
  defineTool({
    name: "process_wait",
    description:
      "Wait until a process reaches a state, then return its snapshot. Identify it by commandId (the newest process of that command) or pid, not both. until: 'running' (status running), 'healthy' (healthcheck passing), 'stopped' (stopped on request), 'exited' (stopped, completed or failed). Errors immediately if the process fails (unless until is 'exited'), and on timeout (default 30000 ms, max 120000 ms; many MCP clients abort requests after about 60 s, so prefer shorter waits and call again).",
    input: {
      commandId: z.string().min(1).optional().describe("Command to wait for (newest process)"),
      pid: z.number().int().positive().optional().describe("Specific process id to wait for"),
      until: z.enum(WAIT_STATES),
      timeout_ms: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
    },
    annotations: READ,
    run: async (args, { app }) => {
      const { commandId, pid, until } = args;
      if ((commandId === undefined) === (pid === undefined)) {
        return textResult("provide exactly one of commandId or pid", true);
      }
      const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const target = pid !== undefined ? `pid ${pid}` : `command "${commandId}"`;
      const deadline = Date.now() + timeoutMs;
      let last: ProcessSnapshot | undefined;

      for (;;) {
        const res = await callRoute(app, { method: "GET", url: "/api/processes" });
        if (res.isError) return res;
        const first = res.content[0];
        const { processes } = JSON.parse(first?.type === "text" ? first.text : "{}") as {
          processes: ProcessSnapshot[];
        };
        // A command not yet spawned has no snapshot; keep polling for it.
        const matches = processes.filter((p) =>
          pid !== undefined ? p.pid === pid : p.commandId === commandId,
        );
        last = matches.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

        if (last) {
          const json = JSON.stringify(last, null, 2);
          if (reached(until, last)) return textResult(json);
          if (last.status === "failed") {
            return textResult(`${target} failed before reaching '${until}':\n${json}`, true);
          }
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(POLL_MS, remaining));
      }

      return textResult(
        `timed out after ${timeoutMs} ms waiting for ${target} to be '${until}'; ` +
          (last
            ? `last snapshot:\n${JSON.stringify(last, null, 2)}`
            : "no matching process was found"),
        true,
      );
    },
  }),

  defineTool({
    name: "notification_list",
    description:
      "List recent notifications (process crashes, failed healthchecks, recoveries), newest first. Check this when a command did not start or stopped unexpectedly.",
    input: {
      limit: z.number().int().min(1).max(1000).optional().describe("Default 100"),
      offset: z.number().int().min(0).optional().describe("Default 0"),
    },
    annotations: READ,
    request: ({ limit, offset }) => ({
      method: "GET",
      url: "/api/notifications",
      query: { limit, offset },
    }),
  }),
  defineTool({
    name: "notification_clear",
    description: "Delete all stored notifications.",
    input: {},
    annotations: DESTROY,
    request: () => ({ method: "DELETE", url: "/api/notifications" }),
  }),
];
