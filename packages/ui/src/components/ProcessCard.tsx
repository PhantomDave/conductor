import {
  Card,
  Badge,
  Group,
  Stack,
  Text,
  Button,
  Tooltip,
  ThemeIcon,
  Progress,
  Flex,
} from "@mantine/core";
import { IconPlayerStop, IconRefresh, IconCircleFilled } from "@tabler/icons-react";
import { useRestartCommand, useStopProcess } from "../hooks/useProcessActions";
import type { ProcessInfo } from "../lib/api";

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

interface ProcessCardProps {
  readonly process: ProcessInfo;
  readonly onSelect?: (process: ProcessInfo) => void;
}

export function ProcessCard({ process, onSelect }: ProcessCardProps) {
  const stopProcess = useStopProcess();
  const restartCommand = useRestartCommand();

  const isStoppable = process.status === "running" || process.status === "starting";
  const memoryMB = process.memoryBytes ? (process.memoryBytes / 1024 / 1024).toFixed(0) : "-";
  const cpu = process.cpuPercent?.toFixed(1) ?? "-";
  const duration = process.startedAt
    ? Math.floor((Date.now() - new Date(process.startedAt).getTime()) / 1000)
    : 0;
  const durationStr = duration > 0 ? formatDuration(duration) : "-";

  return (
    <Card withBorder p="md" radius="md" style={{ flex: "1 1 280px", minWidth: 280 }}>
      <Stack gap="sm">
        {/* Header: Command name + Profile badge */}
        <Group justify="space-between" align="flex-start">
          <Stack gap={2} flex={1}>
            <Text fw={600} size="sm" lineClamp={1}>
              {process.commandName || process.commandId}
            </Text>
            <Badge size="xs" variant="light" onClick={() => onSelect?.(process)}>
              {process.profile}
            </Badge>
          </Stack>
          <Group gap={4}>
            <Tooltip label={process.status} withArrow>
              <ThemeIcon
                size="sm"
                color={STATUS_COLOR[process.status] || "gray"}
                variant="light"
                radius="md"
              >
                <IconCircleFilled size={8} />
              </ThemeIcon>
            </Tooltip>
          </Group>
        </Group>

        {/* Status & Health badges */}
        <Group gap="xs">
          <Badge size="xs" color={STATUS_COLOR[process.status] || "gray"}>
            {process.status}
          </Badge>
          <Badge size="xs" color={HEALTH_COLOR[process.health] || "gray"} variant="outline">
            {process.health}
          </Badge>
        </Group>

        {/* Metrics: CPU, Memory, Duration */}
        <Stack gap={4}>
          <Group justify="space-between" gap="xs">
            <Text size="xs" c="dimmed">
              CPU
            </Text>
            <Text size="xs" fw={500}>
              {cpu}%
            </Text>
          </Group>
          {process.cpuPercent !== undefined && (
            <Progress value={Math.min(process.cpuPercent, 100)} size="xs" color="blue" />
          )}

          <Group justify="space-between" gap="xs">
            <Text size="xs" c="dimmed">
              Memory
            </Text>
            <Text size="xs" fw={500}>
              {memoryMB} MB
            </Text>
          </Group>

          <Group justify="space-between" gap="xs">
            <Text size="xs" c="dimmed">
              Runtime
            </Text>
            <Text size="xs" fw={500}>
              {durationStr}
            </Text>
          </Group>

          <Group justify="space-between" gap="xs">
            <Text size="xs" c="dimmed">
              PID
            </Text>
            <Text size="xs" fw={500}>
              {process.pid}
            </Text>
          </Group>
        </Stack>

        {/* Actions */}
        <Flex gap="xs">
          <Button
            flex={1}
            size="xs"
            variant="light"
            leftSection={<IconRefresh size={14} />}
            loading={
              restartCommand.isPending &&
              restartCommand.variables?.commandId === process.commandId &&
              restartCommand.variables?.profile === process.profile
            }
            onClick={() =>
              restartCommand.mutate({ profile: process.profile, commandId: process.commandId })
            }
          >
            Restart
          </Button>
          <Button
            flex={1}
            size="xs"
            color="red"
            variant="light"
            disabled={!isStoppable}
            leftSection={<IconPlayerStop size={14} />}
            loading={stopProcess.isPending && stopProcess.variables === process.pid}
            onClick={() => stopProcess.mutate(process.pid)}
          >
            Stop
          </Button>
        </Flex>

        {/* Click to view logs hint */}
        {onSelect && (
          <Button
            size="xs"
            variant="subtle"
            fullWidth
            onClick={() => onSelect(process)}
            c="blue"
          >
            View Logs
          </Button>
        )}
      </Stack>
    </Card>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}
