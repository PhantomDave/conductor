import { describe, expect, test } from "bun:test";
import { maskSecrets, mergeEnv, interpolateEnv, interpolateString } from "../src/env/masker";

describe("maskSecrets", () => {
  test("masks matching keys case-insensitively", () => {
    const result = maskSecrets({ API_TOKEN: "secret123", NODE_ENV: "dev" }, ["api_token"]);
    expect(result.API_TOKEN).toBe("********");
    expect(result.NODE_ENV).toBe("dev");
  });
});

describe("mergeEnv", () => {
  test("later layers override earlier ones", () => {
    const result = mergeEnv({ A: "1", B: "2" }, { B: "3" }, undefined, { C: "4" });
    expect(result).toEqual({ A: "1", B: "3", C: "4" });
  });
});

describe("interpolateEnv", () => {
  test("resolves ${VAR} references from the same env map", () => {
    const result = interpolateEnv({ HOST: "localhost", URL: "http://${HOST}:3000" });
    expect(result.URL).toBe("http://localhost:3000");
  });
});

describe("interpolateString", () => {
  test("resolves ${VAR} references against the given env map (e.g. for cwd/healthcheck fields)", () => {
    const env = { APP_DIR: "../app" };
    expect(interpolateString("${APP_DIR}/backend/Api", env)).toBe(
      "../app/backend/Api",
    );
  });

  test("falls back to process.env for vars missing from the given map", () => {
    process.env.__MASKER_TEST_VAR__ = "from-process-env";
    expect(interpolateString("${__MASKER_TEST_VAR__}/x", {})).toBe("from-process-env/x");
    delete process.env.__MASKER_TEST_VAR__;
  });

  test("leaves unresolved vars as empty string, matching interpolateEnv behavior", () => {
    expect(interpolateString("${UNKNOWN_VAR}/x", {})).toBe("/x");
  });
});
