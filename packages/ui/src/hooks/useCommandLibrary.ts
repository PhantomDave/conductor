import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifyError } from "../lib/notify";
import {
  fetchAllCommands,
  updateStandaloneCommand,
  deleteStandaloneCommand,
  createStandaloneCommand,
  type CommandInput,
} from "../lib/api";

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
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ["command-library"] }),
        queryClient.invalidateQueries({ queryKey: ["profiles"] }),
      ]);
    },
    onError: notifyError("Failed to create command"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<CommandInput> }) =>
      updateStandaloneCommand(id, patch),
    onSuccess: () => {
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ["command-library"] }),
        queryClient.invalidateQueries({ queryKey: ["profiles"] }),
      ]);
    },
    onError: notifyError("Failed to update command"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteStandaloneCommand(id),
    onSuccess: () => {
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ["command-library"] }),
        queryClient.invalidateQueries({ queryKey: ["profiles"] }),
      ]);
    },
    onError: notifyError("Failed to delete command"),
  });

  return {
    commands: commandsQuery.data ?? [],
    isLoading: commandsQuery.isLoading,
    error: commandsQuery.error,
    addItem: addMutation.mutate,
    updateItem: updateMutation.mutate,
    deleteItem: deleteMutation.mutate,
  };
}
