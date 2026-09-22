import pc from "picocolors";

const CORE_URL = process.env.CONDUCTOR_API_URL ?? "http://localhost:4000";

async function apiCall<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const res = await fetch(`${CORE_URL}${path}`, init);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(
      pc.red(`✗ Could not reach Conductor core at ${CORE_URL}. Is core running? (${(err as Error).message})`),
    );
    process.exit(1);
  }
}

export function registerLogRetentionCommand(program: import("commander").Command) {
  const retention = program.command("log-retention").description("Configure log retention");

  retention
    .command("get")
    .description("Show current log retention settings")
    .action(async () => {
      const config = await apiCall<{ log_retention_days: number; log_retention_sessions: number }>(
        "/api/log-retention",
      );
      console.log(`Days:    ${config.log_retention_days} ${config.log_retention_days === 0 ? pc.dim("(disabled)") : ""}`);
      console.log(
        `Sessions: ${config.log_retention_sessions} ${config.log_retention_sessions === 0 ? pc.dim("(disabled)") : ""}`,
      );
    });

  retention
    .command("set <days> <sessions>")
    .description("Set log retention (0 disables that axis)")
    .action(async (daysArg: string, sessionsArg: string) => {
      const days = Number(daysArg);
      const sessions = Number(sessionsArg);
      if (!Number.isInteger(days) || days < 0 || !Number.isInteger(sessions) || sessions < 0) {
        console.error(pc.red("✗ days and sessions must be non-negative integers"));
        process.exit(1);
      }
      await apiCall("/api/log-retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ log_retention_days: days, log_retention_sessions: sessions }),
      });
      console.log(pc.green(`✓ Log retention set: days=${days} sessions=${sessions}`));
    });

  retention
    .command("prune")
    .description("Run log retention sweeps immediately")
    .action(async () => {
      const result = await apiCall<{ logs_deleted: number; sessions_pruned_logs: number }>("/api/logs/prune", {
        method: "POST",
      });
      console.log(
        pc.green(
          `✓ Pruned ${result.logs_deleted} log(s) by age, ${result.sessions_pruned_logs} log(s) by session limit`,
        ),
      );
    });
}
