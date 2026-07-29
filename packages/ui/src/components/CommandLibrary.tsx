import { useState } from "react";
import {
  Badge,
  Button,
  Modal,
  Card,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { IconEdit, IconPlus, IconTrash } from "@tabler/icons-react";
import { useCommandLibrary } from "../hooks/useCommandLibrary";
import { CommandForm } from "./CommandForm";

export function CommandLibrary() {
  const {
    commands,
    isLoading,
    error,
    deleteItem,
  } = useCommandLibrary();

  const [formOpen, setFormOpen] = useState(false);
  const [editState, setEditState] = useState<ReturnType<typeof useCommandLibrary>["commands"][number] | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  if (isLoading) return <Text c="dimmed">Loading command library...</Text>;
  if (error) return <Text c="red">{(error as Error).message}</Text>;

  // Flatten commands into a deduplicated array
  const flatCommands = Object.values(commands).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Stack gap="sm">
      <Button
        leftSection={<IconPlus size={14} />}
        variant="light"
        onClick={() => {
          setFormOpen(true);
          setEditState(null);
        }}
      >
        Add command
      </Button>

      {flatCommands.length === 0 ? (
        <Card withBorder padding="lg">
          <Text c="dimmed">No commands yet. Add one to get started.</Text>
        </Card>
      ) : (
        flatCommands.map((cmd) => (
          <Card key={cmd.id} withBorder padding="sm" radius="xs">
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={2}>
                <Group gap={6} wrap="nowrap">
                  <Text size="sm" fw={500}>{cmd.name}</Text>
                  {cmd.healthcheck && cmd.healthcheck.type !== "none" && (
                    <Badge size="xs" variant="dot" color="blue">health</Badge>
                  )}
                  {cmd.deps.length > 0 && (
                    <Badge size="xs" variant="light" color="grape">deps: {cmd.deps.join(", ")}</Badge>
                  )}
                </Group>
                {cmd.description && (
                  <Text size="xs" c="dimmed">{cmd.description}</Text>
                )}
              </Stack>
              
              {!cmd.readonly ? (
                <Group gap={4}>
                  <Button 
                    size="xs" 
                    variant="light" 
                    leftSection={<IconEdit size={12} />}
                    onClick={() => {
                      setFormOpen(true);
                      setEditState(cmd);
                    }}
                  >
                    Edit
                  </Button>
                  <Button 
                    size="xs" 
                    color="red" 
                    variant="light" 
                    leftSection={<IconTrash size={12} />}
                    onClick={() => setDeleteConfirm(cmd.id)}
                  >
                    Delete
                  </Button>
                </Group>
              ) : null}
            </Group>
          </Card>
        ))
      )}

      {formOpen && (
        <CommandForm
          opened={true}
          onClose={() => setFormOpen(false)}
          profile={undefined}
          existingCommands={flatCommands}
          editing={editState ? editState : null}
        />
      )}

      {deleteConfirm && (
        <Modal
          opened={Boolean(deleteConfirm)}
          onClose={() => setDeleteConfirm(null)}
          title="Delete command"
          centered
        >
          <Stack>
            <Text size="sm">Are you sure you want to delete command "{flatCommands.find(c => c.id === deleteConfirm)?.name ?? ''}"? This cannot be undone.</Text>
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
