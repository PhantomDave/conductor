import { AppShell, Badge, Box, Group, Stack, Tabs, Text, Title } from "@mantine/core";
import { LogViewer } from "./components/LogViewer";
import { EnvironmentManager } from "./components/EnvironmentManager";
import { ProcessBoard } from "./components/ProcessBoard";
import { NotificationsTab } from "./components/NotificationsTab";
import { ProfileGridView } from "./components/ProfileGridView";
import { CommandLibrary } from "./components/CommandLibrary";
import { useUiStore } from "./store/ui";
import { useProcesses } from "./hooks/useProcesses";

export default function App() {
  const { tab, setTab, selectedProcessKey, selectProcess } = useUiStore();
  const { data: processes } = useProcesses();

  // Re-derived from the live process list on every poll so pid/status/logs stay correct
  const selectedProcess = selectedProcessKey
    ? processes?.find(
        (p) =>
          p.profile === selectedProcessKey.profile && p.commandId === selectedProcessKey.commandId,
      )
    : undefined;

  // Show log viewer when a process is selected
  if (selectedProcessKey) {
    return (
      <AppShell header={{ height: 60 }} padding="md">
        <AppShell.Header>
          <Group h="100%" px="md" justify="space-between">
            <Group>
              <Title order={3}>🎼 Conductor</Title>
              <Badge variant="light">v{__VERSION__}</Badge>
            </Group>
            <Text size="sm" c="dimmed">
              Universal task runner & dashboard
            </Text>
          </Group>
        </AppShell.Header>

        <AppShell.Main>
          <Box
            h="calc(100vh - 92px)"
            style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
          >
            <Group mb="md" justify="space-between">
              <Title order={4}>{selectedProcess?.commandName || selectedProcess?.commandId}</Title>
              <Badge>{selectedProcess?.profile}</Badge>
            </Group>
            <Box flex={1} style={{ overflow: "hidden" }}>
              {selectedProcess ? (
                <LogViewer process={selectedProcess} />
              ) : (
                <Text c="dimmed">Loading process...</Text>
              )}
            </Box>
            <Group mt="md">
              <button
                onClick={() => selectProcess(null)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "4px",
                  border: "1px solid var(--mantine-color-gray-3)",
                  cursor: "pointer",
                }}
              >
                Back to Dashboard
              </button>
            </Group>
          </Box>
        </AppShell.Main>
      </AppShell>
    );
  }

  return (
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Title order={3}>🎼 Conductor</Title>
            <Badge variant="light">v{__VERSION__}</Badge>
          </Group>
          <Text size="sm" c="dimmed">
            Universal task runner & dashboard
          </Text>
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Tabs
          value={tab}
          onChange={(value) => setTab((value as "processes" | "profiles") ?? "processes")}
        >
          <Tabs.List>
            <Tabs.Tab value="processes">Processes</Tabs.Tab>
            <Tabs.Tab value="profiles">Profiles</Tabs.Tab>
            <Tabs.Tab value="commands">Commands</Tabs.Tab>
            <Tabs.Tab value="environment">Environment</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="processes" pt="md">
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
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="profiles" pt="md">
            <ProfileGridView />
          </Tabs.Panel>

          <Tabs.Panel value="commands" pt="md">
            <CommandLibrary />
          </Tabs.Panel>

          <Tabs.Panel value="environment" pt="md">
            <EnvironmentManager />
          </Tabs.Panel>
        </Tabs>
      </AppShell.Main>
    </AppShell>
  );
}
