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

  test("rejects an unknown stop_signal instead of silently skipping the graceful stop", () => {
    const withSignal = (stop_signal: string) =>
      validateConfig({
        commands: [{ id: "a", name: "A", run: "true", stop_signal }],
        profiles: { dev: { command_ids: ["a"] } },
      });
    expect(() => withSignal("TERM")).toThrow(/stop_signal: Unknown signal/);
    expect(() => withSignal("SIGFOO")).toThrow(ConfigError);
    expect(withSignal("SIGINT").commands[0]?.stop_signal).toBe("SIGINT");
  });

  test("rejects config missing required fields", () => {
    expect(() =>
      validateConfig({ commands: [{}], profiles: { dev: { command_ids: [] } } }),
    ).toThrow(ConfigError);
  });
});
