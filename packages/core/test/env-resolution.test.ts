import { describe, expect, test } from "bun:test";
import { resolveBasePath, buildCommandEnv } from "../src/config/env-resolution";
import { validateConfig } from "../src/config/loader";

describe("resolveBasePath", () => {
  test("resolves a relative base_path against the config file's directory", () => {
    expect(resolveBasePath("/home/dave/project/.conductor.yml", ".")).toBe("/home/dave/project");
    expect(resolveBasePath("/home/dave/project/.conductor.yml", "../app")).toBe("/home/dave/app");
  });

  test("passes through an already-absolute base_path unchanged", () => {
    expect(resolveBasePath("/home/dave/project/.conductor.yml", "/opt/app")).toBe("/opt/app");
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
      configFilePath: "/home/dave/project/.conductor.yml",
      config,
      profile: config.profiles.dev,
      cmd: config.profiles.dev.commands[0]!,
    });

    expect(env.BASE_PATH).toBe("/home/dave/app");
    expect(env.GREETING).toBe("hi /home/dave/app");
    expect(env.PROFILE_VAR).toBe("1");
  });

  test("keeps process.env as the base layer so PATH/HOME survive", () => {
    const env = buildCommandEnv({
      configFilePath: "/home/dave/project/.conductor.yml",
      config,
      profile: config.profiles.dev,
      cmd: config.profiles.dev.commands[0]!,
    });

    expect(env.PATH).toBe(process.env.PATH);
  });
});
