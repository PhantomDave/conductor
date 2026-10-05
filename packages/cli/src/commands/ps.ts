import pc from "picocolors";

const CORE_URL = process.env.CONDUCTOR_API_URL ?? "http://localhost:4000";

async function fetchJson(path: string, init?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(`${CORE_URL}${path}`, init);
  } catch (err) {
    console.error(
      pc.red(
        `✗ Could not reach Conductor core at ${CORE_URL}. Is it running? (${(err as Error).message})`,
      ),
    );
    process.exit(1);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    console.error(
      pc.red(`✗ Conductor core at ${CORE_URL}: ${body?.error ?? `HTTP ${res.status}`}`),
    );
    process.exit(1);
  }
  return await res.json();
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

export function registerNotificationsCommand(program: import("commander").Command) {
  const notifications = program
    .command("notifications")
    .description("List recent notifications (requires conductor core running)")
    .action(async () => {
      const data = await fetchJson("/api/notifications");
      console.log(JSON.stringify(data, null, 2));
    });
  notifications
    .command("clear")
    .description("Clear the notification history")
    .action(async () => {
      await fetchJson("/api/notifications", { method: "DELETE" });
      console.log(pc.green("✓ Cleared notifications"));
    });
}

export function registerStopCommand(program: import("commander").Command) {
  program
    .command("stop <profile>")
    .description("Gracefully stop all processes in a profile")
    .action(async (profile: string) => {
      await fetchJson(`/api/profiles/${encodeURIComponent(profile)}/stop`, { method: "POST" });
      console.log(pc.green(`✓ Stopped profile "${profile}"`));
    });
}
