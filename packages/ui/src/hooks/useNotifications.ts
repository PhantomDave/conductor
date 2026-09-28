import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications as toasts } from "@mantine/notifications";
import { notifyError } from "../lib/notify";

export interface Notification {
  id: string;
  timestamp: number;
  type:
    | "failed_start"
    | "dependency_failed"
    | "healthcheck_failed"
    | "recovered"
    | "crashed"
    | "unhealthy";
  profile: string;
  commandId: string;
  commandName?: string;
  reason: string;
  exitCode?: number;
  affectedDownstream: string[];
}

export function useNotifications(limit = 100, offset = 0) {
  return useQuery({
    queryKey: ["notifications", limit, offset],
    queryFn: async () => {
      const response = await fetch(`/api/notifications?limit=${limit}&offset=${offset}`);
      if (!response.ok) {
        throw new Error("Failed to fetch notifications");
      }
      return (await response.json()) as { notifications: Notification[] };
    },
    refetchInterval: 5000, // Poll every 5 seconds
  });
}

/** Clears the notification history and any toasts still on screen. */
export function useClearNotifications() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/notifications", { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to clear notifications");
    },
    onSuccess: () => {
      toasts.clean();
      return queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: notifyError("Failed to clear notifications"),
  });
}
