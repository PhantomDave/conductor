import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Center,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { ConductorMark } from "./ConductorMark";
import { useWorkspaces } from "../hooks/useWorkspaces";
import { openWorkspace, forgetWorkspace, type RecentWorkspaceInfo } from "../lib/api";

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** Coarse unit picker (minutes/hours/days) - this list is short-lived "recent" entries, not a calendar. */
function formatRelativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  if (Math.abs(diffMinutes) < 60) return relativeTime.format(diffMinutes, "minute");
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return relativeTime.format(diffHours, "hour");
  return relativeTime.format(Math.round(diffHours / 24), "day");
}

function RecentRow({
  entry,
  onOpen,
  onForget,
}: {
  entry: RecentWorkspaceInfo;
  onOpen: (path: string) => void;
  onForget: (path: string) => void;
}) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      w="100%"
      py={6}
      px="sm"
      style={{ opacity: entry.missing ? 0.5 : 1, cursor: entry.missing ? "default" : "pointer" }}
      onClick={() => !entry.missing && onOpen(entry.path)}
    >
      <Box style={{ overflow: "hidden", minWidth: 0, flex: 1 }}>
        <Text size="sm" truncate>
          {entry.name}
        </Text>
        <Text size="xs" c="dimmed" truncate>
          {entry.path} · {entry.missing ? "folder not found" : formatRelativeTime(entry.lastOpened)}
        </Text>
      </Box>
      <ActionIcon
        variant="subtle"
        color="gray"
        style={{ flexShrink: 0 }}
        aria-label={`Remove ${entry.name} from recent workspaces`}
        onClick={(e) => {
          e.stopPropagation();
          onForget(entry.path);
        }}
      >
        <IconX size={14} />
      </ActionIcon>
    </Group>
  );
}

export function StartScreen() {
  const { data } = useWorkspaces();
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

  async function performOpen(target: string) {
    setError(null);
    setOpening(true);
    try {
      await openWorkspace(target);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open workspace");
      setOpening(false);
    }
  }

  async function handleOpenNew() {
    if (isTauri) {
      const picked = await window.__TAURI__!.core.invoke<string | null>("pick_folder");
      if (!picked) return;
      await performOpen(picked);
    } else if (path) {
      await performOpen(path);
    }
  }

  async function handleForget(forgetPath: string) {
    await forgetWorkspace(forgetPath);
    await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
  }

  const recent = data?.recent ?? [];

  return (
    <Center h="100vh">
      <Stack w={420} gap="lg">
        <Group gap="xs" justify="center">
          <ConductorMark size={28} />
          <Title order={2}>conductor</Title>
        </Group>

        {error && (
          <Alert
            color="red"
            variant="light"
            title="Couldn't open workspace"
            withCloseButton
            onClose={() => setError(null)}
          >
            {error}
          </Alert>
        )}

        <Paper withBorder p="md">
          {isTauri ? (
            <Button fullWidth onClick={handleOpenNew} loading={opening}>
              Open folder…
            </Button>
          ) : (
            <Group wrap="nowrap">
              <TextInput
                flex={1}
                placeholder="/path/to/project"
                value={path}
                onChange={(e) => setPath(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && handleOpenNew()}
              />
              <Button onClick={handleOpenNew} loading={opening} disabled={!path}>
                Open
              </Button>
            </Group>
          )}
        </Paper>

        {recent.length > 0 && (
          <Paper withBorder>
            {/* ScrollArea.Autosize sets `display: table; min-width: min-content` on
                its content wrapper (to measure natural size for autosizing), which
                forces the box to grow to fit any unbreakable `white-space: nowrap`
                text - like our truncated path - instead of respecting the Paper's
                width. Override both so long paths actually truncate instead of
                pushing the forget button out past the visible card. */}
            <ScrollArea.Autosize mah={300} styles={{ content: { display: "block", minWidth: 0 } }}>
              <Stack gap={0} py={4}>
                {recent.map((entry) => (
                  <RecentRow
                    key={entry.path}
                    entry={entry}
                    onOpen={performOpen}
                    onForget={handleForget}
                  />
                ))}
              </Stack>
            </ScrollArea.Autosize>
          </Paper>
        )}
      </Stack>
    </Center>
  );
}
