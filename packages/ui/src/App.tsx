import { AppShell, Badge, Box, Button, Group, Stack, Text, Title } from "@mantine/core";
import { LogViewer } from "./components/LogViewer";
import { EnvironmentManager } from "./components/EnvironmentManager";
import { ProcessBoard } from "./components/ProcessBoard";
import { NotificationsTab } from "./components/NotificationsTab";
import { ProfileGridView } from "./components/ProfileGridView";
import { CommandLibrary } from "./components/CommandLibrary";
import { Sidebar } from "./components/Sidebar";
import { useUiStore } from "./store/ui";
import { useProcesses } from "./hooks/useProcesses";

export default function App() {
  const { view, selectedProcessKey, selectProcess, setView } = useUiStore();
  const { data: processes } = useProcesses();

  // Re-derived from the live process list on every poll so pid/status/logs stay correct
  const selectedProcess = selectedProcessKey
    ? processes?.find(
        (p) =>
          p.profile === selectedProcessKey.profile && p.commandId === selectedProcessKey.commandId,
      )
    : undefined;

  const renderView = () => {
    if (selectedProcessKey) {
      return (
        <Box
          h="calc(100vh - 92px)"
          style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
        >
          <Group mb="md" justify="space-between">
            <Group gap="sm">
              <Title order={4}>{selectedProcess?.commandName || selectedProcess?.commandId}</Title>
              <Badge>{selectedProcess?.profile}</Badge>
            </Group>
            <Button
              variant="light"
              size="xs"
              onClick={() => {
                selectProcess(null);
                setView("processes");
              }}
            >
              Back to processes
            </Button>
          </Group>
          <Box flex={1} style={{ overflow: "hidden" }}>
            {selectedProcess ? (
              <LogViewer process={selectedProcess} />
            ) : (
              <Text c="dimmed">Loading process...</Text>
            )}
          </Box>
        </Box>
      );
    }

    if (view === "profiles") return <ProfileGridView />;
    if (view === "commands") return <CommandLibrary />;
    if (view === "environment") return <EnvironmentManager />;

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
      </Stack>
    );
  };

  return (
    <AppShell header={{ height: 60 }} navbar={{ width: 300, breakpoint: "sm" }} padding="md">
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

      <AppShell.Navbar>
        <Sidebar />
      </AppShell.Navbar>

      <AppShell.Main>{renderView()}</AppShell.Main>
    </AppShell>
  );
}
