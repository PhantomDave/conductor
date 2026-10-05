import { useQuery } from "@tanstack/react-query";
import { fetchWorkspaces } from "../lib/api";

export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
  });
}
