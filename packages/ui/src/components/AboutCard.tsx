import { useState } from "react";
import { Anchor, Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";

const REPO = "https://github.com/PhantomDave/conductor";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; current: string }
  | { kind: "available"; current: string; available: string }
  | { kind: "installing" }
  | { kind: "error"; message: string };

function UpdateChecker() {
  const tauri = window.__TAURI__;
  const [state, setState] = useState<UpdateState>({ kind: "idle" });

  if (!tauri) {
    return (
      <Text size="sm" c="dimmed">
        Updates are installed by the desktop app.
      </Text>
    );
  }

  const check = async () => {
    setState({ kind: "checking" });
    try {
      const { current, available } = await tauri.core.invoke<{
        current: string;
        available: string | null;
      }>("check_update");
      setState(
        available ? { kind: "available", current, available } : { kind: "current", current },
      );
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  };

  // Success restarts the app, so the promise only ever settles on failure.
  const install = () => {
    setState({ kind: "installing" });
    tauri.core
      .invoke("install_update")
      .catch((err: unknown) => setState({ kind: "error", message: String(err) }));
  };

  return (
    <Stack gap={6}>
      <Group>
        <Button
          variant="light"
          loading={state.kind === "checking"}
          disabled={state.kind === "installing"}
          onClick={check}
        >
          Check for updates
        </Button>
        {state.kind === "available" && (
          <Button onClick={install}>Install v{state.available} & restart</Button>
        )}
      </Group>
      {state.kind === "current" && (
        <Text size="sm" c="dimmed">
          Up to date (v{state.current}).
        </Text>
      )}
      {state.kind === "available" && (
        <Text size="sm">
          v{state.available} is available (installed: v{state.current}).{" "}
          <Anchor href={`${REPO}/releases/latest`} target="_blank">
            Release notes
          </Anchor>
        </Text>
      )}
      {state.kind === "installing" && (
        <Text size="sm" c="dimmed">
          Downloading and installing - Conductor will restart when done.
        </Text>
      )}
      {state.kind === "error" && (
        <Text size="sm" c="red">
          {state.message}
        </Text>
      )}
    </Stack>
  );
}

export function AboutCard() {
  return (
    <Card withBorder padding="md">
      <Stack gap="xs">
        <Group gap={6}>
          <IconInfoCircle size={18} />
          <Title order={4}>About</Title>
          <Badge variant="light">v{__VERSION__}</Badge>
        </Group>
        <Text size="sm" c="dimmed">
          Universal task runner & dashboard for developers. Made by PhantomDave, released under the
          MIT license.
        </Text>
        <Group gap="md">
          <Anchor size="sm" href={REPO} target="_blank">
            GitHub
          </Anchor>
          <Anchor size="sm" href={`${REPO}/releases`} target="_blank">
            Releases
          </Anchor>
          <Anchor size="sm" href={`${REPO}/issues`} target="_blank">
            Report an issue
          </Anchor>
          <Anchor size="sm" href={`${REPO}/blob/main/LICENSE`} target="_blank">
            License
          </Anchor>
        </Group>
        <UpdateChecker />
      </Stack>
    </Card>
  );
}
