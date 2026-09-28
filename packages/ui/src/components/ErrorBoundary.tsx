import { Component, type ReactNode } from "react";
import { Button, Center, Code, Stack, Text, Title } from "@mantine/core";

interface State {
  failed: boolean;
  /** Whatever was thrown: usually an Error, but JS lets you throw anything. */
  error: unknown;
}

/** Catches render errors anywhere below it and shows them instead of letting
 * React unmount the whole tree, which leaves the desktop window blank.
 * React has no hook equivalent for this, hence the class component. React 19
 * already logs caught errors (createRoot's default onCaughtError), so there is
 * no componentDidCatch. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, error: undefined };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, error };
  }

  render() {
    const { failed, error } = this.state;
    if (!failed) return this.props.children;
    return (
      <Center mih="100vh" p="xl">
        <Stack maw={720} w="100%">
          <Title order={3}>Something went wrong</Title>
          <Text c="dimmed" size="sm">
            The interface hit an unexpected error. Your processes keep running; reloading brings the
            UI back.
          </Text>
          <Code block style={{ maxHeight: 240, overflow: "auto" }}>
            {error instanceof Error ? (error.stack ?? error.message) : String(error)}
          </Code>
          <Button w="fit-content" onClick={() => globalThis.location.reload()}>
            Reload
          </Button>
        </Stack>
      </Center>
    );
  }
}
