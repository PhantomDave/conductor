import type { ReactNode } from "react";
import { Alert, Button, Center, Loader, Stack } from "@mantine/core";
import { useWorkspaces } from "../hooks/useWorkspaces";
import { StartScreen } from "./StartScreen";

/**
 * Nothing under `/api/*` (besides /api/health) works until a workspace is
 * open, so `<App/>` must not mount - and fire its polling hooks - before
 * `current` is known to be non-null.
 */
export function WorkspaceGate({ children }: { children: ReactNode }) {
  const { data, isPending, isError, error, refetch } = useWorkspaces();

  if (isPending) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  if (isError) {
    return (
      <Center h="100vh">
        <Alert color="red" variant="light" title="Couldn't load workspaces" w={420}>
          <Stack gap="sm">
            <span>{error instanceof Error ? error.message : "Unknown error"}</span>
            <Button size="xs" onClick={() => refetch()}>
              Retry
            </Button>
          </Stack>
        </Alert>
      </Center>
    );
  }

  if (!data?.current) {
    return <StartScreen />;
  }

  return <>{children}</>;
}
