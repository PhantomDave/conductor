import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConductorQueries, openDatabase } from "../src";

/** Windows lets go of a just-closed SQLite file a moment later (EBUSY); retry like the workspace tests do. */
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 30 || (code !== "EBUSY" && code !== "EPERM")) throw err;
      await Bun.sleep(100);
    }
  }
}

describe("env var upsert", () => {
  test("editing a global var updates it in place and returns the new value", () => {
    const q = new ConductorQueries(openDatabase(":memory:"));
    q.upsertEnvVar({ scope: "global", profile: null, key: "FOO", value: "1", isSecret: false });
    const row = q.upsertEnvVar({
      scope: "global",
      profile: null,
      key: "FOO",
      value: "2",
      isSecret: false,
    });
    expect(row.value).toBe("2");
    expect(q.listEnvVars("global").map((r) => r.value)).toEqual(["2"]);
  });

  test("profile vars still upsert per profile", () => {
    const q = new ConductorQueries(openDatabase(":memory:"));
    for (const value of ["1", "2"]) {
      q.upsertEnvVar({ scope: "profile", profile: "dev", key: "FOO", value, isSecret: false });
    }
    q.upsertEnvVar({ scope: "profile", profile: "prod", key: "FOO", value: "p", isSecret: false });
    expect(q.listEnvVars("profile", "dev").map((r) => r.value)).toEqual(["2"]);
    expect(q.listEnvVars("profile", "prod").map((r) => r.value)).toEqual(["p"]);
  });

  test("opening a DB with duplicated global vars keeps only the newest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-env-"));
    const path = join(dir, "old.sqlite");
    try {
      const old = new Database(path, { create: true });
      old.exec(`CREATE TABLE env_vars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'profile')),
        profile TEXT, key TEXT NOT NULL, value TEXT NOT NULL,
        is_secret INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        UNIQUE (scope, profile, key))`);
      const insert = old.prepare(
        "INSERT INTO env_vars (scope, profile, key, value, updated_at) VALUES ('global', NULL, 'FOO', ?, 'x')",
      );
      insert.run("old");
      insert.run("new");
      old.close();

      const db = openDatabase(path);
      try {
        expect(new ConductorQueries(db).listEnvVars("global").map((r) => r.value)).toEqual(["new"]);
      } finally {
        db.close(); // Windows can't remove an open DB file
      }
    } finally {
      await removeDir(dir);
    }
  });
});
