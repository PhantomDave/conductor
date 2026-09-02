import { NavLink, ScrollArea, Text, Badge, Stack, Divider, Group, ActionIcon } from "@mantine/core";
import {
  IconBolt,
  IconCircleFilled,
  IconLayoutDashboard,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconSettings,
  IconSitemap,
  IconTerminal2,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useProcesses } from "../hooks/useProcesses";
import { useProfiles } from "../hooks/useProfiles";
import { useRunProfile, useStopAllProcesses } from "../hooks/useProcessActions";
import { useUiStore } from "../store/ui";
import { STATUS_COLOR } from "../lib/statusColor";
import type { ProcessInfo } from "../lib/api";

// "# running"-style section label, matching SectionHeading's comment
// convention on the rest of the app — kept local since the sidebar's
// narrow column doesn't want SectionHeading's fill-width divider.
function SidebarLabel({ children }: { children: string }) {
  return (
    <Text size="xs" fw={700} px="xs" pt="xs" pb={2}>
      <span style={{ color: "var(--mantine-color-green-5)" }}>#</span>{" "}
      <span style={{ color: "var(--mantine-color-dark-3)" }}>{children}</span>
    </Text>
  );
}

export function Sidebar() {
  const { data: processes } = useProcesses();
  const { data: profiles } = useProfiles();
  const { view, setView, selectedProcessKey, selectProcess, triggerAction } = useUiStore();
  const runProfile = useRunProfile();
  const stopAll = useStopAllProcesses();

  const active = processes?.filter((p) => p.status === "running" || p.status === "starting") ?? [];
  const finished = processes?.filter((p) => p.status === "stopped" || p.status === "failed") ?? [];
  const profileNames = profiles ? Object.keys(profiles).sort((a, b) => a.localeCompare(b)) : [];

  const isSelected = (p: ProcessInfo) =>
    selectedProcessKey?.profile === p.profile && selectedProcessKey?.commandId === p.commandId;

  return (
    <Stack h="100%" gap={0}>
      <Stack gap={4} p="xs">
        <NavLink
          label="Processes"
          leftSection={<IconLayoutDashboard size={16} />}
          active={view === "processes" && !selectedProcessKey}
          onClick={() => setView("processes")}
        />
        <NavLink
          label="Flow"
          leftSection={<IconSitemap size={16} />}
          active={view === "flow" && !selectedProcessKey}
          onClick={() => setView("flow")}
        />
        <NavLink
          label="Profiles"
          leftSection={<IconUsersGroup size={16} />}
          active={view === "profiles" && !selectedProcessKey}
          onClick={() => setView("profiles")}
        />
        <NavLink
          label="Commands"
          leftSection={<IconTerminal2 size={16} />}
          active={view === "commands" && !selectedProcessKey}
          onClick={() => setView("commands")}
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
        <SidebarLabel>running</SidebarLabel>
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

        <Divider my="xs" />

        <SidebarLabel>quick actions</SidebarLabel>
        <NavLink
          label="Command library"
          description="Run or edit saved commands"
          leftSection={<IconBolt size={16} />}
          onClick={() => setView("commands")}
        />
        <NavLink
          label="New profile"
          description="Create a new profile"
          leftSection={<IconPlus size={16} />}
          onClick={() => triggerAction("profiles", "newProfile")}
        />
        <NavLink
          label="New command"
          description="Add a command to the library"
          leftSection={<IconPlus size={16} />}
          onClick={() => triggerAction("commands", "newCommand")}
        />
        <NavLink
          label="Stop all"
          description="Stop every running process"
          leftSection={<IconPlayerStop size={16} />}
          disabled={active.length === 0 || stopAll.isPending}
          onClick={() => stopAll.mutate()}
        />

        {profileNames.length > 0 && (
          <>
            <Divider my="xs" />
            <SidebarLabel>profiles</SidebarLabel>
            {profileNames.map((name) => (
              <NavLink
                key={name}
                label={name}
                leftSection={<IconUsersGroup size={16} />}
                onClick={() => setView("profiles")}
                rightSection={
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    aria-label={`Run ${name}`}
                    loading={runProfile.isPending && runProfile.variables === name}
                    onClick={(e) => {
                      e.stopPropagation();
                      runProfile.mutate(name);
                    }}
                  >
                    <IconPlayerPlay size={14} />
                  </ActionIcon>
                }
              />
            ))}
          </>
        )}

        {finished.length > 0 && (
          <>
            <SidebarLabel>recent</SidebarLabel>
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
