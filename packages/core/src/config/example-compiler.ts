import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { interpolateString } from "../env/masker";
import { applyAutoKeys } from "./config-files";

/**
 * Directories that are never descended into while scanning for example
 * files - dependency/build/VCS output that's both huge and never contains
 * real config templates, so skipping it keeps the scan fast even on big
 * checkouts.
 */
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "bin",
  "obj",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".idea",
  ".vs",
  ".vscode",
]);

/**
 * Matches Conductor's example-file convention: `<name>.example<.ext>`
 * templates `<name><.ext>`, e.g.:
 *   .env.example                        -> .env
 *   appsettings.example.json            -> appsettings.json
 *   appsettings.Development.example.json -> appsettings.Development.json
 */
const EXAMPLE_FILE_RE = /^(.+)\.example(\.[^./]+)?$/i;

export interface ExampleFileMatch {
  examplePath: string;
  targetPath: string;
}

function exampleTargetName(filename: string): string | null {
  const match = filename.match(EXAMPLE_FILE_RE);
  if (!match) return null;
  return `${match[1]}${match[2] ?? ""}`;
}

/**
 * Recursively finds example config files under `basePath` and pairs each
 * with the real file it templates. Unreadable directories (permissions,
 * broken symlinks) are skipped rather than throwing, since a scan across
 * an entire project checkout will often hit at least one.
 */
export function findExampleFiles(basePath: string, maxDepth = 12): ExampleFileMatch[] {
  const matches: ExampleFileMatch[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        // A linked git worktree has a `.git` *file*, not a directory: it's a
        // separate checkout with its own config, so don't write into it from
        // this one (nested worktrees under `.claude/worktrees/` etc).
        if (statSync(join(full, ".git"), { throwIfNoEntry: false })?.isFile()) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const targetName = exampleTargetName(entry.name);
      if (targetName) {
        matches.push({ examplePath: full, targetPath: join(dir, targetName) });
      }
    }
  };

  walk(basePath, 0);
  return matches;
}

/** Distinct `${VAR}` names referenced in `content`. */
export function referencedVars(content: string): string[] {
  return [...new Set(Array.from(content.matchAll(/\$\{([A-Z0-9_]+)\}/gi), (m) => m[1]))];
}

/** `${VAR}` references present in `content` that `env` has no value for. */
export function findMissingVars(content: string, env: Record<string, string>): string[] {
  return referencedVars(content).filter((name) => env[name] === undefined);
}

/** Every `${VAR}` referenced by any example template under `basePath`. */
export function exampleTemplateVars(basePath: string): string[] {
  return findExampleFiles(basePath).flatMap(({ examplePath }) => {
    try {
      return referencedVars(readFileSync(examplePath, "utf-8"));
    } catch {
      return [];
    }
  });
}

export interface CompileResult {
  examplePath: string;
  targetPath: string;
  /** `updated`: the target already existed and Conductor rewrote some of its keys. */
  action: "created" | "updated" | "skipped-exists" | "error";
  /** `${VAR}` tokens in this file that had no matching env value (left as empty string). */
  missingVars: string[];
  /** Keys Conductor rewrote in the target (only when `converge` is on). */
  changedKeys: string[];
  /** The example has no `${VAR}` at all - it's the project's own template, not a Conductor one. */
  staticTemplate: boolean;
  error?: string;
}

export interface ConvergeOptions {
  /** Keys declared in Conductor - the only ones it may rewrite (see `declaredEnvKeys`). */
  declaredKeys: Set<string>;
  /** `env_secrets` from the config; values of these keys are masked in reports. */
  secretKeys?: string[];
}

export interface CompileReport {
  basePath: string;
  results: CompileResult[];
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  /** Targets created from a template with no `${VAR}`: whatever the project hardcoded in it. */
  staticTemplates: string[];
  /** Deduped union of `missingVars` across every file that was (or would be) created. */
  missingVars: string[];
}

/**
 * Compiles a single example file: copies it to its target path with
 * `${VAR}` tokens resolved against `env`. An existing target is not
 * overwritten unless `force` is set; with `converge` it is still updated
 * key by key, since Conductor's env has the last word on the keys it
 * declares - every other line (unknown keys, comments, order) is kept.
 */
export function compileExampleFile(
  match: ExampleFileMatch,
  env: Record<string, string>,
  force = false,
  converge?: ConvergeOptions,
): CompileResult {
  const { examplePath, targetPath } = match;
  const base = { examplePath, targetPath, changedKeys: [], staticTemplate: false };

  let result: CompileResult;
  if (!force && existsSync(targetPath)) {
    result = { ...base, action: "skipped-exists", missingVars: [] };
  } else {
    try {
      const raw = readFileSync(examplePath, "utf-8");
      result = {
        ...base,
        action: "created",
        missingVars: findMissingVars(raw, env),
        staticTemplate: referencedVars(raw).length === 0,
      };
      writeFileSync(targetPath, interpolateString(raw, env), "utf-8");
    } catch (err) {
      return { ...base, action: "error", missingVars: [], error: (err as Error).message };
    }
  }

  // Conductor has the last word on every key it provides: a target that
  // already existed (or one just copied from a template with hardcoded
  // placeholders) is converged too, so its values match the env store.
  if (!converge) return result;
  const plan = applyAutoKeys(targetPath, {
    env,
    declaredKeys: converge.declaredKeys,
    cwd: dirname(targetPath),
    secretKeys: converge.secretKeys,
  });
  if (plan.error) return { ...result, action: "error", error: plan.error };
  if (plan.changes.length === 0) return result;
  return {
    ...result,
    action: result.action === "created" ? "created" : "updated",
    changedKeys: plan.changes.map((c) => c.key),
  };
}

/**
 * Scans `basePath` for every `*.example*` config file and compiles it,
 * so a whole project's `.env`/`appsettings.json` files (present and any
 * added by new services later) get filled in automatically from
 * Conductor's env store, with no per-service config step needed in
 * `.conductor.yml`.
 */
export function compileConfigExamples(
  basePath: string,
  env: Record<string, string>,
  opts: { force?: boolean; converge?: ConvergeOptions } = {},
): CompileReport {
  const results = findExampleFiles(basePath).map((match) =>
    compileExampleFile(match, env, opts.force ?? false, opts.converge),
  );

  return {
    basePath,
    results,
    created: results.filter((r) => r.action === "created").length,
    updated: results.filter((r) => r.action === "updated").length,
    skipped: results.filter((r) => r.action === "skipped-exists").length,
    errors: results.filter((r) => r.action === "error").length,
    staticTemplates: results.filter((r) => r.staticTemplate).map((r) => r.targetPath),
    missingVars: [...new Set(results.flatMap((r) => r.missingVars))].sort(),
  };
}
