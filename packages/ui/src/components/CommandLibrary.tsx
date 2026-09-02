import { useEffect, useState } from "react";
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
  TextInput,
} from "@mantine/core";
import { IconFolder, IconPlus, IconSearch } from "@tabler/icons-react";
import { useCommandLibrary } from "../hooks/useCommandLibrary";
import { useProcesses } from "../hooks/useProcesses";
import { CommandForm } from "./CommandForm";
import { CommandCard } from "./CommandCard";
import { SectionHeading } from "./SectionHeading";
import { useExecuteCommand } from "../hooks/useProcessActions";
import { useUiStore } from "../store/ui";

const DEFAULT_CATEGORY = "General";

function commandCategories(command: ReturnType<typeof useCommandLibrary>["commands"][number]) {
  const reservedCategory = DEFAULT_CATEGORY.toLowerCase();
  return Array.from(
    new Set(
      (command.category ?? "")
        .split(",")
        .map((category) => category.trim())
        .filter((category) => category && category.toLowerCase() !== reservedCategory),
    ),
  );
}

export function CommandLibrary() {
  const { commands, isLoading: loadingCommands, error, deleteItem } = useCommandLibrary();
  const processes = useProcesses();
  const execute = useExecuteCommand();
  const { pendingAction, clearPendingAction } = useUiStore();

  const [formOpen, setFormOpen] = useState(false);
  const [editState, setEditState] = useState<
    ReturnType<typeof useCommandLibrary>["commands"][number] | null
  >(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Auto-open the add form when the sidebar's "New Command" quick action navigates here.
  useEffect(() => {
    if (pendingAction === "newCommand") {
      setFormOpen(true);
      setEditState(null);
      clearPendingAction();
    }
  }, [pendingAction, clearPendingAction]);

  if (loadingCommands || processes.isLoading)
    return <Text c="dimmed">Loading command library...</Text>;
  if (error) return <Text c="red">{(error as Error).message}</Text>;

  // Flatten commands into a deduplicated array
  const flatCommands = Object.values(commands).sort((a, b) => a.name.localeCompare(b.name));
  const categoryCounts = flatCommands.reduce<Record<string, number>>(
    (acc, command) => {
      for (const category of commandCategories(command)) {
        acc[category] = (acc[category] ?? 0) + 1;
      }
      return acc;
    },
    { [DEFAULT_CATEGORY]: flatCommands.length },
  );
  const categories = [
    DEFAULT_CATEGORY,
    ...Object.keys(categoryCounts)
      .filter((category) => category !== DEFAULT_CATEGORY)
      .sort((a, b) => a.localeCompare(b)),
  ];
  const activeCategory =
    selectedCategory && categories.includes(selectedCategory) ? selectedCategory : DEFAULT_CATEGORY;
  const query = search.trim().toLowerCase();
  const categoryCommands =
    activeCategory === DEFAULT_CATEGORY
      ? flatCommands
      : flatCommands.filter((command) => commandCategories(command).includes(activeCategory));
  // A search query searches every command regardless of the selected category.
  const visibleCommands = query
    ? flatCommands.filter(
        (cmd) =>
          cmd.name.toLowerCase().includes(query) ||
          cmd.id.toLowerCase().includes(query) ||
          cmd.description?.toLowerCase().includes(query),
      )
    : categoryCommands;

  const isRunning = (commandId: string): boolean =>
    processes.data?.some(
      (p) => p.commandId === commandId && (p.status === "running" || p.status === "starting"),
    ) ?? false;

  return (
    <Stack gap="sm">
      <SectionHeading>commands</SectionHeading>
      <Group justify="space-between" wrap="wrap">
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

        {flatCommands.length > 0 && (
          <TextInput
            placeholder="Search commands..."
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            w={{ base: "100%", xs: 280 }}
          />
        )}
      </Group>

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
                  <Text fw={700}>{query ? "Search results" : activeCategory}</Text>
                  <Text size="xs" c="dimmed">
                    {visibleCommands.length} command{visibleCommands.length === 1 ? "" : "s"}
                  </Text>
                </div>
              </Group>
              {visibleCommands.length === 0 ? (
                <Card withBorder padding="lg">
                  <Text c="dimmed">No commands match "{search}".</Text>
                </Card>
              ) : (
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
              )}
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
