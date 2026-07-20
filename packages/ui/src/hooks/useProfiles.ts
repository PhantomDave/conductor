import { useQuery } from "@tanstack/react-query";
import { fetchProfiles } from "../lib/api";

export function useProfiles() {
  return useQuery({
    queryKey: ["profiles"],
    queryFn: fetchProfiles,
    staleTime: 60_000,
  });
}
