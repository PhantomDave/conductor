import { useMutation, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { executeCommand, restartCommand, runProfile, stopProfile, stopProcess } from "../lib/api";

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
      invalidate();
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
      invalidate();
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
      invalidate();
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
      invalidate();
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

export function useRestartCommand() {
  const invalidate = useInvalidateProcesses();
  return useMutation({
    mutationFn: ({ profile, commandId }: { profile: string; commandId: string }) =>
      restartCommand(profile, commandId),
    onSuccess: (_data, { commandId }) => {
      notifications.show({ color: "green", message: `Restarted "${commandId}"` });
      invalidate();
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
