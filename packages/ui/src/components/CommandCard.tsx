import { Badge, Button, Card, Group, Stack, Text, ThemeIcon, ActionIcon, Tooltip } from "@mantine/core";
import { IconBox, IconEdit, IconPlayerPlay, IconTrash } from "@tabler/icons-react";
import type { useCommandLibrary } from "../hooks/useCommandLibrary";

type Command = ReturnType<typeof useCommandLibrary>["commands"][number];

const DEFAULT_CATEGORY = "General";

function commandCategories(command: Command) {
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
    <Card
      withBorder
      p="md"
      radius="md"
      style={{ flex: "1 1 280px", minWidth: 280, display: "flex", flexDirection: "column" }}
    >
      <Stack gap="lg" flex={1}>
        {/* Header */}
        <Stack gap={4}>
          <Group gap={6} wrap="nowrap">
            <ThemeIcon size="sm" variant="light" radius="md" color="blue">
              <IconBox size={14} />
            </ThemeIcon>
            <Text fw={600} size="sm" c="blue" lineClamp={1}>
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
          <Text size="xs" c="dimmed" lineClamp={3}>
            {command.description}
          </Text>
        )}
      </Stack>

      {/* Action buttons */}
      <Group gap="xs" wrap="nowrap" mt="md">
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
            <Tooltip label="Edit" withArrow>
              <ActionIcon size="lg" variant="light" onClick={onEdit} aria-label="Edit command">
                <IconEdit size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Delete" withArrow>
              <ActionIcon
                size="lg"
                color="red"
                variant="light"
                onClick={() => onDelete?.(command.id)}
                aria-label="Delete command"
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </>
        )}
      </Group>
    </Card>
  );
}
