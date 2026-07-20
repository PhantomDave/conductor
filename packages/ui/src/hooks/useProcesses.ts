import { useQuery } from "@tanstack/react-query";
import { fetchProcesses } from "../lib/api";

export function useProcesses() {
  return useQuery({
    queryKey: ["processes"],
    queryFn: fetchProcesses,
    refetchInterval: 5000,
  });
}
