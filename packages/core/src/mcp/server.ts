import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { callRoute, TOOLS } from "./tools";

function createMcpServer(app: FastifyInstance): McpServer {
  // ponytail: serverInfo version is fixed, not read from package.json
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
