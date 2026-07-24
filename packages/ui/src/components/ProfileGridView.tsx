import { useState } from "react";
import {
  Stack,
  Text,
  Card,
  SimpleGrid,
  Group,
  Button,
  Modal,
  TextInput,
  Textarea,
} from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useProfiles } from "../hooks/useProfiles";
import {
  useCreateProfile,
  useRenameProfile,
  useDuplicateProfile,
  useDeleteProfile,
  useExportProfile,
} from "../hooks/useConfig";
import { ProfileCard } from "./ProfileCard";

export function ProfileGridView() {
  const { data: profiles, isLoading, error } = useProfiles();

  // Modal states
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [duplicateModalOpen, setDuplicateModalOpen] = useState(false);

  // Form states
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileDesc, setNewProfileDesc] = useState("");
  const [renameOldName, setRenameOldName] = useState("");
  const [renameNewName, setRenameNewName] = useState("");
  const [duplicateSourceName, setDuplicateSourceName] = useState("");
  const [duplicateNewName, setDuplicateNewName] = useState("");

  // Mutations
  const createMutation = useCreateProfile();
  const renameMutation = useRenameProfile();
  const duplicateMutation = useDuplicateProfile();
  const deleteMutation = useDeleteProfile();
  const exportMutation = useExportProfile();

  // Handlers
  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) return;
    try {
      await createMutation.mutateAsync({
        name: newProfileName.trim(),
        description: newProfileDesc.trim() || undefined,
      });
      setCreateModalOpen(false);
      setNewProfileName("");
      setNewProfileDesc("");
    } catch {
      // Error notification handled by hook
    }
  };

  const handleRenameProfile = async () => {
    if (!renameNewName.trim()) return;
    try {
      await renameMutation.mutateAsync({
        oldName: renameOldName,
        newName: renameNewName.trim(),
      });
      setRenameModalOpen(false);
      setRenameOldName("");
      setRenameNewName("");
    } catch {
      // Error notification handled by hook
    }
  };

  const handleDuplicateProfile = async () => {
    if (!duplicateNewName.trim()) return;
    try {
      await duplicateMutation.mutateAsync({
        sourceName: duplicateSourceName,
        newName: duplicateNewName.trim(),
      });
      setDuplicateModalOpen(false);
      setDuplicateSourceName("");
      setDuplicateNewName("");
    } catch {
      // Error notification handled by hook
    }
  };

  const handleDeleteProfile = async (profileName: string) => {
    if (window.confirm(`Are you sure you want to delete profile "${profileName}"?`)) {
      try {
        await deleteMutation.mutateAsync(profileName);
      } catch {
        // Error notification handled by hook
      }
    }
  };

  const handleExportProfile = async (profileName: string) => {
    try {
      const yaml = await exportMutation.mutateAsync(profileName);
      // Create and trigger download
      const blob = new Blob([yaml], { type: "application/x-yaml" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${profileName}.conductor.yml`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Error notification handled by hook
    }
  };

  if (isLoading) return <Text c="dimmed">Loading profiles...</Text>;
  if (error) {
    return <Text c="red">Could not reach Conductor core API. Is `bun run dev:core` running?</Text>;
  }

  if (!profiles || Object.keys(profiles).length === 0) {
    return (
      <Card withBorder padding="lg">
        <Stack gap="md">
          <Text c="dimmed">No profiles configured yet. Create one to get started.</Text>
          <Button
            leftSection={<IconPlus size={16} />}
            fullWidth
            onClick={() => setCreateModalOpen(true)}
          >
            New Profile
          </Button>
        </Stack>
      </Card>
    );
  }

  const profileEntries = Object.entries(profiles);

  return (
    <>
      <Stack gap="lg">
        <Group justify="space-between" align="center">
          <Text fw={600} size="md">
            Profiles ({profileEntries.length})
          </Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() => setCreateModalOpen(true)}
          >
            New Profile
          </Button>
        </Group>

        <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 4 }} spacing="md">
          {profileEntries.map(([name, profile]) => (
            <ProfileCard
              key={name}
              name={name}
              profile={profile}
              commandCount={profile.commands?.length ?? 0}
              onSelect={(profileName) => {
                // Switch to commands tab for this profile (future phase)
                console.log("Select profile:", profileName);
              }}
              onRename={(oldName) => {
                setRenameOldName(oldName);
                setRenameNewName(oldName);
                setRenameModalOpen(true);
              }}
              onDuplicate={(profileName) => {
                setDuplicateSourceName(profileName);
                setDuplicateNewName(`${profileName}-copy`);
                setDuplicateModalOpen(true);
              }}
              onDelete={(profileName) => {
                handleDeleteProfile(profileName);
              }}
              onExport={(profileName) => {
                handleExportProfile(profileName);
              }}
            />
          ))}
        </SimpleGrid>
      </Stack>

      {/* Create Profile Modal */}
      <Modal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Create New Profile"
      >
        <Stack gap="md">
          <TextInput
            label="Profile Name"
            placeholder="e.g., development, staging"
            value={newProfileName}
            onChange={(e) => setNewProfileName(e.currentTarget.value)}
          />
          <Textarea
            label="Description (optional)"
            placeholder="Brief description of this profile..."
            value={newProfileDesc}
            onChange={(e) => setNewProfileDesc(e.currentTarget.value)}
            rows={3}
          />
          <Group justify="flex-end" gap="sm">
            <Button
              variant="light"
              onClick={() => {
                setCreateModalOpen(false);
                setNewProfileName("");
                setNewProfileDesc("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateProfile}
              loading={createMutation.isPending}
              disabled={!newProfileName.trim()}
            >
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Rename Profile Modal */}
      <Modal
        opened={renameModalOpen}
        onClose={() => setRenameModalOpen(false)}
        title="Rename Profile"
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            From: <strong>{renameOldName}</strong>
          </Text>
          <TextInput
            label="New Name"
            placeholder="New profile name..."
            value={renameNewName}
            onChange={(e) => setRenameNewName(e.currentTarget.value)}
          />
          <Group justify="flex-end" gap="sm">
            <Button
              variant="light"
              onClick={() => {
                setRenameModalOpen(false);
                setRenameOldName("");
                setRenameNewName("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRenameProfile}
              loading={renameMutation.isPending}
              disabled={!renameNewName.trim() || renameNewName === renameOldName}
            >
              Rename
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Duplicate Profile Modal */}
      <Modal
        opened={duplicateModalOpen}
        onClose={() => setDuplicateModalOpen(false)}
        title="Duplicate Profile"
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Duplicating: <strong>{duplicateSourceName}</strong>
          </Text>
          <TextInput
            label="New Profile Name"
            placeholder="New profile name..."
            value={duplicateNewName}
            onChange={(e) => setDuplicateNewName(e.currentTarget.value)}
          />
          <Group justify="flex-end" gap="sm">
            <Button
              variant="light"
              onClick={() => {
                setDuplicateModalOpen(false);
                setDuplicateSourceName("");
                setDuplicateNewName("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleDuplicateProfile}
              loading={duplicateMutation.isPending}
              disabled={!duplicateNewName.trim()}
            >
              Duplicate
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
