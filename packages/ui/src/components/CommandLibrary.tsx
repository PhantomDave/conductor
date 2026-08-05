import { useState } from "react";
import { Button, Card, Group, Modal, SimpleGrid, Stack, Text } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useCommandLibrary } from "../hooks/useCommandLibrary";
import { useProcesses } from "../hooks/useProcesses";
import { CommandForm } from "./CommandForm";
import { CommandCard } from "./CommandCard";
import { useExecuteCommand } from "../hooks/useProcessActions";

export function CommandLibrary() {
  const { commands, isLoading: loadingCommands, error, deleteItem } = useCommandLibrary();
  const processes = useProcesses();
  const execute = useExecuteCommand();

  const [formOpen, setFormOpen] = useState(false);
  const [editState, setEditState] = useState<
    ReturnType<typeof useCommandLibrary>["commands"][number] | null
  >(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  if (loadingCommands || processes.isLoading)
    return <Text c="dimmed">Loading command library...</Text>;
  if (error) return <Text c="red">{(error as Error).message}</Text>;

  // Flatten commands into a deduplicated array
  const flatCommands = Object.values(commands).sort((a, b) => a.name.localeCompare(b.name));

  const isRunning = (commandId: string): boolean =>
    processes.data?.some(
      (p) => p.commandId === commandId && (p.status === "running" || p.status === "starting"),
    ) ?? false;

  return (
    <Stack gap="sm">
      {/* Add command button */}
      <Button leftSection={<IconPlus size={14} />} variant="light" onClick={() => { setFormOpen(true); setEditState(null); }}>
        Add command
      </Button>

      {flatCommands.length === 0 ? (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
          <Card withBorder padding="lg">
            <Text c="dimmed">No commands yet. Add one to get started.</Text>
          </Card>
        </SimpleGrid>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
          {flatCommands.map((cmd) => (
            <CommandCard
              key={cmd.id}
              command={cmd}
              isRunning={isRunning(cmd.id)}
              onRun={() => execute.mutate({ profile: "__global__", commandId: cmd.id })}
              onEdit={() => { setFormOpen(true); setEditState(cmd); }}
              onDelete={(id) => setDeleteConfirm(id)}
            />
          ))}
        </SimpleGrid>
      )}

      {formOpen && (
        <CommandForm opened={true} onClose={() => setFormOpen(false)} profile={undefined} existingCommands={flatCommands} editing={editState ? editState : null} />
      )}

      {deleteConfirm && (
        <Modal opened={Boolean(deleteConfirm)} onClose={() => setDeleteConfirm(null)} title="Delete command" centered>
          <Stack>
            <Text size="sm">Are you sure you want to delete command "{flatCommands.find((c) => c.id === deleteConfirm)?.name ?? ""}"? This cannot be undone.</Text>
            <Group justify="flex-end">
              <Button variant="subtle" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
              <Button color="red" onClick={() => { deleteItem(deleteConfirm); setDeleteConfirm(null); }}>Delete</Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}
