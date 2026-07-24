import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { z } from "zod";
import * as yaml from "js-yaml";
import type { ConductorLogger } from "./logger/pino";
import type { ConductorQueries } from "./db/queries";
import type { ConfigStore } from "./config/store";
import type { LogBroadcaster } from "./logs/broadcaster";
import type { LogHandler } from "./executor/wrapper";
import { HealthcheckSchema } from "./config/schema";
import type { ConductorConfig } from "./config/schema";
import { ConfigError } from "./config/loader";
import { listAvailableShells } from "./executor/shell";
import { parseDockerCompose } from "./docker-compose/parser";

export interface ApiDependencies {
  logger: ConductorLogger;
  queries: ConductorQueries;
  store: ConfigStore;
  broadcaster: LogBroadcaster;
  onLog: LogHandler;
}

const CommandInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  run: z.string().min(1),
  cwd: z.string().optional(),
  shell: z.boolean().optional(),
  deps: z.array(z.string()).optional(),
  env_overrides: z.record(z.string(), z.string()).optional(),
  watch: z.array(z.string()).optional(),
  readonly: z.boolean().optional(),
  stop_signal: z.string().optional(),
  stop_timeout_ms: z.number().optional(),
  stop_command: z.string().min(1).optional(),
  healthcheck: HealthcheckSchema.optional(),
});

const CommandPatchSchema = CommandInputSchema.omit({ id: true }).partial();

const EnvVarInputSchema = z.object({
  scope: z.enum(["global", "profile"]),
  profile: z.string().nullable().optional(),
  key: z.string().min(1),
  value: z.string(),
  secret: z.boolean().optional(),
});

const EnvImportSchema = z.object({
  scope: z.enum(["global", "profile"]),
  profile: z.string().nullable().optional(),
  text: z.string(),
  secret: z.boolean().optional(),
});

/** Parses `.env`-style text ("KEY=VALUE" per line, `#` comments, blank lines ignored). */
function parseDotenv(text: string): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) entries.push({ key, value });
  }
  return entries;
}

/** Heuristic used when importing vars without an explicit secret flag. */
function looksSecret(key: string): boolean {
  return /secret|token|password|key|credential|api_key/i.test(key);
}

function handleConfigError(err: unknown, reply: { status: (code: number) => any }) {
  if (err instanceof ConfigError) {
    return reply.status(400).send({ error: err.message });
  }
  return reply.status(400).send({ error: (err as Error).message });
}

/**
 * Builds the Fastify HTTP API + SSE log stream for Conductor.
 * Kept as a factory so it's easy to unit test with mocked dependencies.
 */
