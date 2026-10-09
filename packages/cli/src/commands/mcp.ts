import { readEndpointFile } from "@conductor/core";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_URL = "http://localhost:4000";
const PROBE_TIMEOUT_MS = 2000;
const STDIN_DRAIN_TIMEOUT_MS = 60_000;

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

function hasId(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number } {
  return "id" in message && "method" in message;
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

      const resolved = resolveBaseUrl(opts.url);
      const probed = await findReachableBase(resolved);
      if (probed.url === null) {
        const where =
          probed.tried.length > 1
            ? `${probed.tried[0]} (from the endpoint file) or ${probed.tried[1]} (the default)`
            : probed.tried[0];
        warn(
          `Conductor core is not reachable at ${where}. Start it with \`bun run dev:core\` or open the desktop app.`,
        );
        process.exit(1);
      }
      const base = probed.url;
      if (probed.fellBack) {
        warn(`the endpoint file's URL ${probed.tried[0]} did not answer; using ${base}`);
      }

      const stdio = new StdioServerTransport();
      const http = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));

      let warnedLoopback = false;
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        void Promise.allSettled([stdio.close(), http.close()]).then(() => process.exit(0));
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

      stdio.onerror = (err) => warn(`stdio: ${err.message}`);
      http.onerror = (err) => warn(`http: ${err.message}`);
      stdio.onclose = shutdown;
      http.onclose = shutdown;

      stdio.onmessage = (message) => {
        if (hasId(message)) pending.add(message.id);
        http.send(message).catch((err: Error) => {
          // /mcp refuses non-loopback hosts with 403; say why, once.
          if (err instanceof StreamableHTTPError && err.code === 403 && !warnedLoopback) {
            warnedLoopback = true;
            warn(`/mcp only accepts loopback hosts (localhost, 127.0.0.1, [::1]); got ${base}`);
          } else {
            warn(`could not reach core: ${err.message}`);
          }
          // Answer the request ourselves, or the client would wait forever.
          if (hasId(message)) {
            settle({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32603, message: `Conductor core request failed: ${err.message}` },
            });
          }
        });
      };
      http.onmessage = (message) => {
        // The HTTP transport must echo the negotiated version on later requests.
        const version = (message as { result?: { protocolVersion?: unknown } }).result
          ?.protocolVersion;
        if (typeof version === "string") http.setProtocolVersion(version);
        settle(message);
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
      await http.start();
      await stdio.start();
    });
}
