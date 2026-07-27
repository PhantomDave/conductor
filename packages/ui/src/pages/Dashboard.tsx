import { Stack, Title, Text } from "@mantine/core";
import { ProcessBoard } from "../components/ProcessBoard";
import { CommandLibrary } from "../components/CommandLibrary";
import { NotificationsTab } from "../components/NotificationsTab";

export function Dashboard() {
  return (
    <Stack gap="xl">
      <div>
        <Title order={2}>Processes</Title>
        <Text c="dimmed" size="sm">
          Live view of all running Conductor processes
        </Text>
        <ProcessBoard />
      </div>

      <div>
        <Title order={2}>Notifications</Title>
        <Text c="dimmed" size="sm">
          Process failures, blocked dependencies, and healthcheck issues
        </Text>
        <NotificationsTab />
      </div>

      <div>
        <Title order={2}>Command Library</Title>
        <Text c="dimmed" size="sm">
          Run or stop commands from any profile
        </Text>
        <CommandLibrary />
      </div>
    </Stack>
  );
}
