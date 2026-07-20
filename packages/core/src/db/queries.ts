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
  constructor(private readonly db: Database) {}

  insertLog(row: Omit<LogRow, "id">): LogRow {
    return this.db
      .prepare(
        `INSERT INTO logs (process_id, command_id, profile, timestamp, level, stream, message)
         VALUES ($process_id, $command_id, $profile, $timestamp, $level, $stream, $message)
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
}
