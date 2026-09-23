// Black-box CLI tests: spawn the real binary (commands call process.exit and
// read CONDUCTOR_API_URL at import, so in-process testing isn't an option)
// against a real core instance and a temp .conductor.yml.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCore } from "../../core/test/fixtures/api-harness";

const BIN = join(import.meta.dir, "..", "bin", "conductor.ts");
let core: Awaited<ReturnType<typeof startCore>>;

async function cli(args: string[], opts: { cwd?: string; apiUrl?: string } = {}) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: opts.cwd ?? core.dir,
    env: { ...process.env, NO_COLOR: "1", CONDUCTOR_API_URL: opts.apiUrl ?? core.url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

beforeAll(async () => {
  core = await startCore();
});

afterAll(async () => {
  await core.stop();
});

describe("config validate", () => {
  test("valid config exits 0", async () => {
    const r = await cli(["config", "validate"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Schema valid");
  });

  test("invalid config exits 1", async () => {
    const bad = join(core.dir, "bad.yml");
    writeFileSync(bad, "version: '1'\ncommands: not-a-list\n");
    const r = await cli(["config", "validate", bad]);
    expect(r.code).toBe(1);
  });
});

describe("list", () => {
  test("lists profiles", async () => {
    const r = await cli(["list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dev");
    expect(r.stdout).toContain("broken");
  });

  test("lists a profile's commands with deps", async () => {
    const r = await cli(["list", "dev"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hello");
    expect(r.stdout).toContain("(deps: hello)");
  });

  test("unknown profile exits 1", async () => {
    const r = await cli(["list", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown profile "nope"');
  });
});

describe("env", () => {
  test("get falls back to the profile's env", async () => {
    const r = await cli(["env", "get", "dev", "FIXTURE_PROFILE"]);
    expect(r.stdout.trim()).toBe("dev-value");
  });

  test("set writes .env.<profile>.local and get reads it back", async () => {
    expect((await cli(["env", "set", "dev", "FIXTURE_PROFILE", "a=b"])).code).toBe(0);
    expect(readFileSync(join(core.dir, ".env.dev.local"), "utf-8")).toContain(
      "FIXTURE_PROFILE=a=b",
    );
    expect((await cli(["env", "get", "dev", "FIXTURE_PROFILE"])).stdout.trim()).toBe("a=b");
  });
});

// Asserts on conductor's own [startup] lines, not the children's stdout:
// `run` exits once startup finishes without draining short-lived children,
// and on Windows child stdout isn't captured at all yet — both tracked in TODO.md.
test("run starts every command in the profile", async () => {
  const r = await cli(["run", "dev"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('Starting profile "dev"');
  expect(r.stdout.match(/\[startup\] command started/g)).toHaveLength(2);
}, 30_000);

describe("core-backed commands", () => {
  test("ps prints process JSON", async () => {
    const r = await cli(["ps"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty("processes");
  });

  // Filters by --command, not --profile: core runs everything on one
  // "__global__" queue, so log rows carry profile="__global__" today.
  test("logs shows lines from a profile run through core", async () => {
    await fetch(`${core.url}/api/profiles/dev/run`, { method: "POST" });
    const fixtureLine = "[startup] command started";
    let r = await cli(["logs", "--command", "hello"]);
    for (let i = 0; i < 50 && !r.stdout.includes(fixtureLine); i++) {
      await Bun.sleep(100);
      r = await cli(["logs", "--command", "hello"]);
    }
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(":hello");
    expect(r.stdout).toContain(fixtureLine);

    const limited = await cli(["logs", "--command", "hello", "--limit", "1"]);
    expect(limited.stdout.trim().split("\n")).toHaveLength(1);
  }, 30_000);

  test("stop reports success", async () => {
    const r = await cli(["stop", "dev"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Stopped profile "dev"');
  });

  test("log-retention set / get / prune", async () => {
    expect((await cli(["log-retention", "set", "7", "3"])).code).toBe(0);
    const get = await cli(["log-retention", "get"]);
    expect(get.stdout).toMatch(/Days:\s+7/);
    expect(get.stdout).toMatch(/Sessions:\s+3/);
    expect((await cli(["log-retention", "prune"])).stdout).toContain("Pruned");
  });

  test("log-retention set rejects non-integers", async () => {
    const r = await cli(["log-retention", "set", "1.5", "x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("non-negative integers");
  });

  test("unreachable core exits 1 with a clear message", async () => {
    const r = await cli(["ps"], { apiUrl: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Could not reach Conductor core");
  });
});