export async function buildApi(deps: ApiDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Any localhost origin is allowed since Conductor is a local dev tool;
  // the UI's dev port may shift (3000, 3001, ...) if it's already in use.
  await app.register(cors, {
    origin: /^https?:\/\/localhost(:\d+)?$/,
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  // --- Profiles & commands (read) ---------------------------------------

  app.get("/api/profiles", async () => {
    const config = deps.store.getConfig();
    const profiles = Object.fromEntries(
      Object.entries(config.profiles).map(([name, profile]) => [
        name,
        { description: profile.description, command_ids: profile.command_ids },
      ]),
    );
    return { profiles, commands: config.commands };
  });

  // --- Base path (where the target app is installed) --------------------

  app.get("/api/base-path", async () => {
    const config = deps.store.getConfig();
    return { base_path: config.base_path, resolved: deps.store.getResolvedBasePath() };
  });

  app.put<{ Body: { base_path: string } }>("/api/base-path", async (request, reply) => {
    const parsed = z.object({ base_path: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Invalid base_path" });
    }
    try {
      deps.store.setBasePath(parsed.data.base_path);
      deps.queries.insertAuditEntry("set-base-path", parsed.data.base_path);
      return { base_path: parsed.data.base_path, resolved: deps.store.getResolvedBasePath() };
    } catch (err) {
      return handleConfigError(err, reply);
    }
  });

  // --- Default shell (used for `shell: true` commands & healthchecks) ---

  app.get("/api/shells", async () => {
    return {
      available: listAvailableShells(),
      default_shell: deps.store.getDefaultShell() ?? null,
    };
  });

  app.put<{ Body: { default_shell: string | null } }>("/api/shells", async (request, reply) => {
    const parsed = z
      .object({ default_shell: z.string().min(1).nullable() })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Invalid default_shell" });
    }
    try {
      deps.store.setDefaultShell(parsed.data.default_shell ?? undefined);
      deps.queries.insertAuditEntry("set-default-shell", parsed.data.default_shell ?? "(default)");
      return { default_shell: deps.store.getDefaultShell() ?? null };
    } catch (err) {
      return handleConfigError(err, reply);
    }
  });

  // --- Config example compiler (.env.example -> .env, etc.) --------------

  const ConfigureInputSchema = z.object({
    profile: z.string().optional(),
    force: z.boolean().optional(),
  });

  app.post<{ Body: unknown }>("/api/configure", async (request, reply) => {
    const parsed = ConfigureInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
    }
    const { profile, force } = parsed.data;
    const report = deps.store.compileConfigExamples(profile, { force });
    deps.queries.insertAuditEntry(
      "compile-config",
      `${profile ?? "__global__"} (created ${report.created}, skipped ${report.skipped}, errors ${report.errors})`,
    );
    return report;
  });

  // --- Config import (whole .conductor.yml, e.g. a shared template) -----

  const ConfigImportSchema = z.object({
    yaml: z.string().min(1),
  });

  app.post<{ Body: unknown }>("/api/config/import", async (request, reply) => {
    const parsed = ConfigImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
    }
    let raw: unknown;
    try {
      raw = yaml.load(parsed.data.yaml);
    } catch (err) {
      return reply.status(400).send({ error: `Failed to parse YAML: ${(err as Error).message}` });
    }
    try {
      const config = deps.store.importConfig(raw);
      deps.queries.insertAuditEntry("import-config", config.name ?? "(unnamed)");
      return { config };
    } catch (err) {
      return handleConfigError(err, reply);
    }
  });

  // --- Config export (download .conductor.yml) ----------------------------

  app.get("/api/config/export", async () => {
    const config = deps.store.getConfig();
    const yamlText = yaml.dump(config, {
      indent: 2,
      lineWidth: 100,
      noRefs: true,
    });
    deps.queries.insertAuditEntry("export-config", config.name ?? "(unnamed)");
    return { yaml: yamlText };
  });

  // --- docker compose parsing and extraction --------------------------------

  const DockerComposeParseSchema = z.object({
    yaml: z.string().min(1),
  });

  app.post<{ Body: unknown }>("/api/docker compose/parse", async (request, reply) => {
    const parsed = DockerComposeParseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
    }

    try {
      const raw = yaml.load(parsed.data.yaml);
      const commands = parseDockerCompose(raw);
      deps.queries.insertAuditEntry("parse-docker compose", `${commands.length} service(s) found`);
      return { commands };
    } catch (err) {
      return reply.status(400).send({ error: `Failed to parse YAML: ${(err as Error).message}` });
    }
  });

  // --- Profiles & commands (write, persisted to .conductor.yml) ---------

  app.post<{ Body: { name: string; description?: string } }>(
    "/api/profiles",
    async (request, reply) => {
      try {
        const profile = deps.store.addProfile(request.body.name, {
          description: request.body.description,
        });
        deps.queries.insertAuditEntry("add-profile", request.body.name);
        return { profile, name: request.body.name };
      } catch (err) {
        return handleConfigError(err, reply);
      }
    },
  );

  app.delete<{ Params: { profile: string } }>("/api/profiles/:profile", async (request, reply) => {
    try {
      deps.store.removeProfile(request.params.profile);
      deps.queries.insertAuditEntry("remove-profile", request.params.profile);
      return { removed: true };
    } catch (err) {
      return handleConfigError(err, reply);
    }
  });

  // --- Profile rename ---
  app.put<{ Params: { profile: string }; Body: { newName: string } }>(
    "/api/profiles/:profile",
    async (request, reply) => {
      const oldName = request.params.profile;
      const { newName } = request.body;

      if (!newName || typeof newName !== "string" || !newName.trim()) {
        return reply.status(400).send({ error: "newName is required" });
      }

      try {
        const profile = deps.store.renameProfile(oldName, newName.trim());
        deps.queries.insertAuditEntry("rename-profile", `${oldName} → ${newName}`);
        return { profile, newName };
      } catch (err) {
        return handleConfigError(err, reply);
      }
    },
  );

  // --- Profile duplicate ---
  app.post<{ Params: { profile: string }; Body: { newName: string } }>(
    "/api/profiles/:profile/duplicate",
    async (request, reply) => {
      const sourceName = request.params.profile;
      const { newName } = request.body;

      if (!newName || typeof newName !== "string" || !newName.trim()) {
        return reply.status(400).send({ error: "newName is required" });
      }

      try {
        const profile = deps.store.duplicateProfile(sourceName, newName.trim());
        deps.queries.insertAuditEntry("duplicate-profile", `${sourceName} → ${newName}`);
        return { profile, newName };
      } catch (err) {
        return handleConfigError(err, reply);
      }
    },
  );

  // --- Profile export (download as .conductor.yml) ---
  app.get<{ Params: { profile: string } }>(
    "/api/profiles/:profile/export",
    async (request, reply) => {
      const config = deps.store.getConfig();
      const profile = config.profiles[request.params.profile];

      if (!profile) {
        return reply.status(404).send({ error: `Unknown profile "${request.params.profile}"` });
      }

      try {
        // Resolve commands for this profile
        const profileCommands = deps.store.getProfileCommands(request.params.profile);
        
        const exportConfig: ConductorConfig = {
          version: config.version,
          name: `${config.name}-${request.params.profile}`,
          keywords: [],
          tags: [],
          env_secrets: [],
          base_path: config.base_path,
          commands: profileCommands,
          profiles: {
            [request.params.profile]: profile,
          },
          global_env: {},
        };
        const yamlText = yaml.dump(exportConfig, {
          indent: 2,
          lineWidth: 100,
          noRefs: true,
        });
        deps.queries.insertAuditEntry("export-profile", `${request.params.profile}`);
        return { yaml: yamlText, profile: request.params.profile };
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { profile: string }; Body: unknown }>(
    "/api/profiles/:profile/commands",
    async (request, reply) => {
      const parsed = CommandInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: parsed.error.issues[0]?.message ?? "Invalid command" });
      }
      try {
        // Create command at root level
        const command = deps.store.addCommand(parsed.data);
        // Add reference to profile
        deps.store.addCommandToProfile(request.params.profile, command.id);
        deps.queries.insertAuditEntry("add-command", `${request.params.profile}/${command.id}`);
        return { command };
      } catch (err) {
        return handleConfigError(err, reply);
      }
    },
  );

  app.put<{ Params: { profile: string; id: string }; Body: unknown }>(
    "/api/profiles/:profile/commands/:id",
    async (request, reply) => {
      const parsed = CommandPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: parsed.error.issues[0]?.message ?? "Invalid command" });
      }
      try {
        const command = deps.store.updateCommand(request.params.id, parsed.data);
        deps.queries.insertAuditEntry(
          "update-command",
          `${request.params.profile}/${request.params.id}`,
        );
        return { command };
      } catch (err) {
        return handleConfigError(err, reply);
      }
    },
  );

  app.delete<{ Params: { profile: string; id: string } }>(
    "/api/profiles/:profile/commands/:id",
    async (request, reply) => {
      try {
        deps.store.removeCommandFromProfile(request.params.profile, request.params.id);
        deps.queries.insertAuditEntry(
          "remove-command",
          `${request.params.profile}/${request.params.id}`,
        );
        return { removed: true };
      } catch (err) {
        return handleConfigError(err, reply);
      }
    },
  );

  // --- Command duplicate ---------------------------------------------------

  app.post<{ Params: { profile: string; id: string }; Body: unknown }>(
    "/api/profiles/:profile/commands/:id/duplicate",
    async (request, reply) => {
      try {
        // Duplicate command at root level (creates new ID)
        const command = deps.store.duplicateCommand(request.params.id);
        // Optionally add to target profile if specified
        const body = z.object({ targetProfile: z.string().min(1).optional() }).safeParse(request.body);
        if (body.success && body.data.targetProfile) {
          deps.store.addCommandToProfile(body.data.targetProfile, command.id);
        }
        deps.queries.insertAuditEntry(
          "duplicate-command",
          `${request.params.id} -> ${command.id}`,
        );
        return { command };
      } catch (err) {
        return handleConfigError(err, reply);
      }
    },
  );

  // --- Command move --------------------------------------------------------

  app.post<{ Params: { profile: string; id: string }; Body: unknown }>(
    "/api/profiles/:profile/commands/:id/move",
    async (request, reply) => {
      const body = z.object({ targetProfile: z.string().min(1) }).safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ error: body.error.issues[0]?.message ?? "Invalid request" });
      }
      try {
        // Remove from source profile and add to target profile
        deps.store.removeCommandFromProfile(request.params.profile, request.params.id);
        deps.store.addCommandToProfile(body.data.targetProfile, request.params.id);
        const command = deps.store.getCommand(request.params.id);
        if (!command) {
          return reply.status(404).send({ error: `Command "${request.params.id}" not found` });
        }
        deps.queries.insertAuditEntry(
          "move-command",
          `${request.params.profile}/${request.params.id} -> ${body.data.targetProfile}`,
        );
        return { command };
      } catch (err) {
        return handleConfigError(err, reply);
      }
    },
  );

  // --- Processes (global queue) ------------------------------------------------

  app.get("/api/processes", async () => {
    const queue = deps.store.getQueue();
    const processes = queue.listSnapshots();
    return { processes };
  });

  app.post<{ Params: { id: string }; Body: { profile: string } }>(
    "/api/commands/:id/execute",
    async (request, reply) => {
      const { id } = request.params;
      const { profile } = request.body;

      // Verify the command exists and is referenced in the specified profile
      const config = deps.store.getConfig();
      const profileConfig = config.profiles[profile];
      if (!profileConfig) {
        return reply.status(404).send({ error: `Unknown profile "${profile}"` });
      }
      if (!profileConfig.command_ids.includes(id)) {
        return reply.status(404).send({ error: `Unknown command "${id}" in profile "${profile}"` });
      }

      const queue = deps.store.getQueue();
      try {
        await queue.startOne(id, deps.onLog);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }

      deps.queries.insertAuditEntry("execute", `${profile}/${id}`);
      return { started: true, commandId: id, profile };
    },
  );

  app.post<{ Params: { id: string }; Body: { profile: string } }>(
    "/api/commands/:id/restart",
    async (request, reply) => {
      const { id } = request.params;
      const { profile } = request.body;

      // Verify the command exists and is referenced in the specified profile
      const config = deps.store.getConfig();
      const profileConfig = config.profiles[profile];
      if (!profileConfig) {
        return reply.status(404).send({ error: `Unknown profile "${profile}"` });
      }
      if (!profileConfig.command_ids.includes(id)) {
        return reply.status(404).send({ error: `Unknown command "${id}" in profile "${profile}"` });
      }

      const queue = deps.store.getQueue();
      try {
        await queue.restartOne(id, deps.onLog);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }

      deps.queries.insertAuditEntry("restart", `${profile}/${id}`);
      const restarted = queue.getWrapper(id)?.getSnapshot();
      return { restarted: true, commandId: id, profile, process: restarted };
    },
  );

  app.post<{ Params: { profile: string } }>(
    "/api/profiles/:profile/run",
    async (request, reply) => {
      const { profile } = request.params;
      const config = deps.store.getConfig();
      const profileConfig = config.profiles[profile];
      if (!profileConfig) {
        return reply.status(404).send({ error: `Unknown profile "${profile}"` });
      }

      // Auto-compile any missing .env/appsettings.json from their
      // .example counterparts before starting commands, so a fresh
      // checkout works without a manual "configurations" step. Never
      // overwrites files that already exist.
      const configReport = deps.store.compileConfigExamples(profile);

      const queue = deps.store.getQueue();
      try {
        // Start commands in this profile (resolve from command_ids)
        for (const commandId of profileConfig.command_ids) {
          await queue.startOne(commandId, deps.onLog);
        }
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      deps.queries.insertAuditEntry("run-profile", profile);
      return { started: true, profile, configReport };
    },
  );

  app.post<{ Params: { profile: string } }>(
    "/api/profiles/:profile/stop",
    async (request, reply) => {
      const { profile } = request.params;
      const config = deps.store.getConfig();
      const profileConfig = config.profiles[profile];
      if (!profileConfig) {
        return reply.status(404).send({ error: `Unknown profile "${profile}"` });
      }

      const queue = deps.store.getQueue();
      // Stop only commands from this profile (resolve from command_ids)
      for (const commandId of profileConfig.command_ids) {
        const wrapper = queue.getWrapper(commandId);
        if (wrapper) {
          await wrapper.stop();
        }
      }
      deps.queries.insertAuditEntry("stop-profile", profile);
      return { stopped: true, profile };
    },
  );

  app.delete<{ Params: { pid: string } }>("/api/processes/:pid", async (request, reply) => {
    const pid = Number(request.params.pid);

    const queue = deps.store.getQueue();
    const stopped = await queue.stopByPid(pid);
    if (stopped) {
      deps.queries.insertAuditEntry("stop", String(pid));
      return { stopped: true, pid };
    }

    return reply.status(404).send({ error: `No running process with pid ${pid}` });
  });

  app.get<{ Params: { pid: string }; Querystring: { from?: string; to?: string } }>(
    "/api/processes/:pid/metrics",
    async (request) => {
      const pid = Number(request.params.pid);
      const { from, to } = request.query;
      return deps.queries.queryMetrics(pid, from, to);
    },
  );

  // --- Environment variables --------------------------------------------

  app.get<{ Querystring: { scope?: "global" | "profile"; profile?: string } }>(
    "/api/env",
    async (request) => {
      const { scope, profile } = request.query;
      if (scope) {
        return {
          vars: deps.queries.listEnvVars(scope, scope === "profile" ? (profile ?? null) : null),
        };
      }
      return { vars: deps.queries.listAllEnvVars() };
    },
  );

  app.put<{ Body: unknown }>("/api/env", async (request, reply) => {
    const parsed = EnvVarInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Invalid env var" });
    }
    const { scope, profile, key, value, secret } = parsed.data;
    if (scope === "profile" && !profile) {
      return reply.status(400).send({ error: "profile is required when scope is 'profile'" });
    }

    const row = deps.queries.upsertEnvVar({
      scope,
      profile: scope === "profile" ? (profile ?? null) : null,
      key,
      value,
      isSecret: secret ?? looksSecret(key),
    });
    deps.store.refreshEnv();
    deps.queries.insertAuditEntry("set-env", `${scope}${profile ? `/${profile}` : ""}/${key}`);
    return { var: row };
  });

  app.delete<{ Params: { id: string } }>("/api/env/:id", async (request) => {
    deps.queries.deleteEnvVar(Number(request.params.id));
    deps.store.refreshEnv();
    return { removed: true };
  });

  app.post<{ Body: unknown }>("/api/env/import", async (request, reply) => {
    const parsed = EnvImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid import" });
    }
    const { scope, profile, text, secret } = parsed.data;
    if (scope === "profile" && !profile) {
      return reply.status(400).send({ error: "profile is required when scope is 'profile'" });
    }

    const entries = parseDotenv(text);
    const imported = entries.map((entry) =>
      deps.queries.upsertEnvVar({
        scope,
        profile: scope === "profile" ? (profile ?? null) : null,
        key: entry.key,
        value: entry.value,
        isSecret: secret ?? looksSecret(entry.key),
      }),
    );
    deps.store.refreshEnv();
    deps.queries.insertAuditEntry(
      "import-env",
      `${scope}${profile ? `/${profile}` : ""} (${imported.length} vars)`,
    );
    return { imported: imported.length, vars: imported };
  });

  // --- Logs ---------------------------------------------------------------

  app.get<{
    Querystring: { pid?: string; commandId?: string; profile?: string; limit?: string };
  }>("/api/logs", async (request) => {
    const { pid, commandId, profile, limit } = request.query;
    const logs = deps.queries.queryLogs({
      processId: pid,
      commandId,
      profile,
      limit: limit ? Number(limit) : undefined,
    });
    return { logs: logs.reverse() };
  });

  // Server-Sent Events endpoint for real-time log streaming, scoped to a
  // single pid. Replays recent history first so a client that connects
  // mid-run still sees earlier output, then tails new lines live.
  app.get<{ Querystring: { pid?: string } }>("/api/logs/stream", (request, reply) => {
    const pid = request.query.pid ? Number(request.query.pid) : undefined;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    if (pid) {
      const history = deps.queries.queryLogs({ processId: String(pid), limit: 500 }).reverse();
      for (const row of history) {
        reply.raw.write(`event: log\ndata: ${JSON.stringify(row)}\n\n`);
      }
    }

    const unsubscribe = deps.broadcaster.subscribe((entry) => {
      if (pid && Number(entry.process_id) !== pid) return;
      reply.raw.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // If CONDUCTOR_UI_DIST points at a built UI bundle (set by the Electron
  // desktop shell, or anyone self-hosting the dashboard), serve it from
  // the same origin as the API - this lets a single process/port run the
  // whole app with no separate Vite server. Left unset (the default CLI
  // dev flow), this is a no-op and behavior is unchanged.
  const uiDist = process.env.CONDUCTOR_UI_DIST;
  if (uiDist && existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api")) {
        return reply.status(404).send({ error: "Not found" });
      }
      // SPA fallback: any non-API, non-asset route (e.g. a client-side
      // route) resolves to index.html so React Router/history can take over.
      return reply.sendFile("index.html", uiDist);
    });
  }

  return app;
}
