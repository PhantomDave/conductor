import pc from "picocolors";

export function registerLogsCommand(program: import("commander").Command) {
  program
    .command("logs")
    .description("Query or follow logs")
    .option("--follow", "Follow logs in real-time")
    .option("--grep <pattern>", "Filter logs containing pattern")
    .option("--level <level>", "Filter by log level (debug|info|warn|error)")
    .action((opts: { follow?: boolean; grep?: string; level?: string }) => {
      console.log(pc.dim("Log querying against SQLite is implemented in @conductor/core."));
      console.log(
        pc.dim(
          `Filters received: follow=${!!opts.follow} grep=${opts.grep ?? "-"} level=${opts.level ?? "-"}`,
        ),
      );
      console.log(
        pc.yellow(
          "TODO: wire this command to ConductorQueries.queryLogs() and the SSE stream for --follow.",
        ),
      );
    });
}
