import { useMutation, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { notifyError } from "../lib/notify";
import {
  createProfile,
  deleteProfile,
  renameProfile,
  updateProfile,
  duplicateProfile,
  exportProfile,
  createCommand,
  updateCommand,
  deleteCommand,
  duplicateCommand,
  moveCommand,
  exportConfig,
  parseDockerCompose,
  attachCommandToProfile,
  syncCommandsToProfile,
  type CommandInfo,
  type CommandInput,
} from "../lib/api";

function useInvalidateProfiles() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["profiles"] });
}

export function useCreateProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({ name, description }: { name: string; description?: string }) =>
      createProfile(name, description),
    onSuccess: (_data, { name }) => {
      notifications.show({ color: "green", message: `Created profile "${name}"` });
      return invalidate();
    },
    onError: notifyError("Failed to create profile"),
  });
}

export function useDeleteProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: (profile: string) => deleteProfile(profile),
    onSuccess: (_data, profile) => {
      notifications.show({ color: "green", message: `Deleted profile "${profile}"` });
      return invalidate();
    },
    onError: notifyError("Failed to delete profile"),
  });
}

export function useRenameProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      renameProfile(oldName, newName),
    onSuccess: (_data, { oldName, newName }) => {
      notifications.show({ color: "green", message: `Renamed "${oldName}" to "${newName}"` });
      return invalidate();
    },
    onError: notifyError("Failed to rename profile"),
  });
}

export function useUpdateProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({
      oldName,
      changes,
    }: {
      oldName: string;
      changes: { newName?: string; description?: string };
    }) => updateProfile(oldName, changes),
    onSuccess: (_data, { oldName, changes }) => {
      const label = changes.newName
        ? `'${oldName}' → '${changes.newName}'`
        : `profile "${oldName}"`;
      notifications.show({ color: "green", message: `Updated ${label}` });
      return invalidate();
    },
    onError: notifyError("Failed to update profile"),
  });
}

export function useDuplicateProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({ sourceName, newName }: { sourceName: string; newName: string }) =>
      duplicateProfile(sourceName, newName),
    onSuccess: (_data, { newName }) => {
      notifications.show({ color: "green", message: `Duplicated profile as "${newName}"` });
      return invalidate();
    },
    onError: notifyError("Failed to duplicate profile"),
  });
}

export function useExportProfile() {
  return useMutation({
    mutationFn: (profile: string) => exportProfile(profile),
    onSuccess: (_data, profile) => {
      notifications.show({ color: "green", message: `Exported profile "${profile}"` });
    },
    onError: notifyError("Failed to export profile"),
  });
}

export function useCreateCommand() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({ profile, input }: { profile: string; input: CommandInput }) =>
      createCommand(profile, input),
    onSuccess: (command) => {
      notifications.show({ color: "green", message: `Created command "${command.name}"` });
      return invalidate();
    },
    onError: notifyError("Failed to create command"),
  });
}

export function useUpdateCommand() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({
      profile,
      commandId,
      patch,
    }: {
      profile: string;
      commandId: string;
      patch: Partial<CommandInput>;
    }) => updateCommand(profile, commandId, patch),
    onSuccess: (command) => {
      notifications.show({ color: "green", message: `Updated command "${command.name}"` });
      return invalidate();
    },
    onError: notifyError("Failed to update command"),
  });
}

export function useDeleteCommand() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({ profile, commandId }: { profile: string; commandId: string }) =>
      deleteCommand(profile, commandId),
    onSuccess: () => {
      notifications.show({ color: "green", message: "Command deleted" });
      return invalidate();
    },
    onError: notifyError("Failed to delete command"),
  });
}

// --- Command movement, duplication, and export ---

export function useDuplicateCommand() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({
      sourceProfile,
      commandId,
      targetProfile,
    }: {
      sourceProfile: string;
      commandId: string;
      targetProfile: string;
    }) => duplicateCommand(sourceProfile, commandId, targetProfile),
    onSuccess: (command) => {
      notifications.show({
        color: "green",
        message: `Duplicated command to "${command.name}"`,
      });
      return invalidate();
    },
    onError: notifyError("Failed to duplicate command"),
  });
}

export function useMoveCommand() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({
      sourceProfile,
      commandId,
      targetProfile,
    }: {
      sourceProfile: string;
      commandId: string;
      targetProfile: string;
    }) => moveCommand(sourceProfile, commandId, targetProfile),
    onSuccess: (command) => {
      notifications.show({
        color: "green",
        message: `Moved command "${command.name}" to target profile`,
      });
      return invalidate();
    },
    onError: notifyError("Failed to move command"),
  });
}

export function useExportConfig() {
  return useMutation({
    mutationFn: exportConfig,
    onSuccess: (yaml: string) => {
      // Trigger browser download
      const blob = new Blob([yaml], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = ".conductor.yml";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      notifications.show({
        color: "green",
        message: "Configuration exported successfully",
      });
    },
    onError: notifyError("Failed to export config"),
  });
}

export function useParseDockerCompose() {
  return useMutation({
    mutationFn: (yamlText: string) => parseDockerCompose(yamlText),
    onError: notifyError("Failed to parse docker compose"),
  });
}

export function useAttachCommandToProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({ profileName, commandId }: { profileName: string; commandId: string }) =>
      attachCommandToProfile(commandId, profileName),
    onSuccess: (_data, variables) => {
      notifications.show({
        color: "green",
        message: `Added "${variables.commandId}" to ${variables.profileName}`,
      });
      return invalidate();
    },
    onError: notifyError("Failed to add command"),
  });
}

export function useSyncCommandsToProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({
      profileName,
      selectedCommands,
      allAvailable,
      currentMembership,
    }: {
      profileName: string;
      selectedCommands: Record<string, boolean>;
      allAvailable: CommandInfo[];
      currentMembership: Set<string>;
    }) => syncCommandsToProfile(profileName, selectedCommands, allAvailable, currentMembership),
    onSuccess: (_data, variables) => {
      notifications.show({
        color: "green",
        message: `Updated commands for profile "${variables.profileName}"`,
      });
      return invalidate();
    },
    onError: notifyError("Failed to update commands"),
  });
}
