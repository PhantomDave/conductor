import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConfigFiles,
  lintConfigUsage,
  planConfigFiles,
  type ConfigFileContext,
} from "../src/config/config-files";
import { CommandSchema, type CommandConfig } from "../src/config/schema";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conductor-config-files-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cmdWith(configFiles: unknown[]): CommandConfig {
  return CommandSchema.parse({ id: "web", name: "Web", run: "true", config_files: configFiles });
}

function ctx(env: Record<string, string>, declared = Object.keys(env)): ConfigFileContext {
  return { env, declaredKeys: new Set(declared), cwd: dir };
}

const envPath = () => join(dir, ".env");

describe("applyConfigFiles", () => {
  test("patches only differing keys and keeps comments, export, quotes and CRLF", () => {
    writeFileSync(
      envPath(),
      [
        "# api settings",
        "export API_URL=http://old # keep me",
        "NAME='Old Name'",
        "UNTOUCHED=1",
        "",
      ].join("\r\n"),
    );
    const [plan] = applyConfigFiles(
      cmdWith([".env"]),
      ctx({ API_URL: "http://new", NAME: "New Name", UNTOUCHED: "1" }),
    );

    expect(plan.changes.map((c) => c.key).sort()).toEqual(["API_URL", "NAME"]);
    expect(readFileSync(envPath(), "utf-8")).toBe(
      [
        "# api settings",
        "export API_URL=http://new # keep me",
        "NAME='New Name'",
        "UNTOUCHED=1",
        "",
      ].join("\r\n"),
    );
  });

  test("is idempotent: an up-to-date file gets no changes and no write", () => {
    writeFileSync(envPath(), 'A="x y"\nB=2 # note\n');
    const before = statSync(envPath()).mtimeMs;
    const [plan] = applyConfigFiles(cmdWith([".env"]), ctx({ A: "x y", B: "2" }));
    expect(plan.changes).toEqual([]);
    expect(statSync(envPath()).mtimeMs).toBe(before);
  });

  test("a set: value with a missing var leaves the key alone and reports it", () => {
    writeFileSync(envPath(), "API_URL=http://keep\n");
    const [plan] = applyConfigFiles(
      cmdWith([
        { path: ".env", auto: false, set: { API_URL: "http://${CONDUCTOR_TEST_UNSET}:1" } },
      ]),
      ctx({}),
    );
    expect(plan.missingVars).toEqual(["CONDUCTOR_TEST_UNSET"]);
    expect(plan.changes).toEqual([]);
    expect(readFileSync(envPath(), "utf-8")).toBe("API_URL=http://keep\n");
  });

  test("auto ignores keys that aren't declared in Conductor (e.g. only in process.env)", () => {
    writeFileSync(envPath(), "PORT=3000\n");
    const [plan] = applyConfigFiles(cmdWith([".env"]), ctx({ PORT: "9999" }, []));
    expect(plan.changes).toEqual([]);
    expect(plan.unmatchedKeys).toEqual(["PORT"]);
  });

  test("auto never adds keys and never blanks a value", () => {
    writeFileSync(envPath(), "A=1\n");
    const [plan] = applyConfigFiles(cmdWith([".env"]), ctx({ A: "", B: "2" }));
    expect(plan.changes).toEqual([]);
    expect(plan.skipped).toEqual(["A"]);
    expect(readFileSync(envPath(), "utf-8")).toBe("A=1\n");
  });

  test("creates the file from set: and masks secrets in the plan", () => {
    const [plan] = applyConfigFiles(
      cmdWith([{ path: ".env", set: { API_URL: "http://${HOST}", DB_PASSWORD: "hunter2" } }]),
      ctx({ HOST: "localhost" }),
    );
    expect(existsSync(envPath())).toBe(true);
    expect(readFileSync(envPath(), "utf-8")).toBe(
      "API_URL=http://localhost\nDB_PASSWORD=hunter2\n",
    );
    expect(plan.changes.find((c) => c.key === "DB_PASSWORD")?.to).toBe("********");
  });

  test("appended set: keys are found again on the next run", () => {
    const cmd = cmdWith([{ path: ".env", set: { "My.Key-1": "a b" } }]);
    expect(applyConfigFiles(cmd, ctx({}))[0].changes).toHaveLength(1);
    expect(applyConfigFiles(cmd, ctx({}))[0].changes).toEqual([]);
  });

  test("rejects set: keys a .env line can't hold", () => {
    expect(() => cmdWith([{ path: ".env", set: { "ConnectionStrings:Default": "x" } }])).toThrow();
  });

  test("a missing file with no set: is left missing", () => {
    const [plan] = applyConfigFiles(cmdWith([".env"]), ctx({ A: "1" }));
    expect(plan.exists).toBe(false);
    expect(existsSync(envPath())).toBe(false);
  });
});

describe("planConfigFiles", () => {
  test("reports the diff without writing", () => {
    writeFileSync(envPath(), "A=1\n");
    const [plan] = planConfigFiles(cmdWith([".env"]), ctx({ A: "2" }));
    expect(plan.changes).toEqual([{ key: "A", action: "change", from: "1", to: "2" }]);
    expect(readFileSync(envPath(), "utf-8")).toBe("A=1\n");
  });
});

describe("lintConfigUsage", () => {
  test("flags unused shared keys and file keys Conductor lacks, with typo suggestions", () => {
    writeFileSync(envPath(), "API_ULR=x\nLOCAL_ONLY=1\n");
    const plans = planConfigFiles(
      cmdWith([".env", { path: "other.env", auto: false, set: { DB: "${DB_HOST}" } }]),
      ctx({ API_URL: "y", DB_HOST: "h", TEMPLATE_VAR: "t", PATH: "/bin" }, [
        "API_URL",
        "DB_HOST",
        "TEMPLATE_VAR",
      ]),
    );
    const lint = lintConfigUsage(new Set(["API_URL", "DB_HOST", "TEMPLATE_VAR"]), plans, [
      "TEMPLATE_VAR",
    ]);

    // DB_HOST (set: ref) and TEMPLATE_VAR (template ref) count as used; PATH isn't shared.
    expect(lint.unusedEnv).toEqual([{ key: "API_URL", suggestion: "API_ULR" }]);
    expect(lint.unmatchedFileKeys).toEqual([
      { path: envPath(), key: "API_ULR", suggestion: "API_URL" },
      { path: envPath(), key: "LOCAL_ONLY", suggestion: undefined },
    ]);
  });

  test("stays quiet when there are no config files or templates", () => {
    expect(lintConfigUsage(new Set(["A"]), [], [])).toEqual({
      unusedEnv: [],
      unmatchedFileKeys: [],
    });
  });
});
