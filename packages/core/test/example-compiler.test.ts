import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  findExampleFiles,
  compileExampleFile,
  compileConfigExamples,
} from "../src/config/example-compiler";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conductor-example-compiler-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findExampleFiles", () => {
  test("pairs .env.example and appsettings.example.json with their targets", () => {
    mkdirSync(join(dir, "service-a"), { recursive: true });
    writeFileSync(join(dir, ".env.example"), "FOO=bar");
    writeFileSync(join(dir, "service-a", "appsettings.example.json"), "{}");
    writeFileSync(join(dir, "service-a", "appsettings.Development.example.json"), "{}");
    writeFileSync(join(dir, "service-a", "README.md"), "not an example");

    const matches = findExampleFiles(dir);
    const targets = matches.map((m) => relative(dir, m.targetPath).split("\\").join("/")).sort();

    expect(targets).toEqual([
      ".env",
      "service-a/appsettings.Development.json",
      "service-a/appsettings.json",
    ]);
  });

  test("skips ignored directories like node_modules and .git", () => {
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", ".env.example"), "SHOULD_NOT=match");
    writeFileSync(join(dir, ".env.example"), "FOO=bar");

    const matches = findExampleFiles(dir);
    expect(matches).toHaveLength(1);
    expect(matches[0].examplePath).toBe(join(dir, ".env.example"));
  });
});

describe("compileExampleFile", () => {
  test("interpolates ${VAR} tokens from env when creating the target", () => {
    const examplePath = join(dir, ".env.example");
    const targetPath = join(dir, ".env");
    writeFileSync(examplePath, "API_KEY=${API_KEY}\nSTATIC=unchanged\n");

    const result = compileExampleFile({ examplePath, targetPath }, { API_KEY: "secret-123" });

    expect(result.action).toBe("created");
    expect(result.missingVars).toEqual([]);
    expect(readFileSync(targetPath, "utf-8")).toBe("API_KEY=secret-123\nSTATIC=unchanged\n");
  });

  test("reports missing vars and leaves them blank instead of failing", () => {
    const examplePath = join(dir, ".env.example");
    const targetPath = join(dir, ".env");
    writeFileSync(examplePath, "TOKEN=${MISSING_TOKEN}\n");

    const result = compileExampleFile({ examplePath, targetPath }, {});

    expect(result.action).toBe("created");
    expect(result.missingVars).toEqual(["MISSING_TOKEN"]);
    expect(readFileSync(targetPath, "utf-8")).toBe("TOKEN=\n");
  });

  test("skips an existing target unless force is set", () => {
    const examplePath = join(dir, ".env.example");
    const targetPath = join(dir, ".env");
    writeFileSync(examplePath, "FOO=${FOO}\n");
    writeFileSync(targetPath, "FOO=already-here\n");

    const skipped = compileExampleFile({ examplePath, targetPath }, { FOO: "new" });
    expect(skipped.action).toBe("skipped-exists");
    expect(readFileSync(targetPath, "utf-8")).toBe("FOO=already-here\n");

    const forced = compileExampleFile({ examplePath, targetPath }, { FOO: "new" }, true);
    expect(forced.action).toBe("created");
    expect(readFileSync(targetPath, "utf-8")).toBe("FOO=new\n");
  });
});

describe("compileConfigExamples", () => {
  test("scans a whole tree and summarizes created/skipped/missing vars", () => {
    mkdirSync(join(dir, "backend"), { recursive: true });
    writeFileSync(join(dir, ".env.example"), "BASE_URL=${BASE_URL}\n");
    writeFileSync(join(dir, "backend", "appsettings.example.json"), '{"Token": "${API_TOKEN}"}');
    // Already exists - should be skipped.
    writeFileSync(join(dir, "backend", "appsettings.json"), '{"Token": "keep-me"}');

    const report = compileConfigExamples(dir, { BASE_URL: "http://localhost" });

    expect(report.created).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.errors).toBe(0);
    expect(report.missingVars).toEqual([]);
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(readFileSync(join(dir, "backend", "appsettings.json"), "utf-8")).toBe(
      '{"Token": "keep-me"}',
    );
  });
});
