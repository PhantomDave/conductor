import { useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  Modal,
  NavLink,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import { IconFolder, IconPlus } from "@tabler/icons-react";
import { useCommandLibrary } from "../hooks/useCommandLibrary";
import { useProcesses } from "../hooks/useProcesses";
import { CommandForm } from "./CommandForm";
import { CommandCard } from "./CommandCard";
import { useExecuteCommand } from "../hooks/useProcessActions";

const DEFAULT_CATEGORY = "General";

function commandCategory(command: ReturnType<typeof useCommandLibrary>["commands"][number]) {
  return command.category?.trim() || DEFAULT_CATEGORY;
}

export function CommandLibrary() {
  const { commands, isLoading: loadingCommands, error, deleteItem } = useCommandLibrary();
  const processes = useProcesses();
  const execute = useExecuteCommand();

  const [formOpen, setFormOpen] = useState(false);
  const [editState, setEditState] = useState<
    ReturnType<typeof useCommandLibrary>["commands"][number] | null
  >(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  if (loadingCommands || processes.isLoading)
    return <Text c="dimmed">Loading command library...</Text>;
  if (error) return <Text c="red">{(error as Error).message}</Text>;

  // Flatten commands into a deduplicated array
  const flatCommands = Object.values(commands).sort((a, b) => a.name.localeCompare(b.name));
  const categoryCounts = flatCommands.reduce<Record<string, number>>((acc, command) => {
    const category = commandCategory(command);
    acc[category] = (acc[category] ?? 0) + 1;
    return acc;
  }, {});
  const categories = Object.keys(categoryCounts).sort((a, b) => a.localeCompare(b));
  const activeCategory =
    selectedCategory && categories.includes(selectedCategory) ? selectedCategory : categories[0];
  const visibleCommands = activeCategory
    ? flatCommands.filter((command) => commandCategory(command) === activeCategory)
    : flatCommands;

  const isRunning = (commandId: string): boolean =>
    processes.data?.some(
      (p) => p.commandId === commandId && (p.status === "running" || p.status === "starting"),
    ) ?? false;

  return (
    <Stack gap="sm">
      {/* Add command button */}
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
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
          <Card withBorder padding="lg">
            <Text c="dimmed">No commands yet. Add one to get started.</Text>
          </Card>
        </SimpleGrid>
      ) : (
        <Group align="flex-start" gap="md" wrap="nowrap">
          <Box w={220} style={{ flexShrink: 0 }}>
            <Stack gap={4}>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="xs">
                Categories
              </Text>
              {categories.map((category) => (
                <NavLink
                  key={category}
                  active={category === activeCategory}
                  label={category}
                  leftSection={<IconFolder size={16} />}
                  rightSection={
                    <Badge size="xs" variant="light">
                      {categoryCounts[category]}
                    </Badge>
                  }
                  onClick={() => setSelectedCategory(category)}
                />
              ))}
            </Stack>
          </Box>

          <Box flex={1} style={{ minWidth: 0 }}>
            <Stack gap="sm">
              <Group justify="space-between" align="center">
                <div>
                  <Text fw={700}>{activeCategory}</Text>
                  <Text size="xs" c="dimmed">
                    {visibleCommands.length} command{visibleCommands.length === 1 ? "" : "s"}
                  </Text>
                </div>
              </Group>
              <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
                {visibleCommands.map((cmd) => (
                  <CommandCard
                    key={cmd.id}
                    command={cmd}
                    isRunning={isRunning(cmd.id)}
                    isExecuting={execute.isPending && execute.variables?.commandId === cmd.id}
                    onRun={() => execute.mutate({ profile: "__global__", commandId: cmd.id })}
                    onEdit={() => {
                      setFormOpen(true);
                      setEditState(cmd);
                    }}
                    onDelete={(id) => setDeleteConfirm(id)}
                  />
                ))}
              </SimpleGrid>
            </Stack>
          </Box>
        </Group>
      )}

      {formOpen && (
        <CommandForm
          opened={true}
          onClose={() => setFormOpen(false)}
          profile={undefined}
          existingCommands={flatCommands}
          editing={editState}
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
            <Text size="sm">
              Are you sure you want to delete command "
              {flatCommands.find((c) => c.id === deleteConfirm)?.name ?? ""}"? This cannot be
              undone.
            </Text>
            <Group justify="flex-end">
              <Button variant="subtle" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </Button>
              <Button
                color="red"
                onClick={() => {
                  deleteItem(deleteConfirm);
                  setDeleteConfirm(null);
                }}
              >
                Delete
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}
