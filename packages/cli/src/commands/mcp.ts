import { readEndpointFile } from "@conductor/core";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_URL = "http://localhost:4000";
const PROBE_TIMEOUT_MS = 2000;
const STDIN_DRAIN_TIMEOUT_MS = 60_000;
const CORE_POLL_MS = 1000;

export type BaseUrlSource = "flag" | "env" | "endpoint-file" | "default";

export interface ResolvedBase {
  url: string;
  source: BaseUrlSource;
}

const stripTrailingSlashes = (url: string) => url.replace(/\/+$/, "");

/** `--url`, then `CONDUCTOR_API_URL`, then a live instance's endpoint file, then the default port. */
export function resolveBaseUrl(flag?: string): ResolvedBase {
  // Empty or whitespace-only values count as unset.
  const fromFlag = flag?.trim();
  if (fromFlag) return { url: stripTrailingSlashes(fromFlag), source: "flag" };
  const fromEnv = process.env.CONDUCTOR_API_URL?.trim();
  if (fromEnv) return { url: stripTrailingSlashes(fromEnv), source: "env" };
  const fromFile = readEndpointFile()?.url.trim();
  if (fromFile) return { url: stripTrailingSlashes(fromFile), source: "endpoint-file" };
  return { url: DEFAULT_URL, source: "default" };
}

export async function isReachable(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Probe the resolved base URL. An endpoint file can outlive its core's real
 * port (a pid reused by an unrelated process), so when the URL came from the
 * file and does not answer, try the default port once before giving up.
 * `url` is null when nothing answered; `tried` lists every URL probed.
 */
export async function findReachableBase(
  resolved: ResolvedBase,
  probe: (base: string) => Promise<boolean> = isReachable,
  defaultUrl: string = DEFAULT_URL,
): Promise<{ url: string | null; tried: string[]; fellBack: boolean }> {
  const tried = [resolved.url];
  if (await probe(resolved.url)) return { url: resolved.url, tried, fellBack: false };
  if (resolved.source === "endpoint-file" && defaultUrl !== resolved.url) {
    tried.push(defaultUrl);
    if (await probe(defaultUrl)) return { url: defaultUrl, tried, fellBack: true };
  }
  return { url: null, tried, fellBack: false };
}

function warn(message: string) {
  process.stderr.write(`conductor mcp: ${message}\n`);
}

function hasId(
  message: JSONRPCMessage,
): message is JSONRPCMessage & { id: string | number; method: string } {
  return "id" in message && "method" in message;
}

/** The request never reached the core (nothing listening), so sending it again is safe. */
export function isConnectionRefused(err: unknown): boolean {
  const code = (err as { code?: unknown; cause?: { code?: unknown } })?.code;
  const causeCode = (err as { cause?: { code?: unknown } })?.cause?.code;
  return [code, causeCode].some((c) => c === "ConnectionRefused" || c === "ECONNREFUSED");
}

/**
 * What the bridge answers itself while no core is reachable, so the client
 * keeps the server instead of marking it failed; `null` means "send an error".
 * The empty tool list is replaced via `notifications/tools/list_changed` once
 * the core comes up.
 */
export function offlineResult(message: JSONRPCMessage): Record<string, unknown> | null {
  if (!hasId(message)) return null;
  switch (message.method) {
    case "initialize": {
      const requested = (message as { params?: { protocolVersion?: unknown } }).params
        ?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "conductor", version: "0.1.0" },
      };
    }
    case "tools/list":
      return { tools: [] };
    case "ping":
      return {};
    default:
      return null;
  }
}

