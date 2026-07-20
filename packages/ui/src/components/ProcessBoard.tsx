import { Table, Badge, Text, Card, Button, Group } from "@mantine/core";
import { IconPlayerStop, IconRefresh } from "@tabler/icons-react";
import { useProcesses } from "../hooks/useProcesses";
import { useStopProcess, useRestartCommand } from "../hooks/useProcessActions";

const STATUS_COLOR: Record<string, string> = {
  running: "green",
  starting: "yellow",
  stopping: "orange",
  stopped: "gray",
  failed: "red",
};

export function ProcessBoard() {
  const { data: processes, isLoading, error } = useProcesses();
  const stopProcess = useStopProcess();
  const restartCommand = useRestartCommand();

  if (isLoading) return <Text c="dimmed">Loading processes...</Text>;
  if (error) {
    return <Text c="red">Could not reach Conductor core API. Is `bun run dev:core` running?</Text>;
  }

  if (!processes || processes.length === 0) {
    return (
      <Card withBorder padding="lg">
        <Text c="dimmed">
          No processes running. Start one with `conductor run &lt;profile&gt;` or from the command
          library below.
        </Text>
      </Card>
    );
  }

  return (
    <Table striped highlightOnHover>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Command</Table.Th>
          <Table.Th>Profile</Table.Th>
          <Table.Th>PID</Table.Th>
          <Table.Th>Status</Table.Th>
          <Table.Th>CPU %</Table.Th>
          <Table.Th>Memory</Table.Th>
          <Table.Th />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {processes.map((p) => {
          const isStoppable = p.status === "running" || p.status === "starting";
          return (
            <Table.Tr key={p.pid}>
              <Table.Td>{p.commandName ?? p.commandId}</Table.Td>
              <Table.Td>{p.profile}</Table.Td>
              <Table.Td>{p.pid}</Table.Td>
              <Table.Td>
                <Badge color={STATUS_COLOR[p.status] ?? "gray"}>{p.status}</Badge>
              </Table.Td>
              <Table.Td>{p.cpuPercent?.toFixed(1) ?? "-"}</Table.Td>
              <Table.Td>
                {p.memoryBytes ? `${(p.memoryBytes / 1024 / 1024).toFixed(0)} MB` : "-"}
              </Table.Td>
              <Table.Td>
                <Group gap="xs" wrap="nowrap">
                  <Button
                    size="xs"
                    variant="subtle"
                    leftSection={<IconRefresh size={14} />}
                    loading={
                      restartCommand.isPending &&
                      restartCommand.variables?.commandId === p.commandId &&
                      restartCommand.variables?.profile === p.profile
                    }
                    onClick={() =>
                      restartCommand.mutate({ profile: p.profile, commandId: p.commandId })
                    }
                  >
                    Restart
                  </Button>
                  <Button
                    size="xs"
                    color="red"
                    variant="subtle"
                    disabled={!isStoppable}
                    leftSection={<IconPlayerStop size={14} />}
                    loading={stopProcess.isPending && stopProcess.variables === p.pid}
                    onClick={() => stopProcess.mutate(p.pid)}
                  >
                    Stop
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
