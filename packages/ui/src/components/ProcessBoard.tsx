import { Table, Badge, Text, Card, Button, Group, Tabs } from "@mantine/core";
import { IconPlayerStop, IconRefresh, IconFileText } from "@tabler/icons-react";
import { useState } from "react";
import { useProcesses } from "../hooks/useProcesses";
import { useStopProcess, useRestartCommand } from "../hooks/useProcessActions";
import { useUiStore } from "../store/ui";

const STATUS_COLOR: Record<string, string> = {
  running: "green",
  starting: "yellow",
  stopping: "orange",
  stopped: "gray",
  failed: "red",
};

const HEALTH_COLOR: Record<string, string> = {
  healthy: "green",
  unhealthy: "red",
  unknown: "gray",
};

interface ProcessTableProps {
  processes: typeof useProcesses extends (...args: any[]) => infer R
    ? R extends { data: infer D }
      ? D
      : never
    : never;
  stopProcess: ReturnType<typeof useStopProcess>;
  restartCommand: ReturnType<typeof useRestartCommand>;
}

function ProcessTable({ processes, stopProcess, restartCommand }: ProcessTableProps) {
  const { selectProcess } = useUiStore();

  if (!processes || processes.length === 0) {
    return (
      <Card withBorder padding="lg">
        <Text c="dimmed">No processes to display</Text>
      </Card>
    );
  }

  return (
    <Table highlightOnHover>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Command</Table.Th>
          <Table.Th>Profile</Table.Th>
          <Table.Th>PID</Table.Th>
          <Table.Th>Status</Table.Th>
          <Table.Th>Health</Table.Th>
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
                <Group gap={6} wrap="nowrap">
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: `var(--mantine-color-${STATUS_COLOR[p.status] ?? "gray"}-5)`,
                    }}
                  />
                  <Text size="sm" c={STATUS_COLOR[p.status] ?? "gray"}>
                    {p.status}
                  </Text>
                </Group>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c={HEALTH_COLOR[p.health] ?? "gray"}>
                  {p.health}
                </Text>
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
                    leftSection={<IconFileText size={14} />}
                    onClick={() => selectProcess({ profile: p.profile, commandId: p.commandId })}
                  >
                    Logs
                  </Button>
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

export function ProcessBoard() {
  const { data: processes, isLoading, error } = useProcesses();
  const stopProcess = useStopProcess();
  const restartCommand = useRestartCommand();
  const [activeTab, setActiveTab] = useState<string | null>("running");

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

  // Filter processes by status. "failed" gets its own tab rather than being
  // lumped into "queued" (starting/stopping) — a crashed service belongs
  // next to a badge you'd actually notice, not one that reads as "about to
  // start."
  const runningProcesses = processes.filter((p) => p.status === "running");
  const queuedProcesses = processes.filter(
    (p) => p.status === "starting" || p.status === "stopping",
  );
  const failedProcesses = processes.filter((p) => p.status === "failed");
  const stoppedProcesses = processes.filter((p) => p.status === "stopped");

  return (
    <Tabs value={activeTab} onChange={setActiveTab}>
      <Tabs.List>
        <Tabs.Tab value="running" rightSection={<Badge>{runningProcesses.length}</Badge>}>
          Running
        </Tabs.Tab>
        <Tabs.Tab value="queued" rightSection={<Badge>{queuedProcesses.length}</Badge>}>
          Queued
        </Tabs.Tab>
        <Tabs.Tab
          value="failed"
          rightSection={
            <Badge color={failedProcesses.length > 0 ? "red" : undefined}>
              {failedProcesses.length}
            </Badge>
          }
        >
          Failed
        </Tabs.Tab>
        <Tabs.Tab value="stopped" rightSection={<Badge>{stoppedProcesses.length}</Badge>}>
          Recent
        </Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="running" pt="md">
        <ProcessTable
          processes={runningProcesses}
          stopProcess={stopProcess}
          restartCommand={restartCommand}
        />
      </Tabs.Panel>

      <Tabs.Panel value="queued" pt="md">
        <ProcessTable
          processes={queuedProcesses}
          stopProcess={stopProcess}
          restartCommand={restartCommand}
        />
      </Tabs.Panel>

      <Tabs.Panel value="failed" pt="md">
        <ProcessTable
          processes={failedProcesses}
          stopProcess={stopProcess}
          restartCommand={restartCommand}
        />
      </Tabs.Panel>

      <Tabs.Panel value="stopped" pt="md">
        <ProcessTable
          processes={stoppedProcesses}
          stopProcess={stopProcess}
          restartCommand={restartCommand}
        />
      </Tabs.Panel>
    </Tabs>
  );
}
