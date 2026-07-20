import { useMutation, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import {
  createProfile,
  deleteProfile,
  createCommand,
  updateCommand,
  deleteCommand,
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
