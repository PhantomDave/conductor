import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { interpolateString } from "../env/masker";

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

/** `${VAR}` references present in `content` that `env` has no value for. */
function findMissingVars(content: string, env: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const match of content.matchAll(/\$\{([A-Z0-9_]+)\}/gi)) {
    const name = match[1];
    if (env[name] === undefined) missing.add(name);
  }
  return [...missing];
}

export interface CompileResult {
  examplePath: string;
  targetPath: string;
  action: "created" | "skipped-exists" | "error";
  /** `${VAR}` tokens in this file that had no matching env value (left as empty string). */
  missingVars: string[];
  error?: string;
}

export interface CompileReport {
  basePath: string;
  results: CompileResult[];
  created: number;
  skipped: number;
  errors: number;
  /** Deduped union of `missingVars` across every file that was (or would be) created. */
  missingVars: string[];
}

/**
 * Compiles a single example file: copies it to its target path with
 * `${VAR}` tokens resolved against `env`. Leaves the target untouched if
 * it already exists, unless `force` is set - so re-running this is always
 * safe and won't clobber a developer's local edits.
 */
export function compileExampleFile(
  match: ExampleFileMatch,
  env: Record<string, string>,
  force = false,
): CompileResult {
  const { examplePath, targetPath } = match;

  if (!force && existsSync(targetPath)) {
    return { examplePath, targetPath, action: "skipped-exists", missingVars: [] };
  }

  try {
    const raw = readFileSync(examplePath, "utf-8");
    const missingVars = findMissingVars(raw, env);
    writeFileSync(targetPath, interpolateString(raw, env), "utf-8");
    return { examplePath, targetPath, action: "created", missingVars };
  } catch (err) {
    return {
      examplePath,
      targetPath,
      action: "error",
      missingVars: [],
      error: (err as Error).message,
    };
  }
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
  opts: { force?: boolean } = {},
): CompileReport {
  const results = findExampleFiles(basePath).map((match) =>
    compileExampleFile(match, env, opts.force ?? false),
  );

  return {
    basePath,
    results,
    created: results.filter((r) => r.action === "created").length,
    skipped: results.filter((r) => r.action === "skipped-exists").length,
    errors: results.filter((r) => r.action === "error").length,
    missingVars: [...new Set(results.flatMap((r) => r.missingVars))].sort(),
  };
}
