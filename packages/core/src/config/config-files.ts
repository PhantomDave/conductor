import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandConfig, ConfigFileConfig } from "./schema";
import { interpolateString, looksSecret, MASK } from "../env/masker";
import { exampleTemplateVars, referencedVars } from "./example-compiler";
import {
  buildCommandEnv,
  declaredEnvKeys,
  resolveCommandCwd,
  sharedEnvKeys,
  type BuildEnvParams,
} from "./env-resolution";

export interface ConfigFileChange {
  key: string;
  action: "add" | "change";
  /** Current value (masked when the key looks secret); absent for "add". */
  from?: string;
  to: string;
}

/** What converging one declared `.env` file would do (or did). */
export interface ConfigFilePlan {
  commandId: string;
  /** Absolute path of the file. */
  path: string;
  exists: boolean;
  changes: ConfigFileChange[];
  /** `${VAR}`s in `set:` values with no value - their keys were left alone. */
  missingVars: string[];
  /** Auto keys not written because Conductor's value is empty and the file's isn't. */
  skipped: string[];
  /** Keys in an `auto` file that Conductor doesn't provide (kept as they are). */
  unmatchedKeys: string[];
  /** Env keys this file consumes: auto matches plus `${VAR}`s in `set:`. */
  usedKeys: string[];
  error?: string;
}

export interface ConfigFileContext {
  /** The command's fully resolved env. */
  env: Record<string, string>;
  /** Keys declared in Conductor (not just inherited from the shell) - see `declaredEnvKeys`. */
  declaredKeys: Set<string>;
  /** The command's resolved working directory; file paths are relative to it. */
  cwd: string;
  /** `env_secrets` from the config; values of these keys are masked in plans. */
  secretKeys?: string[];
}

// `KEY=value`, optionally `export KEY = value`. Group 1 is everything up to the
// value so a rewrite keeps the original spacing and `export`.
const LINE_RE = /^(\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*)(.*)$/;
const BARE_VALUE_RE = /^[\w.\-/:@,+]*$/;

