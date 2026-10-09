import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  buildApi,
  LogBroadcaster,
  saveConfig,
  validateConfig,
  WorkspaceManager,
  type ApiDependencies,
} from "../../src";

export interface McpHarness {
  root: string;
  /** The seeded workspace directory (`<root>/ws`); not opened until a test opens it. */
  dir: string;
  manager: WorkspaceManager;
  app: FastifyInstance;
  baseUrl: string;
  /** Connects a real SDK client over HTTP; closed by `stop()`. */
  connect(): Promise<Client>;
  /** Stops processes, closes clients, the workspace and the server, and removes temp files. */
  stop(): Promise<void>;
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

export function textOf(result: CallResult): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

/** Calls a tool and parses its JSON text result; fails the test on a tool error. */
export async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  // oxlint-disable-next-line no-explicit-any -- tests index into arbitrary tool results
): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${textOf(result)}`);
  return JSON.parse(textOf(result));
}

/**
 * Boots a real listening API (loopback, random port) backed by a
 * WorkspaceManager, with a seeded workspace directory, for MCP client tests.
 */
export async function startMcpHarness(): Promise<McpHarness> {
  const root = mkdtempSync(join(tmpdir(), "conductor-mcp-"));
  const dir = join(root, "ws");
  mkdirSync(dir, { recursive: true });
  saveConfig(
    join(dir, ".conductor.yml"),
    validateConfig({
      version: "1",
      name: "MCP Workspace",
      commands: [{ id: "web", name: "Web", run: "echo hi", shell: false }],
      profiles: { dev: { command_ids: ["web"] } },
    }),
  );
  const broadcaster = new LogBroadcaster();
  const deps = { broadcaster } as ApiDependencies;
  const manager = new WorkspaceManager({
    dataDir: join(root, "data"),
    deps,
    session: { broadcaster, logLevel: "silent" },
  });
  deps.workspaces = manager;
  const app = await buildApi(deps);
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  const clients: Client[] = [];

  return {
    root,
    dir,
    manager,
    app,
    baseUrl,
    async connect() {
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
      clients.push(client);
      return client;
    },
    async stop() {
      for (const client of clients) await client.close().catch(() => {});
      await manager.close().catch(() => {});
      await app.close();
      // Windows lets go of a just-closed workspace's files a moment later (EBUSY), so retry briefly.
      for (let attempt = 0; ; attempt++) {
        try {
          rmSync(root, { recursive: true, force: true });
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (attempt >= 30 || (code !== "EBUSY" && code !== "EPERM")) throw err;
          await Bun.sleep(100);
        }
      }
    },
  };
}
