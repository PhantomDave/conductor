import { useState } from "react";
import {
  Accordion,
  Badge,
  Button,
  Group,
  Stack,
  Text,
  Card,
  ActionIcon,
  TextInput,
  Modal,
  Menu,
} from "@mantine/core";
import {
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconPencil,
  IconTrash,
  IconCopy,
  IconArrowRight,
  IconDownload,
  IconUpload,
  IconChevronDown,
} from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";
import { useProfiles } from "../hooks/useProfiles";
import { useExecuteCommand, useRunProfile, useStopProfile } from "../hooks/useProcessActions";
import {
  useCreateProfile,
  useDeleteCommand,
  useDuplicateCommand,
  useMoveCommand,
  useExportConfig,
  useCreateCommand,
} from "../hooks/useConfig";
import { CommandForm } from "./CommandForm";
import { ProfilePickerModal } from "./ProfilePickerModal";
import { DockerComposeImporter } from "./DockerComposeImporter";
import type { CommandInfo, SuggestedCommand } from "../lib/api";

export function CommandLibrary() {
  const { data: profiles, isLoading, error } = useProfiles();
  const executeCommand = useExecuteCommand();
  const runProfile = useRunProfile();
  const stopProfile = useStopProfile();
  const deleteCommand = useDeleteCommand();
  const createProfile = useCreateProfile();
  const duplicateCommand = useDuplicateCommand();
  const moveCommand = useMoveCommand();
  const exportConfig = useExportConfig();
  const createCommand = useCreateCommand();

  const [formState, setFormState] = useState<{
    profile: string;
    editing?: CommandInfo | null;
  } | null>(null);
  const [profileModalOpen, profileModalHandlers] = useDisclosure(false);
  const [newProfileName, setNewProfileName] = useState("");

  // Duplicate/Move modals
  const [duplicateState, setDuplicateState] = useState<{
    sourceProfile: string;
    commandId: string;
  } | null>(null);
  const [moveState, setMoveState] = useState<{
    sourceProfile: string;
    commandId: string;
  } | null>(null);

  // docker compose importer
  const [dockerImporterOpen, dockerImporterHandlers] = useDisclosure(false);

  if (isLoading) return <Text c="dimmed">Loading command library...</Text>;
  if (error) return <Text c="red">Could not load profiles: {(error as Error).message}</Text>;

  const entries = Object.entries(profiles ?? {});

  const submitNewProfile = () => {
    if (!newProfileName.trim()) return;
    createProfile.mutate(
      { name: newProfileName.trim() },
      {
        onSuccess: () => {
          profileModalHandlers.close();
          setNewProfileName("");
        },
      },
    );
  };

  const handleDuplicateCommand = (targetProfile: string) => {
    if (duplicateState) {
      duplicateCommand.mutate({
        sourceProfile: duplicateState.sourceProfile,
        commandId: duplicateState.commandId,
        targetProfile,
      });
      setDuplicateState(null);
    }
  };

  const handleMoveCommand = (targetProfile: string) => {
    if (moveState) {
      moveCommand.mutate({
        sourceProfile: moveState.sourceProfile,
        commandId: moveState.commandId,
        targetProfile,
      });
      setMoveState(null);
    }
  };

  const handleImportCommands = (profile: string, suggestedCommands: SuggestedCommand[]) => {
    suggestedCommands.forEach((cmd) => {
      createCommand.mutate({
        profile,
        input: {
          name: cmd.name,
          run: cmd.run,
          stop_command: cmd.stop_command,
          deps: cmd.deps,
          healthcheck: cmd.healthcheck,
        },
      });
    });
  };

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Group>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={profileModalHandlers.open}
          >
            New profile
          </Button>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconUpload size={14} />}
            onClick={dockerImporterHandlers.open}
          >
            Import docker compose
          </Button>
        </Group>
        <Button
          size="xs"
          color="blue"
          leftSection={<IconDownload size={14} />}
          onClick={() => exportConfig.mutate()}
          loading={exportConfig.isPending}
        >
          Export conductor.yml
        </Button>
      </Group>

      {entries.length === 0 ? (
        <Card withBorder padding="lg">
          <Text c="dimmed">No profiles configured yet. Create one to get started.</Text>
        </Card>
      ) : (
        <Accordion variant="separated" defaultValue={entries[0]?.[0]}>
          {entries.map(([profileName, profile]) => (
            <Accordion.Item key={profileName} value={profileName}>
              <Accordion.Control>
                <Group justify="space-between" pr="md">
                  <div>
                    <Text fw={600}>{profileName}</Text>
                    {profile.description && (
                      <Text size="xs" c="dimmed">
                        {profile.description}
                      </Text>
                    )}
                  </div>
                  <Badge variant="light">{profile.commands.length} commands</Badge>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack gap="xs">
                  <Group>
                    <Button
                      size="xs"
                      leftSection={<IconPlayerPlay size={14} />}
                      loading={runProfile.isPending}
                      onClick={() => runProfile.mutate(profileName)}
                    >
                      Run all
                    </Button>
                    <Button
                      size="xs"
                      color="red"
                      variant="light"
                      leftSection={<IconPlayerStop size={14} />}
                      loading={stopProfile.isPending}
                      onClick={() => stopProfile.mutate(profileName)}
                    >
                      Stop all
                    </Button>
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconPlus size={14} />}
                      onClick={() => setFormState({ profile: profileName, editing: null })}
                    >
                      Add command
                    </Button>
                  </Group>

                  {profile.commands.map((command) => (
                    <Group key={command.id} justify="space-between" wrap="nowrap">
                      <div>
                        <Group gap={6}>
                          <Text size="sm">{command.name}</Text>
                          {command.healthcheck && command.healthcheck.type !== "none" && (
                            <Badge size="xs" variant="dot" color="blue">
                              {command.healthcheck.type} healthcheck
                            </Badge>
                          )}
                          {command.deps.length > 0 && (
                            <Badge size="xs" variant="light" color="grape">
                              deps: {command.deps.join(", ")}
                            </Badge>
                          )}
                        </Group>
                        {command.description && (
                          <Text size="xs" c="dimmed">
                            {command.description}
                          </Text>
                        )}
                      </div>
                      <Group gap={4} wrap="nowrap">
                        <Button
                          size="xs"
                          variant="light"
                          leftSection={<IconPlayerPlay size={14} />}
                          loading={
                            executeCommand.isPending &&
                            executeCommand.variables?.commandId === command.id
                          }
                          onClick={() =>
                            executeCommand.mutate({
                              profile: profileName,
                              commandId: command.id,
                            })
                          }
                        >
                          Run
                        </Button>
                        <Menu position="bottom-end">
                          <Menu.Target>
                            <ActionIcon variant="subtle">
                              <IconChevronDown size={16} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item
                              leftSection={<IconPencil size={14} />}
                              onClick={() =>
                                setFormState({ profile: profileName, editing: command })
                              }
                            >
                              Edit
                            </Menu.Item>
                            <Menu.Item
                              leftSection={<IconCopy size={14} />}
                              onClick={() =>
                                setDuplicateState({
                                  sourceProfile: profileName,
                                  commandId: command.id,
                                })
                              }
                            >
                              Duplicate to...
                            </Menu.Item>
                            <Menu.Item
                              leftSection={<IconArrowRight size={14} />}
                              onClick={() =>
                                setMoveState({
                                  sourceProfile: profileName,
                                  commandId: command.id,
                                })
                              }
                            >
                              Move to...
                            </Menu.Item>
                            <Menu.Divider />
                            <Menu.Item
                              leftSection={<IconTrash size={14} />}
                              color="red"
                              loading={
                                deleteCommand.isPending &&
                                deleteCommand.variables?.commandId === command.id
                              }
                              onClick={() =>
                                deleteCommand.mutate({
                                  profile: profileName,
                                  commandId: command.id,
                                })
                              }
                            >
                              Delete
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Group>
                    </Group>
                  ))}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      )}

      {formState && (
        <CommandForm
          opened
          onClose={() => setFormState(null)}
          profile={formState.profile}
          existingCommands={profiles?.[formState.profile]?.commands ?? []}
          editing={formState.editing}
        />
      )}

      <Modal opened={profileModalOpen} onClose={profileModalHandlers.close} title="New profile">
        <Stack>
          <TextInput
            label="Name"
            placeholder="backend"
            value={newProfileName}
            onChange={(e) => setNewProfileName(e.currentTarget.value)}
          />
          <Button loading={createProfile.isPending} onClick={submitNewProfile}>
            Create
          </Button>
        </Stack>
      </Modal>

      <ProfilePickerModal
        opened={!!duplicateState}
        onClose={() => setDuplicateState(null)}
        profiles={profiles}
        excludeProfile={duplicateState?.sourceProfile}
        onSelect={handleDuplicateCommand}
        title="Duplicate command to..."
        description="Select the target profile where you want to create a copy of this command."
      />

      <ProfilePickerModal
        opened={!!moveState}
        onClose={() => setMoveState(null)}
        profiles={profiles}
        excludeProfile={moveState?.sourceProfile}
        onSelect={handleMoveCommand}
        title="Move command to..."
        description="Select the target profile where you want to move this command."
      />

      <DockerComposeImporter
        opened={dockerImporterOpen}
        onClose={dockerImporterHandlers.close}
        onImport={handleImportCommands}
        profiles={profiles}
      />
    </Stack>
  );
}
