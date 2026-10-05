import { existsSync } from "node:fs";
import type { ApiDependencies } from "../api";
import { forgetRecent, readRecent, recordRecent, type RecentWorkspace } from "./recent";
import {
  openSession,
  prepareSession,
  resolveWorkspaceDir,
  type SessionOptions,
  type WorkspaceSession,
} from "./session";

export class WorkspaceBusyError extends Error {
  constructor() {
    super("workspace switch in progress");
  }
}

/**
 * Owns the one active WorkspaceSession and swaps it at runtime: validates
 * the new folder's config first, stops the old session, then installs the
 * new one into the API deps. While a switch runs, `switching` is true and
 * any concurrent open/close throws WorkspaceBusyError.
 */
export class WorkspaceManager {
  #current: WorkspaceSession | null = null;
  #switching = false;

  constructor(
    private readonly opts: { dataDir: string; deps: ApiDependencies; session: SessionOptions },
  ) {}

  get current(): WorkspaceSession | null {
    return this.#current;
  }

  get switching(): boolean {
    return this.#switching;
  }

  async open(input: string): Promise<WorkspaceSession> {
    if (this.#switching) throw new WorkspaceBusyError();
    this.#switching = true;
    try {
      const dir = resolveWorkspaceDir(input);
      if (this.#current?.dir === dir) return this.#current;
      prepareSession(dir); // throws on a bad config before anything is stopped

      const old = this.#current;
      this.#current = null;
      await old?.close();

      const session = openSession(dir, this.opts.session);
      const { store, queries, logger, onLog } = session;
      Object.assign(this.opts.deps, { store, queries, logger, onLog });
      this.#current = session;
      recordRecent(this.opts.dataDir, { path: dir, name: session.name });
      return session;
    } finally {
      this.#switching = false;
    }
  }

  async close(): Promise<void> {
    if (this.#switching) throw new WorkspaceBusyError();
    this.#switching = true;
    try {
      const old = this.#current;
      this.#current = null;
      await old?.close();
    } finally {
      this.#switching = false;
    }
  }

  list(): {
    current: { path: string; name: string } | null;
    recent: (RecentWorkspace & { missing: boolean })[];
  } {
    const current = this.#current;
    return {
      current: current ? { path: current.dir, name: current.name } : null,
      recent: readRecent(this.opts.dataDir).map((entry) => ({
        ...entry,
        // workspaces.json is hand-editable; a malformed entry reads as missing.
        missing: typeof entry.path !== "string" || !existsSync(entry.path),
      })),
    };
  }

  forget(path: string): void {
    forgetRecent(this.opts.dataDir, path);
  }
}
