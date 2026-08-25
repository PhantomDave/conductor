import { Badge, Button, Card, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconBox, IconEdit, IconPlayerPlay, IconTrash } from "@tabler/icons-react";
import type { useCommandLibrary } from "../hooks/useCommandLibrary";

type Command = ReturnType<typeof useCommandLibrary>["commands"][number];

function commandCategories(command: Command) {
  return Array.from(
    new Set(
      (command.category ?? "")
        .split(",")
        .map((category) => category.trim())
        .filter((category) => category && category.toLowerCase() !== "general"),
    ),
  );
}

interface CommandCardProps {
  readonly command: Command;
  readonly isRunning?: boolean;
  readonly isExecuting?: boolean;
  readonly onRun?: () => void;
  readonly onEdit?: () => void;
  readonly onDelete?: (commandId: string) => void;
}

export function CommandCard({
  command,
  isRunning = false,
  isExecuting = false,
  onRun,
  onEdit,
  onDelete,
}: CommandCardProps) {
  const categories = commandCategories(command);

  return (
    <Card withBorder p="md" radius="md" style={{ flex: "1 1 280px", minWidth: 280 }}>
      <Stack gap="lg">
        {/* Header */}
        <Stack gap={4}>
          <Group gap={6} wrap="nowrap">
            <ThemeIcon size="sm" variant="light" radius="md" color="blue">
              <IconBox size={14} />
            </ThemeIcon>
            <Text fw={600} size="sm" c="blue">
              {command.name}
            </Text>
          </Group>
          {categories.length > 0 && (
            <Group gap={4}>
              {categories.map((category) => (
                <Badge key={category} size="xs" variant="light" color="cyan">
                  {category}
                </Badge>
              ))}
            </Group>
          )}
          {command.healthcheck && command.healthcheck.type !== "none" && (
            <Badge size="xs" variant="dot" color="blue">
              health
            </Badge>
          )}
          {command.deps.length > 0 && (
            <Badge size="xs" variant="light" color="grape">
              deps: {command.deps.join(", ")}
            </Badge>
          )}
        </Stack>

        {/* Description */}
        {command.description && (
          <Text size="xs" c="dimmed">
            {command.description}
          </Text>
        )}

        {/* Action buttons */}
        <Group gap="xs">
          <Button
            flex={1}
            size="xs"
            leftSection={<IconPlayerPlay size={12} />}
            color="green"
            variant="light"
            onClick={onRun}
            loading={isExecuting || isRunning}
            disabled={isExecuting || isRunning}
          >
            Run
          </Button>
          {!command.readonly && (
            <>
              <Button
                flex={1}
                size="xs"
                variant="light"
                leftSection={<IconEdit size={12} />}
                onClick={onEdit}
              >
                Edit
              </Button>
              <Button
                flex={1}
                size="xs"
                color="red"
                variant="light"
                leftSection={<IconTrash size={12} />}
                onClick={() => onDelete?.(command.id)}
              >
                Delete
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Card>
  );
}
