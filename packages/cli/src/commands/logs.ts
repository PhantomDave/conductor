import pc from "picocolors";

const CORE_URL = process.env.CONDUCTOR_API_URL ?? "http://localhost:4000";

type LogEntry = {
  id: number;
  process_id: string;
  command_id: string;
  profile: string;
  timestamp: string;
  level: string;
  stream: "stdout" | "stderr";
  message: string;
};

function renderLog(entry: LogEntry) {
  const ts = entry.timestamp;
  const prefix = `${pc.dim(ts)} ${pc.cyan(entry.profile)}:${pc.bold(entry.command_id)} ${pc.dim(`#${entry.process_id}`)}`;
  const stream = entry.stream === "stderr" ? pc.red("stderr") : pc.dim("stdout");
  const level =
    entry.level === "error"
      ? pc.red(entry.level)
      : entry.level === "warn"
        ? pc.yellow(entry.level)
        : pc.dim(entry.level);
  console.log(`${prefix} ${stream} ${level} ${entry.message}`);
}

async function fetchLogs(params: URLSearchParams): Promise<LogEntry[]> {
  try {
    const res = await fetch(`${CORE_URL}/api/logs?${params.toString()}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    const data = (await res.json()) as { logs?: LogEntry[] };
    return data.logs ?? [];
  } catch (err) {
    console.error(
      pc.red(
        `✗ Could not query Conductor logs at ${CORE_URL}. Is core running? (${(err as Error).message})`,
      ),
    );
    process.exit(1);
  }
}

export function registerLogsCommand(program: import("commander").Command) {
  program
    .command("logs")
    .description("Query or follow logs from Conductor core")
    .option("--follow", "Follow logs in real-time")
    .option("--grep <pattern>", "Filter logs containing pattern")
    .option("--level <level>", "Filter by log level (debug|info|warn|error)")
    .option("--pid <pid>", "Filter by process id")
    .option("--command <commandId>", "Filter by command id")
    .option("--profile <profile>", "Filter by profile name")
    .option("--limit <n>", "Max log lines to fetch (default: 200)")
    .action(
      async (opts: {
        follow?: boolean;
        grep?: string;
        level?: string;
        pid?: string;
        command?: string;
        profile?: string;
        limit?: string;
      }) => {
        const params = new URLSearchParams();
        if (opts.grep) params.set("grep", opts.grep);
        if (opts.level) params.set("level", opts.level);
        if (opts.pid) params.set("pid", opts.pid);
        if (opts.command) params.set("commandId", opts.command);
        if (opts.profile) params.set("profile", opts.profile);
        if (opts.limit) params.set("limit", opts.limit);

        const rows = await fetchLogs(params);
        for (const row of rows) renderLog(row);

        if (!opts.follow) return;

        // The global EventSource constructor's argument count varies depending
        // on which of the workspace's several @types/node / bun-types versions
        // ends up resolved for this file, so type it explicitly here rather
        // than fight that ambient overload resolution - Bun provides a real
        // EventSource at runtime regardless of which types package "wins".
        const EventSourceCtor = EventSource as unknown as new (url: string) => {
          addEventListener(type: "log", listener: (event: MessageEvent) => void): void;
          onerror: (() => void) | null;
          close(): void;
        };
        const source = new EventSourceCtor(`${CORE_URL}/api/logs/stream?${params.toString()}`);

        source.addEventListener("log", (event) => {
          try {
            renderLog(JSON.parse((event as MessageEvent).data) as LogEntry);
          } catch {
            // Ignore malformed events and continue stream.
          }
        });

        source.onerror = () => {
          console.error(pc.red("✗ Log stream disconnected."));
          source.close();
          process.exit(1);
        };

        const shutdown = () => {
          source.close();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);

        await new Promise<void>(() => {
          // Keep process alive while following logs.
        });
      },
    );
}
