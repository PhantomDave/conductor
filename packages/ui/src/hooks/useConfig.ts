import { useMutation, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import {
  createProfile,
  deleteProfile,
  renameProfile,
  duplicateProfile,
  exportProfile,
  createCommand,
  updateCommand,
  deleteCommand,
  duplicateCommand,
  moveCommand,
  exportConfig,
  parseDockerCompose,
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
      invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to create profile",
        message: error.message,
      });
    },
  });
}

export function useDeleteProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: (profile: string) => deleteProfile(profile),
    onSuccess: (_data, profile) => {
      notifications.show({ color: "green", message: `Deleted profile "${profile}"` });
      invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to delete profile",
        message: error.message,
      });
    },
  });
}

export function useRenameProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      renameProfile(oldName, newName),
    onSuccess: (_data, { oldName, newName }) => {
      notifications.show({ color: "green", message: `Renamed "${oldName}" to "${newName}"` });
      invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to rename profile",
        message: error.message,
      });
    },
  });
}

export function useDuplicateProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({ sourceName, newName }: { sourceName: string; newName: string }) =>
      duplicateProfile(sourceName, newName),
    onSuccess: (_data, { newName }) => {
      notifications.show({ color: "green", message: `Duplicated profile as "${newName}"` });
      invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to duplicate profile",
        message: error.message,
      });
    },
  });
}

export function useExportProfile() {
  return useMutation({
    mutationFn: (profile: string) => exportProfile(profile),
    onSuccess: (_data, profile) => {
      notifications.show({ color: "green", message: `Exported profile "${profile}"` });
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to export profile",
        message: error.message,
      });
    },
  });
}

export function useCreateCommand() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({ profile, input }: { profile: string; input: CommandInput }) =>
      createCommand(profile, input),
    onSuccess: (command) => {
      notifications.show({ color: "green", message: `Created command "${command.name}"` });
      invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to create command",
        message: error.message,
      });
    },
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
      invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to update command",
        message: error.message,
      });
    },
  });
}

export function useDeleteCommand() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({ profile, commandId }: { profile: string; commandId: string }) =>
      deleteCommand(profile, commandId),
    onSuccess: () => {
      notifications.show({ color: "green", message: "Command deleted" });
      invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to delete command",
        message: error.message,
      });
    },
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
      invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to duplicate command",
        message: error.message,
      });
    },
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
      invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to move command",
        message: error.message,
      });
    },
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
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to export config",
        message: error.message,
      });
    },
  });
}

export function useParseDockerCompose() {
  return useMutation({
    mutationFn: (yamlText: string) => parseDockerCompose(yamlText),
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to parse docker compose",
        message: error.message,
      });
    },
  });
}
