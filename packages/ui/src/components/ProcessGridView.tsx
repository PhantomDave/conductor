import React from "react";
import { Stack, Text, Card, Group, Select, SimpleGrid } from "@mantine/core";
import { useProcesses } from "../hooks/useProcesses";
import { useUiStore } from "../store/ui";
import { ProcessCard } from "./ProcessCard";

export function ProcessGridView() {
  const { data: processes, isLoading, error } = useProcesses();
  const { selectProcess } = useUiStore();

  const [filterProfile, setFilterProfile] = React.useState<string | null>(null);

  if (isLoading) return <Text c="dimmed">Loading processes...</Text>;
  if (error) {
    return <Text c="red">Could not reach Conductor core API. Is `bun run dev:core` running?</Text>;
  }

  if (!processes || processes.length === 0) {
    return (
      <Card withBorder padding="lg">
        <Text c="dimmed">
          No processes running. Start one with `conductor run &lt;profile&gt;` or from the command
          library.
        </Text>
      </Card>
    );
  }

  const profiles = Array.from(new Set(processes.map((p) => p.profile)));
  const filtered = filterProfile ? processes.filter((p) => p.profile === filterProfile) : processes;

  // Separate running and finished
  const running = filtered.filter((p) => p.status === "running" || p.status === "starting");
  const finished = filtered.filter((p) => p.status === "stopped" || p.status === "failed");

  return (
    <Stack gap="lg">
      {/* Filter by profile */}
      {profiles.length > 1 && (
        <Select
          placeholder="Filter by profile..."
          data={profiles}
          value={filterProfile}
          onChange={setFilterProfile}
          clearable
          searchable
        />
      )}

      {/* Running processes */}
      {running.length > 0 && (
        <Stack gap="sm">
          <Group justify="space-between">
            <Text fw={600} size="sm">
              Running ({running.length})
            </Text>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 4 }} spacing="md">
            {running.map((p) => (
              <ProcessCard key={`${p.profile}/${p.commandId}`} process={p} onSelect={selectProcess} />
            ))}
          </SimpleGrid>
        </Stack>
      )}

      {/* Finished processes */}
      {finished.length > 0 && (
        <Stack gap="sm">
          <Group justify="space-between">
            <Text fw={600} size="sm" c="dimmed">
              Recent ({finished.length})
            </Text>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 4 }} spacing="md">
            {finished.slice(0, 8).map((p) => (
              <ProcessCard key={`${p.profile}/${p.commandId}`} process={p} onSelect={selectProcess} />
            ))}
          </SimpleGrid>
        </Stack>
      )}
    </Stack>
  );
}
