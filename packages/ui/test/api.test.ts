// Contract tests: the UI's real API client against a real core instance.
// A route rename or response-shape change in core fails here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startCore } from "../../core/test/fixtures/api-harness";
import * as api from "../src/lib/api";

let core: Awaited<ReturnType<typeof startCore>>;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  core = await startCore();
  // api.ts uses relative "/api/..." URLs (served same-origin in the browser).
  globalThis.fetch = ((input: string, init?: RequestInit) =>
    realFetch(core.url + input, init)) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await core.stop();
});

describe("profiles", () => {
  test("fetchProfiles resolves command_ids to full commands", async () => {
    const profiles = await api.fetchProfiles();
    expect(profiles.dev?.command_ids).toEqual(["hello", "world"]);
    expect(profiles.dev?.commands.map((c) => c.id)).toEqual(["hello", "world"]);
    expect(profiles.dev?.commands[1]?.deps).toEqual(["hello"]);
  });

  test("create, rename, delete round-trip", async () => {
    await api.createProfile("staging", "pre-prod");
    expect((await api.fetchProfiles()).staging?.description).toBe("pre-prod");

    await api.renameProfile("staging", "qa");
    const renamed = await api.fetchProfiles();
    expect(renamed.staging).toBeUndefined();
    expect(renamed.qa).toBeDefined();

    await api.deleteProfile("qa");
    expect((await api.fetchProfiles()).qa).toBeUndefined();
  });

  test("errors surface the server's message, not a generic fallback", async () => {
    const err = await api.createProfile("dev").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toBe('Failed to create profile "dev"');
    expect((err as Error).message).toContain("dev");
  });
});

describe("command library", () => {
  test("create → list → sync into profile → delete", async () => {
    const created = await api.createStandaloneCommand({ name: "Lint", run: "bun -e 1" });
    expect(created.id).toBeTruthy();

    const all = await api.fetchAllCommands();
    expect(Array.isArray(all)).toBe(true);
    expect(all.map((c) => c.id)).toContain(created.id);

    await api.syncCommandsToProfile("dev", { [created.id]: true }, all, new Set());
    expect((await api.fetchProfiles()).dev?.command_ids).toContain(created.id);

    await api.deleteStandaloneCommand(created.id);
    expect((await api.fetchAllCommands()).map((c) => c.id)).not.toContain(created.id);
    expect((await api.fetchProfiles()).dev?.command_ids).not.toContain(created.id);
  });
});

describe("env vars", () => {
  test("upsert, list, delete", async () => {
    const row = await api.upsertEnvVar({ scope: "profile", profile: "dev", key: "K", value: "v" });
    expect(row.key).toBe("K");
    expect((await api.fetchEnvVars("profile", "dev")).map((r) => r.key)).toContain("K");

    await api.deleteEnvVar(row.id);
    expect((await api.fetchEnvVars("profile", "dev")).map((r) => r.key)).not.toContain("K");
  });
});

describe("log retention", () => {
  test("update, read back, prune", async () => {
    await api.updateLogRetention({ log_retention_days: 7, log_retention_sessions: 3 });
    expect(await api.fetchLogRetention()).toEqual({
      log_retention_days: 7,
      log_retention_sessions: 3,
    });

    const pruned = await api.pruneLogsNow();
    expect(typeof pruned.logs_deleted).toBe("number");
    expect(typeof pruned.sessions_pruned_logs).toBe("number");
  });

  test("fetchLogs returns an array", async () => {
    expect(Array.isArray(await api.fetchLogs({ profile: "dev", limit: 5 }))).toBe(true);
  });
});

describe("config import/export", () => {
  test("export → import round-trips profiles", async () => {
    const yamlText = await api.exportConfig();
    expect(yamlText).toContain("hello");

    const imported = await api.importConfig(yamlText);
    expect(Object.keys(imported.profiles)).toEqual(expect.arrayContaining(["dev", "broken"]));
  });

  test("parseDockerCompose suggests one command per service", async () => {
    const commands = await api.parseDockerCompose(
      "services:\n  db:\n    image: postgres\n    ports: ['5432:5432']\n",
    );
    expect(commands.map((c) => c.id)).toContain("db");
  });
});

test("fetchProcesses returns an array", async () => {
  expect(Array.isArray(await api.fetchProcesses())).toBe(true);
});
