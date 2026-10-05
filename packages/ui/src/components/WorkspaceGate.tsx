import type { ReactNode } from "react";
import { Center, Loader } from "@mantine/core";
import { useWorkspaces } from "../hooks/useWorkspaces";
import { StartScreen } from "./StartScreen";

/**
 * Nothing under `/api/*` (besides /api/health) works until a workspace is
 * open, so `<App/>` must not mount - and fire its polling hooks - before
 * `current` is known to be non-null.
 */
export function WorkspaceGate({ children }: { children: ReactNode }) {
  const { data, isPending } = useWorkspaces();

  if (isPending) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  if (!data?.current) {
    return <StartScreen />;
  }

  return <>{children}</>;
}
