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
 * any concurrent open/close rejects with WorkspaceBusyError; idle() waits it out.
 */
export class WorkspaceManager {
  #current: WorkspaceSession | null = null;
  #switching = false;
  /** The open/close in flight (or the last one), settled - for idle(). */
  #pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly opts: { dataDir: string; deps: ApiDependencies; session: SessionOptions },
  ) {}

  get current(): WorkspaceSession | null {
    return this.#current;
  }

  get switching(): boolean {
    return this.#switching;
  }

  /** Resolves once any open/close in flight has finished; its error is ignored. */
  async idle(): Promise<void> {
    await this.#pending;
  }

  open(input: string): Promise<WorkspaceSession> {
    return this.#exclusive(async () => {
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
      try {
        recordRecent(this.opts.dataDir, { path: dir, name: session.name });
      } catch (err) {
        // The switch itself worked; a stale recent list isn't worth failing it.
        logger.error({ err }, "Failed to record the recent workspace");
      }
      return session;
    });
  }

  close(): Promise<void> {
    return this.#exclusive(async () => {
      const old = this.#current;
      this.#current = null;
      await old?.close();
    });
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.#switching) return Promise.reject(new WorkspaceBusyError());
    this.#switching = true;
    const result = run().finally(() => {
      this.#switching = false;
    });
    this.#pending = result.catch(() => {});
    return result;
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
        missing: !existsSync(entry.path),
      })),
    };
  }

  forget(path: string): void {
    forgetRecent(this.opts.dataDir, path);
  }
}