export function registerMcpCommand(program: import("commander").Command) {
  program
    .command("mcp")
    .description("Bridge stdio MCP clients to a running Conductor core (JSON-RPC on stdout)")
    .option("--url <url>", "Conductor core base URL (default: auto-discovered)")
    .action(async (opts: { url?: string }) => {
      // stdout carries JSON-RPC only; anything that logs there would corrupt the stream.
      for (const method of ["log", "info", "debug", "dir", "table", "trace"] as const) {
        console[method] = console.error;
      }

      const stdio = new StdioServerTransport();
      // The core the bridge talks to, or null while none answers. The desktop
      // sidecar binds a random port on every start, so a restart moves it:
      // the URL is looked up again whenever the core stops answering.
      let http: StreamableHTTPClientTransport | null = null;
      let base: string | null = null;
      // Negotiated on initialize; every later transport must send it too.
      let protocolVersion: string | undefined;
      let warnedLoopback = false;
      let closing = false;
      // Set when the client was answered offline, so it must re-list tools later.
      let servedOffline = false;
      let poll: ReturnType<typeof setInterval> | null = null;

      const shutdown = () => {
        if (closing) return;
        closing = true;
        if (poll) clearInterval(poll);
        void Promise.allSettled([stdio.close(), http?.close()]).then(() => process.exit(0));
      };

      // Requests awaiting a response; stdin closing waits for these so
      // `echo '{...}' | conductor mcp` still gets its answers.
      const pending = new Set<string | number>();
      let stdinEnded = false;
      const settle = (message: JSONRPCMessage) => {
        stdio
          .send(message)
          .then(() => {
            if ("id" in message && message.id !== undefined) pending.delete(message.id);
            if (stdinEnded && pending.size === 0) shutdown();
          })
          .catch((err: Error) => {
            warn(`could not write to stdout: ${err.message}`);
            shutdown();
          });
      };
      const fail = (message: JSONRPCMessage, reason: string) => {
        if (hasId(message)) {
          settle({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: `Conductor core request failed: ${reason}` },
          });
        }
      };

      const attach = async (url: string) => {
        const previous = http;
        if (previous) {
          // Closing fires onclose, which must not shut the bridge down.
          previous.onclose = previous.onerror = previous.onmessage = undefined;
          void previous.close();
        }
        const next = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
        if (protocolVersion) next.setProtocolVersion(protocolVersion);
        next.onerror = (err) => warn(`http: ${err.message}`);
        next.onclose = shutdown;
        next.onmessage = (message) => {
          // The HTTP transport must echo the negotiated version on later requests.
          const version = (message as { result?: { protocolVersion?: unknown } }).result
            ?.protocolVersion;
          if (typeof version === "string") {
            protocolVersion = version;
            next.setProtocolVersion(version);
          }
          settle(message);
        };
        await next.start();
        http = next;
        base = url;
      };

      // One lookup at a time: requests failing together share its result.
      let lookup: Promise<boolean> | null = null;
      const reconnect = () => {
        lookup ??= (async () => {
          const probed = await findReachableBase(resolveBaseUrl(opts.url));
          if (probed.url === null) return false;
          if (probed.url !== base) warn(`connected to Conductor core at ${probed.url}`);
          await attach(probed.url);
          return true;
        })().finally(() => {
          lookup = null;
        });
        return lookup;
      };

      const waitForCore = () => {
        if (poll || closing) return;
        poll = setInterval(() => {
          void reconnect().then((found) => {
            if (!found || !poll) return;
            clearInterval(poll);
            poll = null;
            if (servedOffline) {
              servedOffline = false;
              settle({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
            }
          });
        }, CORE_POLL_MS);
        poll.unref();
      };

      const answerOffline = (message: JSONRPCMessage) => {
        const result = offlineResult(message);
        if (result && hasId(message)) {
          if (message.method === "initialize") {
            protocolVersion = result.protocolVersion as string;
          }
          servedOffline = true;
          settle({ jsonrpc: "2.0", id: message.id, result });
        } else {
          fail(message, "Conductor core is not running");
        }
        waitForCore();
      };

      const forward = async (message: JSONRPCMessage, retried = false): Promise<void> => {
        if (!http && !(await reconnect())) return answerOffline(message);
        try {
          await http!.send(message);
        } catch (err) {
          // /mcp refuses non-loopback hosts with 403; say why, once.
          if (err instanceof StreamableHTTPError && err.code === 403) {
            if (!warnedLoopback) {
              warnedLoopback = true;
              warn(`/mcp only accepts loopback hosts (localhost, 127.0.0.1, [::1]); got ${base}`);
            }
            return fail(message, (err as Error).message);
          }
          // Only a refused connection is retried: anything else may have reached
          // the core, and a tool call like command_execute must not run twice.
          if (!retried && isConnectionRefused(err)) {
            if (await reconnect()) return forward(message, true);
            warn(`Conductor core at ${base} stopped answering; waiting for it to come back`);
            return answerOffline(message);
          }
          warn(`could not reach core: ${(err as Error).message}`);
          fail(message, (err as Error).message);
        }
      };

      stdio.onerror = (err) => warn(`stdio: ${err.message}`);
      stdio.onclose = shutdown;
      stdio.onmessage = (message) => {
        if (hasId(message)) pending.add(message.id);
        void forward(message);
      };

      // stdin emits both "end" and "close"; only the first one counts.
      const onStdinEnd = () => {
        if (stdinEnded) return;
        stdinEnded = true;
        if (pending.size === 0) shutdown();
        else setTimeout(shutdown, STDIN_DRAIN_TIMEOUT_MS).unref();
      };
      process.stdin.on("end", onStdinEnd);
      process.stdin.on("close", onStdinEnd);

      const probed = await findReachableBase(resolveBaseUrl(opts.url));
      if (probed.url === null) {
        const where =
          probed.tried.length > 1
            ? `${probed.tried[0]} (from the endpoint file) or ${probed.tried[1]} (the default)`
            : probed.tried[0];
        // Exiting would make the client give up on the server for good.
        warn(
          `Conductor core is not reachable at ${where}; waiting for it. Start it with \`bun run dev:core\` or open the desktop app.`,
        );
      } else {
        if (probed.fellBack) {
          warn(`the endpoint file's URL ${probed.tried[0]} did not answer; using ${probed.url}`);
        }
        await attach(probed.url);
      }
      await stdio.start();
    });
}
