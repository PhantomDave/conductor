import { useEffect, useMemo, useRef, useState } from "react";
import {
  Stack,
  Group,
  Title,
  Text,
  Badge,
  Button,
  ScrollArea,
  Paper,
  TextInput,
  SegmentedControl,
  ActionIcon,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconPlayerStop,
  IconRefresh,
  IconSearch,
  IconX,
  IconArrowDown,
} from "@tabler/icons-react";
import { fetchLogs, streamLogs, type LogRow, type ProcessInfo } from "../lib/api";
import { useUiStore } from "../store/ui";
import { useStopProcess, useRestartCommand } from "../hooks/useProcessActions";
import { renderAnsiLine } from "../lib/ansi";

const STATUS_COLOR: Record<string, string> = {
  running: "green",
  starting: "yellow",
  stopping: "orange",
  stopped: "gray",
  failed: "red",
};

type StreamFilter = "all" | "stdout" | "stderr";

export function LogViewer({ process }: { process: ProcessInfo }) {
  const selectProcess = useUiStore((s) => s.selectProcess);
  const stopProcess = useStopProcess();
  const restartCommand = useRestartCommand();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [search, setSearch] = useState("");
  const [streamFilter, setStreamFilter] = useState<StreamFilter>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const isStoppable = process.status === "running" || process.status === "starting";

  // Keyed off process.pid, which changes on every restart - so switching
  // to a fresh pid naturally clears the view instead of mixing old and
  // new output together.
  useEffect(() => {
    setLogs([]);
    let cancelled = false;

    fetchLogs({ pid: process.pid, limit: 500 }).then((history) => {
      if (!cancelled) setLogs(history);
    });

    // Live tail: SSE already replays recent history too, but we've just
    // fetched it above for an instant first paint, so dedupe by id.
    const seenIds = new Set<number>();
    const unsubscribe = streamLogs(process.pid, (entry) => {
      if (seenIds.has(entry.id)) return;
      seenIds.add(entry.id);
      setLogs((prev) => [...prev, entry]);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [process.pid]);

  const filteredLogs = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return logs.filter((log) => {
      if (streamFilter !== "all" && log.stream !== streamFilter) return false;
      if (needle && !log.message.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [logs, search, streamFilter]);

  useEffect(() => {
    if (autoScroll) {
      viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
    }
  }, [filteredLogs.length, autoScroll]);

  // Auto-scroll pauses if the user scrolls up to read history, and
  // resumes once they scroll back to the bottom.
  const handleScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  };

  return (
    <Stack gap="sm" h="100%">
      <Group justify="space-between" wrap="nowrap">
        <Group wrap="nowrap">
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconArrowLeft size={14} />}
            onClick={() => selectProcess(null)}
          >
            Back
          </Button>
          <div>
            <Title order={4}>{process.commandName ?? process.commandId}</Title>
            <Text size="xs" c="dimmed">
              {process.profile} · pid {process.pid}
            </Text>
          </div>
          <Badge color={STATUS_COLOR[process.status] ?? "gray"}>{process.status}</Badge>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button
            size="xs"
            variant="light"
            leftSection={<IconRefresh size={14} />}
            loading={restartCommand.isPending}
            onClick={() =>
              restartCommand.mutate({ profile: process.profile, commandId: process.commandId })
            }
          >
            Restart
          </Button>
          <Button
            size="xs"
            color="red"
            variant="light"
            disabled={!isStoppable}
            leftSection={<IconPlayerStop size={14} />}
            loading={stopProcess.isPending}
            onClick={() => stopProcess.mutate(process.pid)}
          >
            Stop
          </Button>
        </Group>
      </Group>

      <Group gap="xs" wrap="nowrap">
        <TextInput
          style={{ flex: 1 }}
          size="xs"
          placeholder="Filter logs..."
          leftSection={<IconSearch size={14} />}
          rightSection={
            search ? (
              <ActionIcon size="xs" variant="subtle" onClick={() => setSearch("")}>
                <IconX size={12} />
              </ActionIcon>
            ) : null
          }
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <SegmentedControl
          size="xs"
          value={streamFilter}
          onChange={(v) => setStreamFilter(v as StreamFilter)}
          data={[
            { label: "All", value: "all" },
            { label: "stdout", value: "stdout" },
            { label: "stderr", value: "stderr" },
          ]}
        />
        <Tooltip label={autoScroll ? "Auto-scrolling" : "Scroll to bottom to resume auto-scroll"}>
          <ActionIcon
            size="lg"
            variant={autoScroll ? "filled" : "default"}
            color={autoScroll ? "blue" : "gray"}
            onClick={() => {
              setAutoScroll(true);
              viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
            }}
          >
            <IconArrowDown size={16} />
          </ActionIcon>
        </Tooltip>
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          {filteredLogs.length} / {logs.length} lines
        </Text>
      </Group>

      <Paper withBorder flex={1} p="xs" style={{ overflow: "hidden", background: "#1e1e1e" }}>
        <ScrollArea h="100%" viewportRef={viewportRef} onScrollPositionChange={handleScroll}>
          {filteredLogs.length === 0 ? (
            <Text c="dimmed" size="sm">
              {logs.length === 0 ? "No log output yet." : "No lines match the current filter."}
            </Text>
          ) : (
            <div style={{ fontFamily: "monospace", fontSize: 13, lineHeight: 1.5 }}>
              {filteredLogs.map((log) => (
                <div
                  key={log.id}
                  style={{
                    color: "#d4d4d4",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    borderLeft:
                      log.stream === "stderr"
                        ? "2px solid var(--mantine-color-red-6)"
                        : "2px solid transparent",
                    paddingLeft: 6,
                  }}
                >
                  <span style={{ color: "#6a6a6a" }}>
                    {new Date(log.timestamp).toLocaleTimeString()}
                    {"  "}
                  </span>
                  {renderAnsiLine(log.message, String(log.id))}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </Paper>
    </Stack>
  );
}
