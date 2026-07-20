import { EventEmitter } from "node:events";
import type { LogRow } from "../db/queries";

/**
 * Tiny in-process pub/sub so multiple SSE clients can subscribe to the
 * same live log stream without polling SQLite. Publishes the same
 * LogRow shape used for history so clients get a single consistent
 * schema regardless of whether an entry came from history replay or
 * a live tail.
 */
export class LogBroadcaster {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many SSE clients may subscribe concurrently; avoid Node's default
    // 10-listener warning for a perfectly normal usage pattern.
    this.emitter.setMaxListeners(0);
  }

  publish(entry: LogRow): void {
    this.emitter.emit("log", entry);
  }

  subscribe(handler: (entry: LogRow) => void): () => void {
    this.emitter.on("log", handler);
    return () => this.emitter.off("log", handler);
  }
}
