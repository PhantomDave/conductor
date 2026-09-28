import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Center, Code, Stack, Text, Title } from "@mantine/core";

/** Catches render errors anywhere below it and shows them instead of letting
 * React unmount the whole tree, which leaves the desktop window blank.
 * React has no hook equivalent for this, hence the class component. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Center mih="100vh" p="xl">
        <Stack maw={720} w="100%">
          <Title order={3}>Something went wrong</Title>
          <Text c="dimmed" size="sm">
            The interface hit an unexpected error. Your processes keep running; reloading brings the
            UI back.
          </Text>
          <Code block style={{ maxHeight: 240, overflow: "auto" }}>
            {error.stack ?? error.message}
          </Code>
          <Button w="fit-content" onClick={() => globalThis.location.reload()}>
            Reload
          </Button>
        </Stack>
      </Center>
    );
  }
}
