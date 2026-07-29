import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { fetchAllCommands, updateStandaloneCommand, deleteStandaloneCommand, createStandaloneCommand, type CommandInput } from "../lib/api";

export function useCommandLibrary() {
  const queryClient = useQueryClient();

  const commandsQuery = useQuery({
    queryKey: ["command-library"],
    queryFn: fetchAllCommands,
    staleTime: 30_000,
  });

  const addMutation = useMutation({
    mutationFn: (input: Omit<CommandInput, "id">) => createStandaloneCommand(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["command-library"] });
    },
    onError: (error: Error) => {
      notifications.show({ color: "red", title: "Failed to create command", message: error.message });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<CommandInput> }) => updateStandaloneCommand(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["command-library"] });
    },
    onError: (error: Error) => {
      notifications.show({ color: "red", title: "Failed to update command", message: error.message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteStandaloneCommand(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["command-library"] });
    },
    onError: (error: Error) => {
      notifications.show({ color: "red", title: "Failed to delete command", message: error.message });
    },
  });

  return {
    commands: commandsQuery.data ?? {},
    isLoading: commandsQuery.isLoading,
    error: commandsQuery.error,
    addItem: addMutation.mutate,
    updateItem: updateMutation.mutate,
    deleteItem: deleteMutation.mutate,
  };
}
