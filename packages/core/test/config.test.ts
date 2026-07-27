import { describe, expect, test } from "bun:test";
import { validateConfig, ConfigError } from "../src";

describe("validateConfig", () => {
  test("accepts a minimal valid config", () => {
    const config = validateConfig({
      version: "1",
      commands: [
        {
          id: "hello",
          name: "Hello",
          run: "echo hi",
        },
      ],
      profiles: {
        dev: {
          command_ids: ["hello"],
        },
      },
    });

    expect(config.commands[0]?.id).toBe("hello");
    expect(config.commands[0]?.shell).toBe(true);
  });

  test("rejects config missing required fields", () => {
    expect(() => validateConfig({ commands: [{}], profiles: { dev: { command_ids: [] } } })).toThrow(ConfigError);
  });
});
