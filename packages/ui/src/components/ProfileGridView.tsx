import { useState } from "react";
import {
  Stack,
  Text,
  Card,
  SimpleGrid,
  Group,
  Button,
  Modal,
  Table,
  TextInput,
  Textarea,
} from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useProfiles } from "../hooks/useProfiles";
import { useRunProfile } from "../hooks/useProcessActions";
import {
  useCreateProfile,
  useUpdateProfile,
  useDuplicateProfile,
  useDeleteProfile,
  useExportProfile,
} from "../hooks/useConfig";
import { ProfileCard } from "./ProfileCard";
import type { ProfileInfo } from "../lib/api";

export function ProfileGridView() {
  const { data: profiles, isLoading, error } = useProfiles();

  // Modal states
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [duplicateModalOpen, setDuplicateModalOpen] = useState(false);
  const [viewProfileName, setViewProfileName] = useState<string | null>(null);

  // Form states
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileDesc, setNewProfileDesc] = useState("");
  const [editTargetName, setEditTargetName] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [duplicateSourceName, setDuplicateSourceName] = useState("");
  const [duplicateNewName, setDuplicateNewName] = useState("");

  // Confirmation modal state (shared with delete)
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);

  // Mutations
  const createMutation = useCreateProfile();
  const updateMutation = useUpdateProfile();
  const duplicateMutation = useDuplicateProfile();
  const deleteMutation = useDeleteProfile();
  const exportMutation = useExportProfile();
  const runMutation = useRunProfile();

  // Handlers
  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) return;
    await createMutation.mutateAsync({
      name: newProfileName.trim(),
      description: newProfileDesc || undefined,
    });
    setCreateModalOpen(false);
    setNewProfileName("");
    setNewProfileDesc("");
  };

  const handleEditProfile = async () => {
    if (!editName.trim()) return;
    const changes: { newName?: string; description?: string } = {};
    if (editName !== editTargetName) changes.newName = editName;
    if (editDescription !== profiles?.[editTargetName]?.description)
      changes.description = editDescription || undefined;
    // If nothing changed, just close the modal
    if (Object.keys(changes).length === 0) {
      setEditModalOpen(false);
      return;
    }
    await updateMutation.mutateAsync({ oldName: editTargetName, changes });
    setEditModalOpen(false);
    setEditTargetName("");
  };

  const handleDuplicateProfile = async () => {
    if (!duplicateNewName.trim()) return;
    await duplicateMutation.mutateAsync({
      sourceName: duplicateSourceName,
      newName: duplicateNewName.trim(),
    });
    setDuplicateModalOpen(false);
    setDuplicateSourceName("");
    setDuplicateNewName("");
  };

  const handleDeleteProfile = async () => {
    if (!confirmTarget) return;
    await deleteMutation.mutateAsync(confirmTarget);
    setConfirmTarget(null);
  };

  const handleExportProfile = async (profileName: string) => {
    const yaml = await exportMutation.mutateAsync(profileName);
    const blob = new Blob([yaml], { type: "application/x-yaml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${profileName}.conductor.yml`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleRunProfile = async (profileName: string) => {
    await runMutation.mutateAsync(profileName);
  };

  if (isLoading) return <Text c="dimmed">Loading profiles...</Text>;
  if (error) {
    return <Text c="red">Could not reach Conductor core API. Is `bun run dev:core` running?</Text>;
  }

  const profileEntries = profiles ? Object.entries(profiles) : [];

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

        {profileEntries.length === 0 ? (
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
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 4 }} spacing="md">
            {profileEntries.map(([name, profile]) => (
              <ProfileCard
                key={name}
                name={name}
                profile={profile}
                commandCount={profile.commands?.length ?? 0}
                onView={(profileName) => setViewProfileName(profileName)}
                onEdit={(profileName) => {
                  const p = profiles?.[profileName];
                  setEditTargetName(profileName);
                  setEditName(profileName);
                  setEditDescription(p?.description ?? "");
                  setEditModalOpen(true);
                }}
                onDuplicate={(profileName) => {
                  setDuplicateSourceName(profileName);
                  setDuplicateNewName(`${profileName}-copy`);
                  setDuplicateModalOpen(true);
                }}
                onDelete={(profileName) => setConfirmTarget(profileName)}
                onExport={handleExportProfile}
                onRun={() => handleRunProfile(name)}
              />
            ))}
          </SimpleGrid>
        )}
      </Stack>

      {/* ── Create Profile Modal ── */}
      <Modal
        title="Create New Profile"
        opened={createModalOpen}
        onClose={() => {
          setCreateModalOpen(false);
          setNewProfileName("");
          setNewProfileDesc("");
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreateProfile();
          }}
        >
          <Stack gap="md">
            <TextInput
              label="Profile Name"
              placeholder="e.g., development, staging"
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.currentTarget.value)}
              autoFocus
              required
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
                type="submit"
                disabled={!newProfileName.trim()}
                loading={createMutation.isPending}
              >
                Create
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      {/* ── Edit Profile Modal ── */}
      {editTargetName && (
        <Modal title="Edit Profile" opened={editModalOpen} onClose={() => setEditModalOpen(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleEditProfile();
            }}
          >
            <Stack gap="md">
              <TextInput
                label="Profile Name"
                placeholder="Profile name..."
                value={editName}
                onChange={(e) => setEditName(e.currentTarget.value)}
                autoFocus
              />
              <Textarea
                label="Description (optional)"
                placeholder="Brief description of this profile..."
                value={editDescription}
                onChange={(e) => setEditDescription(e.currentTarget.value)}
                rows={3}
              />
              <Group justify="flex-end" gap="sm">
                <Button
                  variant="light"
                  onClick={() => {
                    setEditModalOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={updateMutation.isPending}>
                  Save
                </Button>
              </Group>
            </Stack>
          </form>
        </Modal>
      )}

      {/* ── Duplicate Profile Modal ── */}
      <Modal
        title="Duplicate Profile"
        opened={duplicateModalOpen}
        onClose={() => {
          setDuplicateModalOpen(false);
          setDuplicateSourceName("");
          setDuplicateNewName("");
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleDuplicateProfile();
          }}
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
              autoFocus
            />
            <Group justify="flex-end" gap="sm">
              <Button
                variant="light"
                onClick={() => {
                  setDuplicateModalOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!duplicateNewName.trim()}
                loading={duplicateMutation.isPending}
              >
                Duplicate
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      {/* ── Confirmation Modal (delete) ── */}
      {confirmTarget && (
        <Modal
          title="Delete Profile"
          opened={Boolean(confirmTarget)}
          onClose={() => setConfirmTarget(null)}
        >
          <Stack gap="lg">
            <Text size="sm">
              Are you sure you want to delete profile "{confirmTarget}"? This cannot be undone.
            </Text>
            <Group justify="flex-end" gap="sm">
              <Button variant="subtle" onClick={() => setConfirmTarget(null)}>
                Cancel
              </Button>
              <Button color="red" onClick={handleDeleteProfile} loading={deleteMutation.isPending}>
                Delete
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}

      {/* ── Commands Modal ── */}
      {viewProfileName && profiles?.[viewProfileName] ? (
        <CommandsModal
          profileName={viewProfileName}
          commands={profiles[viewProfileName].commands}
          opened={Boolean(viewProfileName)}
          onClose={() => setViewProfileName(null)}
        />
      ) : null}
    </>
  );
}

function CommandsModal({
  profileName,
  commands,
  opened,
  onClose,
}: {
  readonly profileName: string;
  readonly commands: ProfileInfo["commands"];
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  return (
    <Modal title={profileName} size="lg" centered opened={opened} onClose={onClose}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Profile: <strong>{profileName}</strong> &ndash; {commands.length} command
          {commands.length !== 1 ? "s" : ""}
        </Text>
        {commands.length === 0 ? (
          <Text c="dimmed">This profile has no commands yet.</Text>
        ) : (
          <Table withTableBorder withColumnBorders striped variant="cover">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>ID</Table.Th>
                <Table.Th>Name</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th>CWD</Table.Th>
                <Table.Th>Deps</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {commands.map((cmd) => (
                <Table.Tr key={cmd.id}>
                  <Table.Td>
                    <code>{cmd.id}</code>
                  </Table.Td>
                  <Table.Td>{cmd.name}</Table.Td>
                  <Table.Td>{cmd.description ?? "—"}</Table.Td>
                  <Table.Td>{cmd.cwd ?? "—"}</Table.Td>
                  <Table.Td>{cmd.deps.length ? cmd.deps.join(", ") : "—"}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Modal>
  );
}