/** Splits a raw value into its dotenv meaning and whatever trails it (a quote's tail, a `# comment`). */
function parseValue(raw: string): { value: string; suffix: string } {
  const quote = raw[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    for (let i = 1; i < raw.length; i++) {
      if (quote === '"' && raw[i] === "\\") {
        i++;
        continue;
      }
      if (raw[i] !== quote) continue;
      const inner = raw.slice(1, i);
      const value =
        quote === '"'
          ? inner.replace(/\\(.)/g, (_m, c: string) =>
              c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
            )
          : inner;
      return { value, suffix: raw.slice(i + 1) };
    }
  }
  const comment = raw.search(/(^|\s)#/);
  const value = (comment === -1 ? raw : raw.slice(0, comment)).trimEnd();
  return { value, suffix: raw.slice(value.length) };
}

/** Bare when safe, single quotes (literal in every dotenv flavour) otherwise, escaped double quotes as a last resort. */
function formatValue(value: string): string {
  if (BARE_VALUE_RE.test(value)) return value;
  if (!value.includes("'") && !/[\r\n]/.test(value)) return `'${value}'`;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

function evaluateFile(
  commandId: string,
  file: ConfigFileConfig,
  ctx: ConfigFileContext,
): { plan: ConfigFilePlan; next?: string } {
  const secretSet = new Set((ctx.secretKeys ?? []).map((k) => k.toLowerCase()));
  const mask = (key: string, value: string) =>
    looksSecret(key) || secretSet.has(key.toLowerCase()) ? MASK : value;

  const path = resolve(ctx.cwd, interpolateString(file.path, ctx.env));
  const plan: ConfigFilePlan = {
    commandId,
    path,
    exists: existsSync(path),
    changes: [],
    missingVars: [],
    skipped: [],
    unmatchedKeys: [],
    usedKeys: [],
  };
  const used = new Set<string>();
  const missing = new Set<string>();

  // Desired values from `set:`. A key whose value references an unknown
  // var is left alone rather than blanked - this runs on every start, and
  // one missing DB var must not wipe a working value out of the file.
  const desired = new Map<string, string>();
  for (const [key, raw] of Object.entries(file.set)) {
    const refs = referencedVars(raw);
    for (const ref of refs) used.add(ref);
    const unresolved = refs.filter((r) => ctx.env[r] === undefined);
    if (unresolved.length > 0) {
      for (const ref of unresolved) missing.add(ref);
      continue;
    }
    desired.set(key, interpolateString(raw, ctx.env));
  }
  plan.missingVars = [...missing];

  let content = "";
  if (plan.exists) {
    try {
      content = readFileSync(path, "utf-8");
    } catch (err) {
      plan.error = (err as Error).message;
      plan.usedKeys = [...used];
      return { plan };
    }
  }

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content === "" ? [] : content.split(/\r?\n/);
  const trailingNewline = content === "" || lines.at(-1) === "";
  if (lines.at(-1) === "") lines.pop();

  const changes = new Map<string, ConfigFileChange>();
  const seen = new Set<string>();
  const skipped = new Set<string>();
  const unmatched = new Set<string>();

  lines.forEach((line, i) => {
    const match = LINE_RE.exec(line);
    if (!match) return;
    const [, prefix, key, rawValue] = match;
    const current = parseValue(rawValue);
    seen.add(key);

    let target = desired.get(key);
    if (target === undefined && file.auto) {
      const value = ctx.env[key];
      if (!ctx.declaredKeys.has(key) || value === undefined) {
        unmatched.add(key);
        return;
      }
      used.add(key);
      if (value === "" && current.value !== "") {
        skipped.add(key);
        return;
      }
      target = value;
    }
    if (target === undefined || target === current.value) return;

    lines[i] = prefix + formatValue(target) + current.suffix;
    if (!changes.has(key)) {
      changes.set(key, {
        key,
        action: "change",
        from: mask(key, current.value),
        to: mask(key, target),
      });
    }
  });

  for (const [key, value] of desired) {
    if (seen.has(key)) continue;
    lines.push(`${key}=${formatValue(value)}`);
    changes.set(key, { key, action: "add", to: mask(key, value) });
  }

  plan.changes = [...changes.values()];
  plan.skipped = [...skipped];
  plan.unmatchedKeys = [...unmatched];
  plan.usedKeys = [...used];
  if (plan.changes.length === 0) return { plan };
  return { plan, next: lines.join(eol) + (trailingNewline ? eol : "") };
}

/** Dry run: what converging `cmd.config_files` would change, without writing. */
export function planConfigFiles(cmd: CommandConfig, ctx: ConfigFileContext): ConfigFilePlan[] {
  return cmd.config_files.map((file) => evaluateFile(cmd.id, file, ctx).plan);
}

/**
 * Converges `cmd.config_files`: rewrites only the keys that differ,
 * leaves every other line (comments, order, line endings) as it was, and
 * doesn't touch a file that's already up to date. Sync on purpose -
 * commands start concurrently and may share a file, so each
 * read-modify-write must not interleave with another.
 */
export function applyConfigFiles(cmd: CommandConfig, ctx: ConfigFileContext): ConfigFilePlan[] {
  return cmd.config_files.map((file) => {
    const { plan, next } = evaluateFile(cmd.id, file, ctx);
    if (next === undefined) return plan;
    try {
      writeFileSync(plan.path, next, "utf-8");
    } catch (err) {
      plan.error = (err as Error).message;
    }
    return plan;
  });
}

export interface ConfigUsageLint {
  /** Shared env keys that no config file or template consumes. */
  unusedEnv: Array<{ key: string; suggestion?: string }>;
  /** Keys in `auto` files that Conductor doesn't provide. */
  unmatchedFileKeys: Array<{ path: string; key: string; suggestion?: string }>;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Closest candidate within a typo's reach (case-insensitive; 1 edit for short keys, 2 otherwise). */
export function suggestKey(key: string, candidates: Iterable<string>): string | undefined {
  const lower = key.toLowerCase();
  const maxDistance = lower.length < 6 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    if (candidate === key) continue;
    const distance = levenshtein(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Cross-checks the shared env against what config files actually use, to
 * surface typos: a shared key nothing reads, a file key Conductor doesn't
 * provide, and the likely intended name for each.
 */
export function lintConfigUsage(
  shared: Set<string>,
  plans: ConfigFilePlan[],
  templateVars: string[],
): ConfigUsageLint {
  if (plans.length === 0 && templateVars.length === 0) {
    return { unusedEnv: [], unmatchedFileKeys: [] };
  }
  const used = new Set([...templateVars, ...plans.flatMap((p) => p.usedKeys)]);
  const unknownNames = new Set(
    [...templateVars, ...plans.flatMap((p) => [...p.usedKeys, ...p.unmatchedKeys])].filter(
      (name) => !shared.has(name),
    ),
  );
  return {
    unusedEnv: [...shared]
      .filter((key) => !used.has(key))
      .sort()
      .map((key) => ({ key, suggestion: suggestKey(key, unknownNames) })),
    // Two commands may declare the same file; report each of its keys once.
    unmatchedFileKeys: [
      ...new Map(
        plans.flatMap((p) =>
          p.unmatchedKeys.map((key) => [
            `${p.path}\0${key}`,
            { path: p.path, key, suggestion: suggestKey(key, shared) },
          ]),
        ),
      ).values(),
    ],
  };
}

export interface ConfigFilesReport {
  /** Absolute `base_path`, for displaying file paths relative to it. */
  basePath: string;
  configFiles: ConfigFilePlan[];
  lint: ConfigUsageLint;
}

/**
 * Plans (or applies) every command's `config_files` for one env scope and
 * lints the result - the shared entry point for `conductor configure` and
 * `POST /api/configure`, so both report exactly what a start would do.
 */
export function configureConfigFiles(
  params: BuildEnvParams,
  commands: CommandConfig[],
  opts: {
    apply: boolean;
    basePath: string;
    /** Per-command env scope, when it isn't `params` - e.g. each command's own profile, as a start resolves it. */
    envFor?: (cmd: CommandConfig) => BuildEnvParams;
  },
): ConfigFilesReport {
  const configFiles = commands.flatMap((cmd) => {
    const cmdParams = { ...(opts.envFor?.(cmd) ?? params), cmd };
    const env = buildCommandEnv(cmdParams);
    const ctx: ConfigFileContext = {
      env,
      declaredKeys: declaredEnvKeys(cmdParams),
      cwd: resolveCommandCwd(cmd.cwd, env),
      secretKeys: params.config.env_secrets,
    };
    return opts.apply ? applyConfigFiles(cmd, ctx) : planConfigFiles(cmd, ctx);
  });
  return {
    basePath: opts.basePath,
    configFiles,
    lint: lintConfigUsage(sharedEnvKeys(params), configFiles, exampleTemplateVars(opts.basePath)),
  };
}
