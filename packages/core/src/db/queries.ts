import type { Database } from "bun:sqlite";

export interface LogRow {
  id: number;
  process_id: string;
  command_id: string;
  profile: string;
  timestamp: string;
  level: string;
  stream: "stdout" | "stderr";
  message: string;
  session_id: number | null;
}

/**
 * FTS5 query syntax treats `-`, `*`, `:`, `^`, `"`, and bare OR/NOT as
 * operators. Quoting the term (doubling internal quotes) makes it a literal
 * phrase match instead, so a grep term with those characters doesn't throw.
 */
function escapeFtsMatch(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

export interface ExecutionHistoryRow {
  command_id: string;
  profile: string;
  start_time: string;
  end_time?: string;
  exit_code?: number;
  duration_ms?: number;
}

export interface EnvVarRow {
  id: number;
  scope: "global" | "profile";
  profile: string | null;
  key: string;
  value: string;
  is_secret: number;
  updated_at: string;
}

/**
 * Thin prepared-statement wrapper around the Conductor SQLite database.
 * Keeps SQL centralized so callers don't hand-write queries.
 */
export class ConductorQueries {
  // Tracks the most recent session per profile so insertLog can stamp
  // session_id without every caller threading it through explicitly. A
  // profile with no entry here (no run yet this process, or a single
  // command execute/restart rather than a profile run) gets session_id NULL.
  private readonly currentSessionByProfile = new Map<string, number>();

  constructor(private readonly db: Database) {}

  insertSession(profile: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO sessions (profile, started_at) VALUES ($profile, $startedAt) RETURNING id`,
      )
      .get({ $profile: profile, $startedAt: new Date().toISOString() }) as { id: number };
    this.currentSessionByProfile.set(profile, row.id);
    return row.id;
  }

  insertLog(row: Omit<LogRow, "id" | "session_id">): LogRow {
    const sessionId = this.currentSessionByProfile.get(row.profile) ?? null;
    return this.db
      .prepare(
        `INSERT INTO logs (process_id, command_id, profile, timestamp, level, stream, message, session_id)
         VALUES ($process_id, $command_id, $profile, $timestamp, $level, $stream, $message, $session_id)
         RETURNING *`,
      )
      .get({
        $process_id: row.process_id,
        $command_id: row.command_id,
        $profile: row.profile,
        $timestamp: row.timestamp,
        $level: row.level,
        $stream: row.stream,
        $message: row.message,
        $session_id: sessionId,
      }) as LogRow;
  }

  queryLogs(filters: {
    commandId?: string;
    profile?: string;
    processId?: string;
    level?: string;
    grep?: string;
    limit?: number;
  }): LogRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.commandId) {
      clauses.push("command_id = $commandId");
      params.$commandId = filters.commandId;
    }
    if (filters.profile) {
      clauses.push("profile = $profile");
      params.$profile = filters.profile;
    }
    if (filters.processId) {
      clauses.push("process_id = $processId");
      params.$processId = filters.processId;
    }
    if (filters.level) {
      clauses.push("level = $level");
      params.$level = filters.level;
    }
    if (filters.grep) {
      clauses.push("message LIKE $grep");
      params.$grep = `%${filters.grep}%`;
      // FTS5 trigram index is a candidate-narrowing filter only (hence the
      // LIKE above still runs) - trigram tokenizer has no entries for terms
      // under 3 chars, so those fall back to a plain LIKE scan.
      if (filters.grep.length >= 3) {
        clauses.push("id IN (SELECT rowid FROM logs_fts WHERE logs_fts MATCH $ftsGrep)");
        params.$ftsGrep = escapeFtsMatch(filters.grep);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters.limit ?? 200;

    return this.db
      .prepare(`SELECT * FROM logs ${where} ORDER BY timestamp DESC LIMIT $limit`)
      .all({ ...params, $limit: limit }) as LogRow[];
  }

  insertExecutionHistory(row: ExecutionHistoryRow): void {
    this.db
      .prepare(
        `INSERT INTO execution_history (command_id, profile, start_time, end_time, exit_code, duration_ms)
         VALUES ($command_id, $profile, $start_time, $end_time, $exit_code, $duration_ms)`,
      )
      .run({
        $command_id: row.command_id,
        $profile: row.profile,
        $start_time: row.start_time,
        $end_time: row.end_time ?? null,
        $exit_code: row.exit_code ?? null,
        $duration_ms: row.duration_ms ?? null,
      });
  }

  insertAuditEntry(action: string, details?: string): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (timestamp, action, actor, details)
         VALUES ($timestamp, $action, 'local', $details)`,
      )
      .run({
        $timestamp: new Date().toISOString(),
        $action: action,
        $details: details ?? null,
      });
  }

  insertMetric(pid: number, cpuPercent: number, memoryBytes: number): void {
    this.db
      .prepare(
        `INSERT INTO process_metrics (pid, timestamp, cpu_percent, memory_bytes)
         VALUES ($pid, $timestamp, $cpu, $mem)`,
      )
      .run({
        $pid: pid,
        $timestamp: new Date().toISOString(),
        $cpu: cpuPercent,
        $mem: memoryBytes,
      });
  }

  queryMetrics(pid: number, from?: string, to?: string) {
    const clauses = ["pid = $pid"];
    const params: Record<string, string | number> = { $pid: pid };

    if (from) {
      clauses.push("timestamp >= $from");
      params.$from = from;
    }
    if (to) {
      clauses.push("timestamp <= $to");
      params.$to = to;
    }

    return this.db
      .prepare(
        `SELECT timestamp, cpu_percent, memory_bytes FROM process_metrics
         WHERE ${clauses.join(" AND ")} ORDER BY timestamp ASC`,
      )
      .all(params);
  }

  /**
   * Purges metric rows older than `cutoff`. Useful for retention cleanup.
   */
  deleteMetricBefore(cutoff: string): number {
    const result = this.db
      .prepare(`DELETE FROM process_metrics WHERE timestamp < $cutoff`)
      .run({ $cutoff: cutoff });
    return result.changes;
  }

  /**
   * Purges log rows older than `cutoff`, regardless of session. Mirrors
   * deleteMetricBefore's shape, but can't reuse `.run().changes` for the
   * count - the logs_fts AFTER DELETE trigger's writes to FTS5's internal
   * shadow tables are counted as additional "changes" by SQLite, inflating
   * the number well past the actual row count. Count first instead.
   */
  deleteLogsBefore(cutoff: string): number {
    const { count } = this.db
      .prepare(`SELECT COUNT(*) AS count FROM logs WHERE timestamp < $cutoff`)
      .get({ $cutoff: cutoff }) as { count: number };
    this.db.prepare(`DELETE FROM logs WHERE timestamp < $cutoff`).run({ $cutoff: cutoff });
    return count;
  }

  /**
   * Keeps only the most recent `retentionSessions` sessions (and their logs)
   * for a profile; deletes the rest from both `logs` and `sessions`. A
   * `retentionSessions` of 0 means the axis is disabled - no-op.
   */
  pruneOldSessions(profile: string, retentionSessions: number): number {
    if (retentionSessions <= 0) return 0;

    const keep = this.db
      .prepare(`SELECT id FROM sessions WHERE profile = $profile ORDER BY id DESC LIMIT $n`)
      .all({ $profile: profile, $n: retentionSessions }) as { id: number }[];
    if (keep.length === 0) return 0;

    const params: Record<string, string | number> = { $profile: profile };
    const placeholders = keep
      .map((row, i) => {
        params[`$k${i}`] = row.id;
        return `$k${i}`;
      })
      .join(", ");

    // Count first, not `.run().changes` - the logs_fts AFTER DELETE trigger's
    // writes to FTS5's shadow tables inflate that count (see deleteLogsBefore).
    const { count } = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM logs WHERE profile = $profile AND session_id IS NOT NULL AND session_id NOT IN (${placeholders})`,
      )
      .get(params) as { count: number };
    this.db
      .prepare(
        `DELETE FROM logs WHERE profile = $profile AND session_id IS NOT NULL AND session_id NOT IN (${placeholders})`,
      )
      .run(params);
    this.db
      .prepare(`DELETE FROM sessions WHERE profile = $profile AND id NOT IN (${placeholders})`)
      .run(params);

    return count;
  }

  /**
   * Lists env vars for a scope. Pass `profile: null` for the global scope.
   */
  listEnvVars(scope: "global" | "profile", profile: string | null = null): EnvVarRow[] {
    return this.db
      .prepare(
        `SELECT * FROM env_vars WHERE scope = $scope AND profile IS $profile ORDER BY key ASC`,
      )
      .all({ $scope: scope, $profile: profile }) as EnvVarRow[];
  }

  listAllEnvVars(): EnvVarRow[] {
    return this.db
      .prepare(`SELECT * FROM env_vars ORDER BY scope ASC, profile ASC, key ASC`)
      .all() as EnvVarRow[];
  }

  upsertEnvVar(input: {
    scope: "global" | "profile";
    profile: string | null;
    key: string;
    value: string;
    isSecret: boolean;
  }): EnvVarRow {
    this.db
      .prepare(
        `INSERT INTO env_vars (scope, profile, key, value, is_secret, updated_at)
         VALUES ($scope, $profile, $key, $value, $isSecret, $updatedAt)
         ON CONFLICT (scope, profile, key)
         DO UPDATE SET value = $value, is_secret = $isSecret, updated_at = $updatedAt`,
      )
      .run({
        $scope: input.scope,
        $profile: input.profile,
        $key: input.key,
        $value: input.value,
        $isSecret: input.isSecret ? 1 : 0,
        $updatedAt: new Date().toISOString(),
      });

    return this.db
      .prepare(`SELECT * FROM env_vars WHERE scope = $scope AND profile IS $profile AND key = $key`)
      .get({ $scope: input.scope, $profile: input.profile, $key: input.key }) as EnvVarRow;
  }

  deleteEnvVar(id: number): void {
    this.db.prepare(`DELETE FROM env_vars WHERE id = $id`).run({ $id: id });
  }

  getEnvVarById(id: number): EnvVarRow | null {
    return (this.db.prepare(`SELECT * FROM env_vars WHERE id = $id`).get({ $id: id }) ??
      null) as EnvVarRow | null;
  }
}
