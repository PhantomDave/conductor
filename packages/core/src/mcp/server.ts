import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { callRoute, TOOLS } from "./tools";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

// hostname (letters, digits, dots, dashes) or bracketed IPv6, optional :port
const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?$/i;

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Pure guard for `/mcp`. The server binds 0.0.0.0 and the tool surface can run
 * arbitrary shell commands, so only same-machine callers with a loopback
 * `Host` (anti DNS-rebinding) and, if sent, a loopback `Origin` (anti
 * cross-site browser requests) are allowed. Returns a reason, or null if OK.
 */
export function checkMcpRequest(input: {
  remoteAddress: string | undefined;
  host: string | undefined;
  origin: string | undefined;
}): string | null {
  const { remoteAddress, host, origin } = input;
  if (!remoteAddress || !LOOPBACK_ADDRESSES.has(remoteAddress)) {
    return "non-loopback remote address";
  }

  const hostMatch = host ? HOST_RE.exec(host) : null;
  if (!hostMatch || !LOOPBACK_HOSTNAMES.has(stripBrackets(hostMatch[1]!.toLowerCase()))) {
    return "non-loopback Host header";
  }

  if (origin !== undefined) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return "invalid Origin header";
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !LOOPBACK_HOSTNAMES.has(stripBrackets(url.hostname.toLowerCase()))
    ) {
      return "non-loopback Origin header";
    }
  }
  return null;
}

function createMcpServer(app: FastifyInstance): McpServer {
  const server = new McpServer({ name: "conductor", version: "0.1.0" });
  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.input, annotations: def.annotations },
      async (args: unknown, extra: { signal?: AbortSignal }) => {
        if (def.run) return def.run(args, { app, signal: extra.signal });
        if (def.request) return callRoute(app, def.request(args));
        throw new Error(`tool ${def.name} has neither request nor run`);
      },
    );
  }
  return server;
}

const METHOD_NOT_ALLOWED = {
  jsonrpc: "2.0",
  error: { code: -32000, message: "Method not allowed." },
  id: null,
};

/**
 * Mounts the stateless MCP endpoint at `/mcp` (Streamable HTTP). Each POST gets
 * a fresh McpServer + transport, closed when the response ends. Must be called
 * before the static/SPA not-found handler is registered.
 */
export async function registerMcp(app: FastifyInstance): Promise<void> {
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      const reason = checkMcpRequest({
        remoteAddress: request.socket.remoteAddress,
        host: request.headers.host,
        origin: request.headers.origin,
      });
      if (reason) return reply.status(403).send({ error: "forbidden" });

      if (request.method !== "POST") {
        return reply.status(405).header("Allow", "POST").send(METHOD_NOT_ALLOWED);
      }

      const server = createMcpServer(app);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      reply.raw.on("close", () => {
        // server.close() also closes the transport it is connected to.
        server.close().catch(() => {});
      });
      // The SDK writes the response itself; Fastify must not touch it.
      reply.hijack();
      try {
        await server.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (err) {
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader("content-type", "application/json");
          reply.raw.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32603,
                message: err instanceof Error ? err.message : "Internal error",
              },
              id: null,
            }),
          );
        } else {
          reply.raw.end();
        }
      }
    },
  });
}
