import { readEndpointFile } from "@conductor/core";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_URL = "http://localhost:4000";
const PROBE_TIMEOUT_MS = 2000;
const STDIN_DRAIN_TIMEOUT_MS = 60_000;

/** `--url`, then `CONDUCTOR_API_URL`, then a live instance's endpoint file, then the default port. */
export function resolveBaseUrl(flag?: string): string {
  const url = flag ?? process.env.CONDUCTOR_API_URL ?? readEndpointFile()?.url ?? DEFAULT_URL;
  return url.replace(/\/+$/, "");
}

async function isReachable(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
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
      console.log = console.error;
      console.info = console.error;

      const base = resolveBaseUrl(opts.url);
      if (!(await isReachable(base))) {
        warn(
          `Conductor core is not reachable at ${base}. Start it with \`bun run dev:core\` or open the desktop app.`,
        );
        process.exit(1);
      }

      const stdio = new StdioServerTransport();
      const http = new StreamableHTTPClientTransport(new URL("/mcp", base));

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
      const settle = async (message: JSONRPCMessage) => {
        await stdio.send(message);
        if ("id" in message && message.id !== undefined) pending.delete(message.id);
        if (stdinEnded && pending.size === 0) shutdown();
      };

      stdio.onerror = (err) => warn(`stdio: ${err.message}`);
      http.onerror = (err) => warn(`http: ${err.message}`);
      stdio.onclose = shutdown;
      http.onclose = shutdown;

      stdio.onmessage = (message) => {
        if (hasId(message)) pending.add(message.id);
        http.send(message).catch((err: Error) => {
          warn(`could not reach core: ${err.message}`);
          // Answer the request ourselves, or the client would wait forever.
          if (hasId(message)) {
            void settle({
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
        void settle(message);
      };

      const onStdinEnd = () => {
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
