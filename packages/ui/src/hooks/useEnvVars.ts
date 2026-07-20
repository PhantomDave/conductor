import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import {
  fetchEnvVars,
  upsertEnvVar,
  deleteEnvVar,
  importEnvVars,
  fetchBasePath,
  updateBasePath,
  fetchShells,
  updateDefaultShell,
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
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to compile config files",
        message: error.message,
      });
    },
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
      queryClient.invalidateQueries({ queryKey: ["base-path"] });
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to update base path",
        message: error.message,
      });
    },
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
      queryClient.invalidateQueries({ queryKey: ["shells"] });
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to update default shell",
        message: error.message,
      });
    },
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
      invalidate();
    },
    onError: (error: Error) => {
      notifications.show({ color: "red", title: "Failed to save env var", message: error.message });
    },
  });
}

export function useDeleteEnvVar() {
  const invalidate = useInvalidateEnv();
  return useMutation({
    mutationFn: deleteEnvVar,
    onSuccess: () => {
      notifications.show({ color: "green", message: "Deleted" });
      invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to delete env var",
        message: error.message,
      });
    },
  });
}

export function useImportEnvVars() {
  const invalidate = useInvalidateEnv();
  return useMutation({
    mutationFn: importEnvVars,
    onSuccess: (count) => {
      notifications.show({ color: "green", message: `Imported ${count} variable(s)` });
      invalidate();
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to import env vars",
        message: error.message,
      });
    },
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
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
      queryClient.invalidateQueries({ queryKey: ["base-path"] });
      queryClient.invalidateQueries({ queryKey: ["shells"] });
    },
    onError: (error: Error) => {
      notifications.show({
        color: "red",
        title: "Failed to import config",
        message: error.message,
      });
    },
  });
}
