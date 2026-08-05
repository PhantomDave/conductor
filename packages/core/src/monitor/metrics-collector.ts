import fs from "node:fs";
import type { ConductorQueries } from "../db/queries";

const PAGE_SIZE = 4096;

/** Recursively expand children of a process group leader into all descendant PID strings. */
function getGroupPids(leaderPid: number): string[] | null {
  try {
    // On Linux, direct children are at /proc/<pid>/task/<tid>/children (tid == pid for the main thread)
    const childFile = `/proc/${leaderPid}/task/${leaderPid}/children`;
    if (!fs.existsSync(childFile)) return null;
    const data = fs.readFileSync(childFile).toString().trim();
    if (!data) return null;

    const allPids = new Set<string>(data.split(/\s+/).filter(Boolean));

    // Recursively expand grandchildren from each child's children file
    for (const childId of data.split(/\s+/)) {
      if (!childId || isNaN(Number(childId))) continue;
      const gcFile = `/proc/${childId}/task/${childId}/children`;
      if (fs.existsSync(gcFile)) {
        const gc = fs.readFileSync(gcFile).toString().trim();
        if (gc) for (const g of gc.split(/\s+/).filter(Boolean)) allPids.add(g);
      }
    }

    return [...allPids];
  } catch {
    return null;
  }
}

function readCpuTicks(pid: number): number | null {
  try {
    const statData = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    // Parse by finding the last ')' — everything after is 17 fixed format fields from state to cstime.
    // We need utime (14th field, 0-indexed) and stime (15th field).
    const openParen = statData.indexOf("(");
    const closeParen = statData.lastIndexOf(")");
    if (openParen === -1 || closeParen === -1 || closeParen <= openParen) return null;

    // Fields after ')': state(0), ppid(1), ..., utime(13), stime(14)...
    const tail = statData.slice(closeParen + 2);
    if (!tail.trim()) return null;
    const fields = tail.split(/\s+/);
    if (fields.length < 15) return null; // need up to index 14

    return parseInt(fields[13], 10) + parseInt(fields[14], 10);
  } catch {
    return null;
  }
}

function readRssBytes(pid: number): number | null {
  try {
    // /proc/<pid>/statm field 2 = resident pages (1-indexed)
    const statmData = fs.readFileSync(`/proc/${pid}/statm`, "utf8").trim();
    const fields = statmData.split(/\s+/);
    if (fields.length < 2) return null;
    const rssPages = parseInt(fields[1], 10);
    return isNaN(rssPages) ? null : rssPages * PAGE_SIZE;
  } catch {
    return null;
  }
}

export interface MetricCollectorOptions {
  intervalMs?: number;
  retentionHours?: number;
}

/** A single process CPU/memory sample keyed by pid. */
/**
 * MetricCollector samples CPU & memory for a set of running PIDs on Linux.
 * Reads /proc for process-group totals (leader + all descendants) since commands
 * run via detached shells — the leader's group captures forked children too.
 */
export class MetricCollector {
  private intervalId?: ReturnType<typeof setInterval>;
  /** Track cumulative ticks per PID across ticks so we can compute deltas. */
  private lastClock = new Map<number, number>();

  constructor(
    private getRunningPids: () => Array<{ pid: number; cpuPercent?: number; memoryBytes?: number }>,
    private queries: ConductorQueries,
    private options: MetricCollectorOptions,
  ) {}

  start(): void {
    const intervalMs = this.options.intervalMs ?? 5000;
    if (intervalMs < 1000) return;

    this.intervalId = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        console.error("[MetricCollector] tick failed:", err);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private tick(): void {
    const items = this.getRunningPids();

    for (const item of items) {
      try {
        const children = getGroupPids(item.pid);

        // Always include the leader PID; add children when available
        const allPids = [String(item.pid), ...(children ?? [])];

        let cpuSum = 0;
        let memTotal = 0;

        for (const pId of allPids) {
          const pid = parseInt(pId, 10);
          if (isNaN(pid)) continue;

          // CPU via delta
          const nowTicks = readCpuTicks(pid);
          if (nowTicks !== null) {
            const last = this.lastClock.get(pid) ?? 0;
            if (last > 0) {
              const delta = nowTicks - last;
              // CPU via delta: /proc/<pid>/stat ticks are in USER_HZ (typically 100 ticks/s = 10ms/tick).
              // To convert to percent: (deltaTicks / USER_HZ) / (intervalMs / 1000) * 100
              // = deltaTicks * 1000 / intervalMs
              cpuSum += Math.min(
                Math.max((delta * 1000) / (this.options.intervalMs || 5000), 0),
                100,
              );
            }
            this.lastClock.set(pid, nowTicks);
          }

          // RSS
          const rss = readRssBytes(pid);
          if (rss !== null) memTotal += rss;
        }

        // Clamp
        cpuSum = Math.min(cpuSum, 100);

        this.queries.insertMetric(item.pid, cpuSum, memTotal);
      } catch {}
    }

    // Retention cleanup
    const retentionMs = (this.options.retentionHours ?? 24) * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    try {
      this.queries.deleteMetricBefore(cutoff);
    } catch {
      /* table may not exist yet or schema mismatch — harmless */
    }
  }
}
