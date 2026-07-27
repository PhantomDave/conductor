import { useQuery } from "@tanstack/react-query";

export interface Notification {
  id: string;
  timestamp: number;
  type: "failed_start" | "dependency_failed" | "healthcheck_failed";
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
