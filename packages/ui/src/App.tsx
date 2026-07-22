import { AppShell, Group, Title, Text, Badge, Box } from "@mantine/core";
import { Sidebar } from "./components/Sidebar";
import { LogViewer } from "./components/LogViewer";
import { EnvironmentManager } from "./components/EnvironmentManager";
import { Dashboard } from "./pages/Dashboard";
import { useUiStore } from "./store/ui";
import { useProcesses } from "./hooks/useProcesses";

export default function App() {
  const { view, selectedProcessKey } = useUiStore();
  const { data: processes } = useProcesses();

  // Re-derived from the live process list on every poll (rather than a
  // frozen snapshot) so pid/status/logs stay correct across a restart.
  const selectedProcess = selectedProcessKey
    ? processes?.find(
        (p) =>
          p.profile === selectedProcessKey.profile && p.commandId === selectedProcessKey.commandId,
      )
    : undefined;

  let main = <Dashboard />;
  if (selectedProcessKey) {
    main = selectedProcess ? (
      <LogViewer process={selectedProcess} />
    ) : (
      <Text c="dimmed">Loading process...</Text>
    );
  } else if (view === "environment") {
    main = <EnvironmentManager />;
  }

  return (
    <AppShell header={{ height: 60 }} navbar={{ width: 280, breakpoint: "sm" }} padding="md">
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

      <AppShell.Main>
        <Box h="calc(100vh - 92px)" style={{ overflow: selectedProcessKey ? "hidden" : "auto" }}>
          {main}
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
