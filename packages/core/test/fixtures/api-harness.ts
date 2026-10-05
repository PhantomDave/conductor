// Boots the real core API through the same WorkspaceManager as
// bin/server.ts, against a temp copy of sample.conductor.yml and an
// in-memory DB. Shared by the CLI and UI test suites so both are exercised
// against actual routes rather than mocks.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApi, LogBroadcaster, WorkspaceManager, type ApiDependencies } from "../../src";

export async function startCore() {
  const dir = mkdtempSync(join(tmpdir(), "conductor-test-"));
  const configPath = join(dir, ".conductor.yml");
  copyFileSync(join(import.meta.dir, "sample.conductor.yml"), configPath);

  const broadcaster = new LogBroadcaster();
  // ponytail: deps fields are unset until a workspace opens; the onRequest guard keeps handlers from running before that
  const deps = { broadcaster } as ApiDependencies;
  const workspaces = new WorkspaceManager({
    // Inside the temp dir so stop()'s one rmSync also clears workspaces.json.
    dataDir: join(dir, ".conductor", "data"),
    deps,
    session: { broadcaster, dbPath: ":memory:", logLevel: "silent" },
  });
  deps.workspaces = workspaces;
  await workspaces.open(dir);

  const app = await buildApi(deps);
  const url = await app.listen({ port: 0, host: "127.0.0.1" });

  return {
    url,
    dir,
    configPath,
    async stop() {
      await workspaces.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
