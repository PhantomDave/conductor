import {
  Card,
  Badge,
  Group,
  Stack,
  Text,
  Button,
  ThemeIcon,
  ActionIcon,
  Menu,
  Tooltip,
} from "@mantine/core";
import {
  IconBox,
  IconCopy,
  IconDots,
  IconDownload,
  IconEdit,
  IconEye,
  IconPlayerPlay,
  IconSettings,
  IconTrash,
} from "@tabler/icons-react";
import type { ProfileInfo } from "../lib/api";

interface ProfileCardProps {
  readonly name: string;
  readonly profile: ProfileInfo;
  readonly commandCount: number;
  readonly onView?: (profileName: string) => void;
  readonly onEdit?: (profileName: string) => void;
  readonly onRun?: () => void;
  readonly isRunning?: boolean;
  readonly onDuplicate?: (profileName: string) => void;
  readonly onManageCommands?: (profileName: string) => void;
  readonly onDelete?: (profileName: string) => void;
  readonly onExport?: (profileName: string) => void;
}

export function ProfileCard({
  name,
  profile,
  commandCount,
  onView,
  onEdit,
  onRun,
  isRunning,
  onDuplicate,
  onManageCommands,
  onDelete,
  onExport,
}: ProfileCardProps) {
  return (
    <Card
      withBorder
      p="md"
      radius="md"
      style={{ flex: "1 1 280px", minWidth: 280, display: "flex", flexDirection: "column" }}
    >
      <Stack gap="sm" flex={1}>
        {/* Header */}
        <Group justify="space-between" align="flex-start">
          <Stack gap={2} flex={1}>
            {onView ? (
              <Tooltip label="Click to view commands" withArrow>
                <Text
                  fw={600}
                  size="sm"
                  lineClamp={1}
                  onClick={() => onView?.(name)}
                  style={{ cursor: "pointer" }}
                  c="blue"
                >
                  {name}
                </Text>
              </Tooltip>
            ) : (
              <Text fw={600} size="sm" lineClamp={1}>
                {name}
              </Text>
            )}
            <Group gap={6}>
              <ThemeIcon size="sm" variant="light" radius="md">
                <IconBox size={14} />
              </ThemeIcon>
              <Badge size="xs" variant="outline">
                {commandCount} command{commandCount !== 1 ? "s" : ""}
              </Badge>
            </Group>
          </Stack>

          {/* Hamburger menu */}
          <Menu shadow="md" position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" size="xs">
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconEdit size={14} />} onClick={() => onEdit?.(name)}>
                Edit
              </Menu.Item>
              <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => onDuplicate?.(name)}>
                Duplicate
              </Menu.Item>
              <Menu.Item leftSection={<IconDownload size={14} />} onClick={() => onExport?.(name)}>
                Export
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                leftSection={<IconTrash size={14} />}
                color="red"
                onClick={() => onDelete?.(name)}
              >
                Delete
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>

        {/* Description */}
        {profile.description && (
          <Text size="xs" c="dimmed" lineClamp={2}>
            {profile.description}
          </Text>
        )}

        {/* Command list preview */}
        {commandCount > 0 && (
          <Stack gap={4}>
            <Text size="xs" fw={600} c="dimmed">
              Commands
            </Text>
            <Stack gap={2}>
              {profile.commands.slice(0, 3).map((cmd) => (
                <Group key={cmd.id} gap={6}>
                  <div
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: "50%",
                      backgroundColor: "var(--mantine-color-blue-6)",
                    }}
                  />
                  <Text size="xs" c="dimmed" lineClamp={1} flex={1}>
                    {cmd.name || cmd.id}
                  </Text>
                </Group>
              ))}
              {commandCount > 3 && (
                <Text size="xs" c="blue" fw={500}>
                  + {commandCount - 3} more
                </Text>
              )}
            </Stack>
          </Stack>
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
          loading={isRunning}
          disabled={isRunning}
        >
          Run
        </Button>
        {onView && (
          <Tooltip label="View commands" withArrow>
            <ActionIcon
              size="lg"
              variant="light"
              onClick={() => onView?.(name)}
              aria-label="View profile commands"
            >
              <IconEye size={16} />
            </ActionIcon>
          </Tooltip>
        )}
        <Tooltip label="Manage commands" withArrow>
          <ActionIcon
            size="lg"
            variant="light"
            color="blue"
            onClick={() => onManageCommands?.(name)}
            aria-label="Manage profile commands"
          >
            <IconSettings size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Card>
  );
}
