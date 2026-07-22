import { Modal, Stack, Button, Text, Group, Badge } from "@mantine/core";
import { useMemo } from "react";

interface ProfilePickerModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly profiles: Record<string, { commands: readonly any[] }> | undefined;
  readonly excludeProfile?: string;
  readonly onSelect: (profileName: string) => void;
  readonly title: string;
  readonly description?: string;
}

export function ProfilePickerModal(
  props: Readonly<ProfilePickerModalProps>,
): React.ReactElement {
  const { opened, onClose, profiles, excludeProfile, onSelect, title, description } = props;
  const availableProfiles = useMemo(() => {
    if (!profiles) return [];
    return Object.entries(profiles)
      .filter(([name]) => name !== excludeProfile)
      .map(([name, profile]) => ({ name, ...profile }));
  }, [profiles, excludeProfile]);

  return (
    <Modal opened={opened} onClose={onClose} title={title}>
      <Stack gap="sm">
        {description && <Text size="sm">{description}</Text>}
        {availableProfiles.length === 0 ? (
          <Text c="dimmed">No profiles available</Text>
        ) : (
          <Stack gap="xs">
            {availableProfiles.map(({ name, commands }) => (
              <Group key={name} justify="space-between" p="sm" style={{ border: "1px solid #e0e0e0", borderRadius: "4px" }}>
                <div>
                  <Text fw={500}>{name}</Text>
                  <Badge size="xs" variant="light">
                    {commands.length} commands
                  </Badge>
                </div>
                <Button
                  size="xs"
                  onClick={() => {
                    onSelect(name);
                    onClose();
                  }}
                >
                  Select
                </Button>
              </Group>
            ))}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
