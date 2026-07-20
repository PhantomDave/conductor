import { describe, expect, test } from "bun:test";
import { validateConfig, ConfigError } from "../src/config/loader";

describe("validateConfig", () => {
  test("accepts a minimal valid config", () => {
    const config = validateConfig({
      version: "1",
      profiles: {
        dev: {
          commands: [
            {
              id: "hello",
              name: "Hello",
              run: "echo hi",
            },
          ],
        },
      },
    });

    expect(config.profiles.dev.commands[0]?.id).toBe("hello");
    expect(config.profiles.dev.commands[0]?.shell).toBe(true);
  });

  test("rejects config missing required fields", () => {
    expect(() => validateConfig({ profiles: { dev: { commands: [{}] } } })).toThrow(ConfigError);
  });
});
