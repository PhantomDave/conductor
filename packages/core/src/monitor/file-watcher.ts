import { watch, type FSWatcher } from "node:fs";

/** Quiet window after the last matching change before the restart fires. */
const DEBOUNCE_MS = 500;

/**
 * Directories that are build output or tooling state, never source. Filtered
 * before glob matching so a service whose build writes under its own `src/**`
 * glob (tsc emit, generated .cs under obj/) can't restart itself forever.
 */
const SKIP_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "obj",
  "target",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "graphify-out",
]);

/** Lockfiles churn on every install and never mean "your code changed". */
const SKIP_FILES = new Set([
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "packages.lock.json",
]);

/** True when a path (relative to the watched cwd) should trigger a restart. */
export function watchMatches(relPath: string, patterns: string[]): boolean {
  const path = relPath.replaceAll("\\", "/"); // Windows fs.watch reports backslashes
  const segs = path.split("/");
  if (segs.some((seg) => SKIP_SEGMENTS.has(seg)) || SKIP_FILES.has(segs.at(-1)!)) return false;
  return patterns.some((p) => new Bun.Glob(p).match(path));
}

/**
 * Watches a command's `cwd` for changes matching its `watch` globs and calls
 * `onChange` once per burst, after DEBOUNCE_MS of quiet.
 */
export class FileWatcher {
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private lastPath = "";

  constructor(
    private readonly cwd: string,
    private readonly patterns: string[],
    /** Fired once per debounced burst with the last matching path. */
    private readonly onChange: (path: string) => void,
    private readonly debounceMs = DEBOUNCE_MS,
  ) {}

  /** Starts watching. Returns an error message instead of throwing (e.g. cwd missing). */
  start(): string | undefined {
    try {
      // ponytail: one recursive watch on all of cwd, node_modules included — can hit the
      // inotify watch ceiling on huge trees; watch only the globs' static prefixes if it does.
      this.watcher = watch(this.cwd, { recursive: true }, (_event, filename) => {
        if (filename) this.notify(filename.toString());
      });
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Feeds one changed path (relative to cwd) through the filter and debounce. */
  notify(relPath: string): void {
    if (!watchMatches(relPath, this.patterns)) return;
    this.lastPath = relPath;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onChange(this.lastPath), this.debounceMs);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
  }
}
