import { NavLink, ScrollArea, Text, Badge, Stack, Divider, Group } from "@mantine/core";
import { IconLayoutDashboard, IconSettings, IconCircleFilled } from "@tabler/icons-react";
import { useProcesses } from "../hooks/useProcesses";
import { useUiStore } from "../store/ui";
import type { ProcessInfo } from "../lib/api";

const STATUS_COLOR: Record<string, string> = {
  running: "green",
  starting: "yellow",
  stopping: "orange",
  stopped: "gray",
  failed: "red",
};

export function Sidebar() {
  const { data: processes } = useProcesses();
  const { view, setView, selectedProcessKey, selectProcess } = useUiStore();

  const active = processes?.filter((p) => p.status === "running" || p.status === "starting") ?? [];
  const finished = processes?.filter((p) => p.status === "stopped" || p.status === "failed") ?? [];

  const isSelected = (p: ProcessInfo) =>
    selectedProcessKey?.profile === p.profile && selectedProcessKey?.commandId === p.commandId;

  return (
    <Stack h="100%" gap={0}>
      <Stack gap={4} p="xs">
        <NavLink
          label="Dashboard"
          leftSection={<IconLayoutDashboard size={16} />}
          active={view === "dashboard" && !selectedProcessKey}
          onClick={() => setView("dashboard")}
        />
        <NavLink
          label="Environment"
          leftSection={<IconSettings size={16} />}
          active={view === "environment" && !selectedProcessKey}
          onClick={() => setView("environment")}
        />
      </Stack>

      <Divider />

      <ScrollArea flex={1} p="xs">
        <Text size="xs" fw={700} c="dimmed" px="xs" pt="xs">
          RUNNING
        </Text>
        {active.length === 0 && (
          <Text size="xs" c="dimmed" px="xs" py={4}>
            Nothing running
          </Text>
        )}
        {active.map((p) => (
          <NavLink
            key={`${p.profile}/${p.commandId}`}
            active={isSelected(p)}
            label={p.commandName ?? p.commandId}
            description={`${p.profile} · pid ${p.pid}`}
            leftSection={
              <IconCircleFilled
                size={10}
                color={`var(--mantine-color-${STATUS_COLOR[p.status]}-6)`}
              />
            }
            onClick={() => selectProcess(p)}
          />
        ))}

        {finished.length > 0 && (
          <>
            <Text size="xs" fw={700} c="dimmed" px="xs" pt="md">
              RECENT
            </Text>
            {finished.slice(0, 10).map((p) => (
              <NavLink
                key={`${p.profile}/${p.commandId}`}
                active={isSelected(p)}
                label={p.commandName ?? p.commandId}
                description={
                  <Group gap={6}>
                    <span>{p.profile}</span>
                    <Badge size="xs" color={STATUS_COLOR[p.status]} variant="light">
                      {p.status}
                    </Badge>
                  </Group>
                }
                onClick={() => selectProcess(p)}
              />
            ))}
          </>
        )}
      </ScrollArea>
    </Stack>
  );
}
