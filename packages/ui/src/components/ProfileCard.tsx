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
  IconChevronRight,
  IconDots,
  IconCopy,
  IconTrash,
  IconDownload,
  IconEdit,
} from "@tabler/icons-react";
import type { ProfileInfo } from "../lib/api";

interface ProfileCardProps {
  readonly name: string;
  readonly profile: ProfileInfo;
  readonly commandCount: number;
  readonly onSelect?: (profileName: string) => void;
  readonly onRename?: (oldName: string, newName: string) => void;
  readonly onDuplicate?: (profileName: string) => void;
  readonly onDelete?: (profileName: string) => void;
  readonly onExport?: (profileName: string) => void;
}

export function ProfileCard({
  name,
  profile,
  commandCount,
  onSelect,
  onRename,
  onDuplicate,
  onDelete,
  onExport,
}: ProfileCardProps) {
  return (
    <Card withBorder p="md" radius="md" style={{ flex: "1 1 280px", minWidth: 280 }}>
      <Stack gap="sm">
        {/* Header: Profile name + command count */}
        <Group justify="space-between" align="flex-start">
          <Stack gap={2} flex={1}>
            <Tooltip label="Click to view commands" withArrow>
              <Text
                fw={600}
                size="sm"
                lineClamp={1}
                onClick={() => onSelect?.(name)}
                style={{ cursor: onSelect ? "pointer" : "default" }}
                c={onSelect ? "blue" : "auto"}
              >
                {name}
              </Text>
            </Tooltip>
            <Group gap={6}>
              <ThemeIcon size="sm" variant="light" radius="md">
                <IconBox size={14} />
              </ThemeIcon>
              <Badge size="xs" variant="outline">
                {commandCount} command{commandCount !== 1 ? "s" : ""}
              </Badge>
            </Group>
          </Stack>

          {/* Menu */}
          <Menu shadow="md" position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" size="xs">
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconChevronRight size={14} />}
                onClick={() => onSelect?.(name)}
              >
                View Commands
              </Menu.Item>
              <Menu.Item
                leftSection={<IconEdit size={14} />}
                onClick={() => onRename?.(name)}
              >
                Rename
              </Menu.Item>
              <Menu.Item
                leftSection={<IconCopy size={14} />}
                onClick={() => onDuplicate?.(name)}
              >
                Duplicate
              </Menu.Item>
              <Menu.Item
                leftSection={<IconDownload size={14} />}
                onClick={() => onExport?.(name)}
              >
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

        {/* Action buttons */}
        <Group gap="xs">
          <Button
            flex={1}
            size="xs"
            variant="light"
            onClick={() => onSelect?.(name)}
          >
            View
          </Button>
          <Button
            flex={1}
            size="xs"
            variant="light"
            color="gray"
            onClick={() => onDuplicate?.(name)}
          >
            Duplicate
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
