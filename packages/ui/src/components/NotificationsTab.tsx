import { Table, Badge, Text, Card, Button, Group, Stack, Tooltip } from "@mantine/core";
import { useNotifications } from "../hooks/useNotifications";
import { useUiStore } from "../store/ui";

const NOTIFICATION_TYPE_COLOR: Record<string, string> = {
  failed_start: "red",
  dependency_failed: "orange",
  healthcheck_failed: "yellow",
};

const NOTIFICATION_TYPE_LABEL: Record<string, string> = {
  failed_start: "Failed Start",
  dependency_failed: "Blocked Dependency",
  healthcheck_failed: "Healthcheck Failed",
};

export function NotificationsTab() {
  const { data, isLoading, error } = useNotifications();
  const { selectProcess } = useUiStore();

  if (isLoading) return <Text c="dimmed">Loading notifications...</Text>;
  if (error) {
    return <Text c="red">Could not reach Conductor core API. Is `bun run dev:core` running?</Text>;
  }

  const notifications = data?.notifications || [];

  if (notifications.length === 0) {
    return (
      <Card withBorder padding="lg">
        <Stack align="center" gap="sm">
          <Text c="dimmed">No failures recorded</Text>
          <Text size="sm" c="dimmed">
            When processes fail to start or dependencies block, they'll appear here
          </Text>
        </Stack>
      </Card>
    );
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text fw={500}>
          {notifications.length} failure{notifications.length === 1 ? "" : "s"}
        </Text>
      </Group>

      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Time</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Command</Table.Th>
            <Table.Th>Profile</Table.Th>
            <Table.Th>Reason</Table.Th>
            <Table.Th>Blocked Commands</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {notifications.map((notif) => {
            const time = new Date(notif.timestamp);
            const timeStr = time.toLocaleTimeString();
            const blockedStr =
              notif.affectedDownstream.length > 0 ? notif.affectedDownstream.join(", ") : "-";

            return (
              <Table.Tr key={notif.id}>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {timeStr}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge color={NOTIFICATION_TYPE_COLOR[notif.type] ?? "gray"}>
                    {NOTIFICATION_TYPE_LABEL[notif.type] ?? notif.type}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{notif.commandName ?? notif.commandId}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{notif.profile}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{notif.reason}</Text>
                  {notif.exitCode !== undefined && (
                    <Text size="xs" c="dimmed">
                      Exit code: {notif.exitCode}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{blockedStr}</Text>
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    <Tooltip label="View logs">
                      <Button
                        size="xs"
                        variant="subtle"
                        onClick={() => {
                          // Open the log viewer for this command
                          selectProcess({
                            profile: notif.profile,
                            commandId: notif.commandId,
                          });
                        }}
                      >
                        Logs
                      </Button>
                    </Tooltip>
                  </Group>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
