import { useMutation, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { notifyError } from "../lib/notify";
import {
  executeCommand,
  restartCommand,
  runProfile,
  stopProfile,
  stopProcess,
  type ProcessInfo,
} from "../lib/api";

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
    onError: notifyError("Failed to start command"),
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
    onError: notifyError("Failed to run profile"),
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
    onError: notifyError("Failed to stop profile"),
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
    onError: notifyError("Failed to stop process"),
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
    onError: notifyError("Failed to stop processes"),
    onSettled: () => {
      return invalidate();
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
      return invalidate();
    },
    onError: notifyError("Failed to restart command"),
  });
}
