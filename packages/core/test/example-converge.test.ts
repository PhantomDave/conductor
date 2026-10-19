import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileConfigExamples, compileExampleFile } from "../src/config/example-compiler";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conductor-example-converge-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const converge = (keys: string[], secretKeys?: string[]) => ({
  declaredKeys: new Set(keys),
  secretKeys,
});

describe("compileExampleFile with converge", () => {
  test("rewrites the keys Conductor provides in a target that already exists", () => {
    const examplePath = join(dir, ".env.example");
    const targetPath = join(dir, ".env");
    writeFileSync(examplePath, "TOKEN=placeholder\n");
    writeFileSync(
      targetPath,
      "# keep me\nTOKEN=placeholder\nOTHER=untouched # note\nexport TOKEN2 = old\n",
    );

    const result = compileExampleFile(
      { examplePath, targetPath },
      { TOKEN: "real-token", TOKEN2: "two" },
      false,
      converge(["TOKEN", "TOKEN2"]),
    );

    expect(result.action).toBe("updated");
    expect(result.changedKeys.sort()).toEqual(["TOKEN", "TOKEN2"]);
    // Unknown keys, comments, order and `export`/spacing all survive.
    expect(readFileSync(targetPath, "utf-8")).toBe(
      "# keep me\nTOKEN=real-token\nOTHER=untouched # note\nexport TOKEN2 = two\n",
    );
  });

  test("fills a target just created from a template that has no ${VAR}", () => {
    const examplePath = join(dir, ".env.example");
    const targetPath = join(dir, ".env");
    writeFileSync(examplePath, "TOKEN=project-placeholder\nOTHER=\n");

    const result = compileExampleFile(
      { examplePath, targetPath },
      { TOKEN: "real-token" },
      false,
      converge(["TOKEN"]),
    );

    expect(result.action).toBe("created");
    expect(result.staticTemplate).toBe(true);
    expect(result.changedKeys).toEqual(["TOKEN"]);
    expect(readFileSync(targetPath, "utf-8")).toBe("TOKEN=real-token\nOTHER=\n");
  });

  test("leaves a key alone when Conductor's value is empty or the key isn't declared", () => {
    const examplePath = join(dir, ".env.example");
    const targetPath = join(dir, ".env");
    writeFileSync(examplePath, "TOKEN=x\n");
    writeFileSync(targetPath, "TOKEN=keep-me\nUNDECLARED=keep-me-too\n");

    const result = compileExampleFile(
      { examplePath, targetPath },
      { TOKEN: "", UNDECLARED: "ignored" },
      false,
      converge(["TOKEN"]),
    );

    expect(result.action).toBe("skipped-exists");
    expect(result.changedKeys).toEqual([]);
    expect(readFileSync(targetPath, "utf-8")).toBe("TOKEN=keep-me\nUNDECLARED=keep-me-too\n");
  });

  test("without converge an existing target is left exactly as it was", () => {
    const examplePath = join(dir, ".env.example");
    const targetPath = join(dir, ".env");
    writeFileSync(examplePath, "TOKEN=x\n");
    writeFileSync(targetPath, "TOKEN=old\n");

    const result = compileExampleFile({ examplePath, targetPath }, { TOKEN: "real-token" });

    expect(result.action).toBe("skipped-exists");
    expect(readFileSync(targetPath, "utf-8")).toBe("TOKEN=old\n");
  });
});

describe("compileConfigExamples with converge", () => {
  test("counts updated files and reports templates with no ${VAR}", () => {
    writeFileSync(join(dir, ".env.example"), "TOKEN=hardcoded\n");
    writeFileSync(join(dir, ".env"), "TOKEN=stale\n");
    writeFileSync(join(dir, "other.example.conf"), "TOKEN=${TOKEN}\n");
    writeFileSync(join(dir, "static.example.ini"), "TOKEN=hardcoded\n");

    const report = compileConfigExamples(
      dir,
      { TOKEN: "real-token" },
      { converge: converge(["TOKEN"]) },
    );

    expect(report.updated).toBe(1);
    expect(report.created).toBe(2);
    expect(report.errors).toBe(0);
    // Only the file created from a template with no ${VAR} is flagged.
    expect(report.staticTemplates).toEqual([join(dir, "static.ini")]);
    expect(readFileSync(join(dir, ".env"), "utf-8")).toBe("TOKEN=real-token\n");
    expect(readFileSync(join(dir, "other.conf"), "utf-8")).toBe("TOKEN=real-token\n");
  });
});
