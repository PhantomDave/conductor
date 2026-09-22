import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { notifyError } from "../lib/notify";
import {
  fetchEnvVars,
  upsertEnvVar,
  deleteEnvVar,
  importEnvVars,
  fetchBasePath,
  updateBasePath,
  fetchShells,
  updateDefaultShell,
  fetchLogRetention,
  updateLogRetention,
  pruneLogsNow,
  compileConfigExamples,
  importConfig,
} from "../lib/api";

export function useCompileConfigExamples() {
  return useMutation({
    mutationFn: compileConfigExamples,
    onSuccess: (report) => {
      if (report.errors > 0) {
        notifications.show({
          color: "orange",
          title: "Compiled with errors",
          message: `${report.created} created, ${report.skipped} skipped, ${report.errors} failed`,
        });
      } else {
        notifications.show({
          color: "green",
          message: `${report.created} file(s) created, ${report.skipped} already existed`,
        });
      }
    },
    onError: notifyError("Failed to compile config files"),
  });
}

export function useBasePath() {
  return useQuery({
    queryKey: ["base-path"],
    queryFn: fetchBasePath,
  });
}

export function useUpdateBasePath() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateBasePath,
    onSuccess: () => {
      notifications.show({ color: "green", message: "Base path updated" });
      // Returned so the mutation (and any per-call onSuccess) settles only
      // once the fresh value is in the cache.
      return queryClient.invalidateQueries({ queryKey: ["base-path"] });
    },
    onError: notifyError("Failed to update base path"),
  });
}

export function useShells() {
  return useQuery({
    queryKey: ["shells"],
    queryFn: fetchShells,
  });
}

export function useUpdateDefaultShell() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateDefaultShell,
    onSuccess: () => {
      notifications.show({ color: "green", message: "Default shell updated" });
      // Returned so the mutation (and any per-call onSuccess) settles only
      // once the fresh value is in the cache.
      return queryClient.invalidateQueries({ queryKey: ["shells"] });
    },
    onError: notifyError("Failed to update default shell"),
  });
}

export function useLogRetention() {
  return useQuery({
    queryKey: ["log-retention"],
    queryFn: fetchLogRetention,
  });
}

export function useUpdateLogRetention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateLogRetention,
    onSuccess: () => {
      notifications.show({ color: "green", message: "Log retention updated" });
      return queryClient.invalidateQueries({ queryKey: ["log-retention"] });
    },
    onError: notifyError("Failed to update log retention"),
  });
}

export function usePruneLogsNow() {
  return useMutation({
    mutationFn: pruneLogsNow,
    onSuccess: (result) => {
      notifications.show({
        color: "green",
        message: `Pruned ${result.logs_deleted} log(s) by age, ${result.sessions_pruned_logs} log(s) by session limit`,
      });
    },
    onError: notifyError("Failed to prune logs"),
  });
}

export function useEnvVars(scope: "global" | "profile", profile?: string) {
  return useQuery({
    queryKey: ["env", scope, profile],
    queryFn: () => fetchEnvVars(scope, profile),
    enabled: scope === "global" || Boolean(profile),
  });
}

function useInvalidateEnv() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["env"] });
}

export function useUpsertEnvVar() {
  const invalidate = useInvalidateEnv();
  return useMutation({
    mutationFn: upsertEnvVar,
    onSuccess: (_data, vars) => {
      notifications.show({ color: "green", message: `Saved "${vars.key}"` });
      return invalidate();
    },
    onError: notifyError("Failed to save env var"),
  });
}

export function useDeleteEnvVar() {
  const invalidate = useInvalidateEnv();
  return useMutation({
    mutationFn: deleteEnvVar,
    onSuccess: () => {
      notifications.show({ color: "green", message: "Deleted" });
      return invalidate();
    },
    onError: notifyError("Failed to delete env var"),
  });
}

export function useImportEnvVars() {
  const invalidate = useInvalidateEnv();
  return useMutation({
    mutationFn: importEnvVars,
    onSuccess: (count) => {
      notifications.show({ color: "green", message: `Imported ${count} variable(s)` });
      return invalidate();
    },
    onError: notifyError("Failed to import env vars"),
  });
}

export function useImportConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: importConfig,
    onSuccess: (config) => {
      notifications.show({
        color: "green",
        message: `Imported "${config.name ?? "config"}" - ${Object.keys(config.profiles).length} profile(s)`,
      });
      // Everything the imported config could have changed - profiles,
      // commands, base_path, default_shell - needs a fresh fetch.
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ["profiles"] }),
        queryClient.invalidateQueries({ queryKey: ["base-path"] }),
        queryClient.invalidateQueries({ queryKey: ["shells"] }),
      ]);
    },
    onError: notifyError("Failed to import config"),
  });
}
