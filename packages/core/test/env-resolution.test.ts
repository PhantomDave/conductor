import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { resolveBasePath, buildCommandEnv } from "../src/config/env-resolution";
import { validateConfig } from "../src/config/loader";

// Use a path under the actual cwd rather than a hardcoded POSIX absolute
// path so these assertions hold on Windows too, where `path.resolve`
// resolves rooted-but-driveless paths (e.g. "/home/dave") against the
// current drive instead of returning them unchanged.
const configFilePath = resolve("fixtures", "project", ".conductor.yml");

describe("resolveBasePath", () => {
  test("resolves a relative base_path against the config file's directory", () => {
    expect(resolveBasePath(configFilePath, ".")).toBe(dirname(configFilePath));
    expect(resolveBasePath(configFilePath, "../app")).toBe(
      resolve(dirname(configFilePath), "../app"),
    );
  });

  test("passes through an already-absolute base_path unchanged", () => {
    const absoluteBasePath = resolve("opt", "app");
    expect(resolveBasePath(configFilePath, absoluteBasePath)).toBe(absoluteBasePath);
  });
});

describe("buildCommandEnv", () => {
  const config = validateConfig({
    version: "1",
    base_path: "../app",
    global_env: { GREETING: "hi ${BASE_PATH}" },
    profiles: {
      dev: {
        env: { PROFILE_VAR: "1" },
        commands: [{ id: "c", name: "C", run: "echo hi", cwd: "." }],
      },
    },
  });

  test("injects a resolved absolute BASE_PATH and lets other layers reference it", () => {
    const env = buildCommandEnv({
      configFilePath,
      config,
      profile: config.profiles.dev,
      cmd: config.profiles.dev.commands[0]!,
    });

    const expectedBasePath = resolve(dirname(configFilePath), "../app");
    expect(env.BASE_PATH).toBe(expectedBasePath);
    expect(env.GREETING).toBe(`hi ${expectedBasePath}`);
    expect(env.PROFILE_VAR).toBe("1");
  });

  test("keeps process.env as the base layer so PATH/HOME survive", () => {
    const env = buildCommandEnv({
      configFilePath,
      config,
      profile: config.profiles.dev,
      cmd: config.profiles.dev.commands[0]!,
    });

    // Env var name casing for PATH/HOME-equivalents is platform-dependent
    // (e.g. Windows exposes "Path"/"USERPROFILE" rather than "PATH"/"HOME"),
    // so look up whichever key process.env actually has instead of
    // hardcoding the POSIX names.
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH");
    expect(pathKey).toBeDefined();
    expect(env[pathKey!]).toBe(process.env[pathKey!]);
  });
});
