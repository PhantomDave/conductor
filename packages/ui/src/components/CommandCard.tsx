import {
  Badge,
  Card,
  Group,
  Menu,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import {
  IconBox,
  IconDots,
  IconEdit,
  IconPlayerPlay,
  IconTrash,
} from "@tabler/icons-react";
import type { useCommandLibrary } from "../hooks/useCommandLibrary";

type Command = ReturnType<typeof useCommandLibrary>["commands"][number];

interface CommandCardProps {
  readonly command: Command;
  readonly isRunning?: boolean;
  readonly onRun?: () => void;
  readonly onEdit?: () => void;
  readonly onDelete?: (commandId: string) => void;
}

export function CommandCard({
  command,
  isRunning = false,
  onRun,
  onEdit,
  onDelete,
}: CommandCardProps) {
  return (
    <Card withBorder p="md" radius="md">
      <Stack gap="sm">
        {/* Header row */}
        <Group justify="space-between" align="flex-start">
          <Stack gap={2}>
            <Group gap={6} wrap="nowrap">
              <ThemeIcon size="sm" variant="light" radius="md" color="blue">
                <IconBox size={14} />
              </ThemeIcon>
              <Text fw={600} size="sm" c="blue">
                {command.name}
              </Text>
            </Group>
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

          {/* Hamburger menu for actions */}
          <Menu shadow="md" position="bottom-end">
            <Menu.Target>
              <ThemeIcon variant="subtle" color="gray" size="sm">
                <IconDots size={16} />
              </ThemeIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {onRun && (
                <Menu.Item
                  leftSection={<IconPlayerPlay size={14} />}
                  onClick={onRun}
                >
                  {isRunning ? "Running..." : "Run"}
                </Menu.Item>
              )}
              {!command.readonly ? (
                <>
                  {onEdit && (
                    <Menu.Item
                      leftSection={<IconEdit size={14} />}
                      onClick={onEdit}
                    >
                      Edit
                    </Menu.Item>
                  )}
                  <Menu.Divider />
                  {onDelete && (
                    <Menu.Item
                      leftSection={<IconTrash size={14} />}
                      color="red"
                      onClick={() => onDelete(command.id)}
                    >
                      Delete
                    </Menu.Item>
                  )}
                </>
              ) : null}
            </Menu.Dropdown>
          </Menu>
        </Group>

        {/* Description */}
        {command.description && (
          <Text size="xs" c="dimmed">
            {command.description}
          </Text>
        )}
      </Stack>
    </Card>
  );
}
