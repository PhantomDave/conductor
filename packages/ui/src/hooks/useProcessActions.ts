import { useMutation, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import {
  executeCommand,
  restartCommand,
  runProfile,
  stopProfile,
  stopProcess,
  type ProcessInfo,
} from "../lib/api";

// Mutation callbacks return this promise so each mutation settles only once
// the refetched data is in the cache (TanStack Query awaits it).
function useInvalidateProcesses() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["processes"] });
}

export function useExecuteCommand() {
  const invalidate = useInvalidateProcesses();
  return useMutation({
    mutationFn: ({ profile, commandId }: { profile: string; commandId: string }) =>
      executeCommand(profile, commandId),
    onSuccess: (_data, { profile, commandId }) => {
      notifications.show({ color: "green", message: `Started "${commandId}" (${profile})` });
      return invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to start command",
        message: error.message,
      });
    },
  });
}

export function useRunProfile() {
  const invalidate = useInvalidateProcesses();
  return useMutation({
    mutationFn: (profile: string) => runProfile(profile),
    onSuccess: (_data, profile) => {
      notifications.show({ color: "green", message: `Started all commands in "${profile}"` });
      return invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to run profile",
        message: error.message,
      });
    },
  });
}

export function useStopProfile() {
  const invalidate = useInvalidateProcesses();
  return useMutation({
    mutationFn: (profile: string) => stopProfile(profile),
    onSuccess: (_data, profile) => {
      notifications.show({ color: "green", message: `Stopped "${profile}"` });
      return invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to stop profile",
        message: error.message,
      });
    },
  });
}

export function useStopProcess() {
  const invalidate = useInvalidateProcesses();
  return useMutation({
    mutationFn: (pid: number) => stopProcess(pid),
    onSuccess: (_data, pid) => {
      notifications.show({ color: "green", message: `Stopped process ${pid}` });
      return invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to stop process",
        message: error.message,
      });
    },
  });
}

export function useStopAllProcesses() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateProcesses();

  return useMutation({
    mutationFn: async () => {
      const targets = (queryClient.getQueryData<ProcessInfo[]>(["processes"]) ?? []).filter(
        (process) => process.status === "running" || process.status === "starting",
      );
      await Promise.all(targets.map((process) => stopProcess(process.pid)));
      return targets.length;
    },
    onSuccess: (count) => {
      notifications.show({
        color: "green",
        message: `Stopped ${count} process${count === 1 ? "" : "es"}`,
      });
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to stop processes",
        message: error.message,
      });
    },
    // Refresh after success and failure alike: some of the stops may have landed.
    onSettled: () => invalidate(),
  });
}

export function useRestartCommand() {
  const invalidate = useInvalidateProcesses();
  return useMutation({
    mutationFn: ({ profile, commandId }: { profile: string; commandId: string }) =>
      restartCommand(profile, commandId),
    onSuccess: (_data, { commandId }) => {
      notifications.show({ color: "green", message: `Restarted "${commandId}"` });
      return invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to restart command",
        message: error.message,
      });
    },
  });
}
