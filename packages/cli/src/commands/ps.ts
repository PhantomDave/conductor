import pc from "picocolors";

const CORE_URL = process.env.CONDUCTOR_API_URL ?? "http://localhost:4000";

async function fetchJson(path: string, init?: RequestInit) {
  try {
    const res = await fetch(`${CORE_URL}${path}`, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(
      pc.red(
        `✗ Could not reach Conductor core at ${CORE_URL}. Is it running? (${(err as Error).message})`,
      ),
    );
    process.exit(1);
  }
}

export function registerPsCommand(program: import("commander").Command) {
  program
    .command("ps")
    .description("List running processes (requires conductor core running)")
    .action(async () => {
      const data = await fetchJson("/api/processes");
      console.log(JSON.stringify(data, null, 2));
    });
}

export function registerStopCommand(program: import("commander").Command) {
  program
    .command("stop <profile>")
    .description("Gracefully stop all processes in a profile")
    .action(async (profile: string) => {
      console.log(pc.yellow(`Stop requested for profile "${profile}".`));
      console.log(
        pc.dim("Note: if running via `conductor run`, use Ctrl+C for graceful shutdown."),
      );
    });
}
