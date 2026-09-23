import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ActionIcon,
  Badge,
  Group,
  NavLink,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { IconRefresh, IconSearch } from "@tabler/icons-react";
import { fetchLogRuns, fetchLogs, type LogRun } from "../lib/api";
import { LogLines } from "./LogLines";
import { SectionHeading } from "./SectionHeading";

// Matches LogsQuerySchema's max in core; longer runs show their tail only.
const RUN_LINE_LIMIT = 2000;
const NO_RUNS: LogRun[] = [];

const runKey = (r: LogRun) => `${r.profile}/${r.command_id}/${r.process_id}`;

function formatDuration(from: string, to: string) {
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * Browse logs of past runs. Commands come from the log table itself rather
 * than the command library, so deleted/renamed commands keep their history.
 */
export function LogHistory() {
  const runsQuery = useQuery({
    queryKey: ["logRuns"],
    queryFn: () => fetchLogRuns({ limit: RUN_LINE_LIMIT }),
  });
  const runs = runsQuery.data ?? NO_RUNS;

  const commands = useMemo(
    () => [...new Set(runs.map((r) => `${r.profile}/${r.command_id}`))].sort(),
    [runs],
  );
  const [command, setCommand] = useState<string | null>(null);
  const activeCommand = command ?? commands[0] ?? null;
  const commandRuns = runs.filter((r) => `${r.profile}/${r.command_id}` === activeCommand);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const run = commandRuns.find((r) => runKey(r) === selectedKey) ?? commandRuns[0];

  const logsQuery = useQuery({
    queryKey: ["logRun", run && runKey(run)],
    queryFn: () =>
      fetchLogs({
        pid: Number(run!.process_id),
        commandId: run!.command_id,
        profile: run!.profile,
        limit: RUN_LINE_LIMIT,
      }),
    enabled: !!run,
  });

  const [search, setSearch] = useState("");
  const logs = logsQuery.data ?? [];
  const needle = search.trim().toLowerCase();
  const filtered = needle ? logs.filter((l) => l.message.toLowerCase().includes(needle)) : logs;

  return (
    <Stack gap="sm" h="calc(100vh - 76px)">
      <div>
        <SectionHeading>history</SectionHeading>
        <Text c="dimmed" size="sm" mt={4}>
          Logs from previous runs of each command
        </Text>
      </div>

      <Group gap="xs" wrap="nowrap">
        <Select
          size="xs"
          style={{ flex: 1 }}
          placeholder={runsQuery.isLoading ? "Loading..." : "No logged commands yet"}
          data={commands}
          value={activeCommand}
          onChange={(v) => {
            setCommand(v);
            setSelectedKey(null);
          }}
          searchable
        />
        <Tooltip label="Refresh">
          <ActionIcon
            size="lg"
            variant="default"
            aria-label="Refresh runs"
            loading={runsQuery.isFetching}
            onClick={() => {
              void runsQuery.refetch();
              if (run) void logsQuery.refetch();
            }}
          >
            <IconRefresh size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Group align="stretch" gap="sm" wrap="nowrap" flex={1} style={{ minHeight: 0 }}>
        <Paper withBorder w={260} style={{ overflow: "hidden" }}>
          <ScrollArea h="100%" p={4}>
            {commandRuns.length === 0 && (
              <Text size="xs" c="dimmed" p="xs">
                No runs.
              </Text>
            )}
            {commandRuns.map((r) => (
              <NavLink
                key={runKey(r)}
                active={run && runKey(run) === runKey(r)}
                label={new Date(r.started_at).toLocaleString()}
                description={`pid ${r.process_id} · ${formatDuration(r.started_at, r.last_at)} · ${r.lines} lines`}
                rightSection={
                  r.stderr_lines > 0 ? (
                    <Badge size="xs" color="red" variant="light">
                      {r.stderr_lines} err
                    </Badge>
                  ) : null
                }
                onClick={() => setSelectedKey(runKey(r))}
              />
            ))}
          </ScrollArea>
        </Paper>

        <Stack gap="xs" flex={1} style={{ minWidth: 0 }}>
          <Group gap="xs" wrap="nowrap">
            <TextInput
              style={{ flex: 1 }}
              size="xs"
              placeholder="Filter logs..."
              leftSection={<IconSearch size={14} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
            />
            <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {run && run.lines > RUN_LINE_LIMIT
                ? `showing last ${logs.length} of ${run.lines} lines`
                : `${filtered.length} / ${logs.length} lines`}
            </Text>
          </Group>
          <Paper withBorder flex={1} p="xs" style={{ overflow: "hidden", background: "#1e1e1e" }}>
            <ScrollArea h="100%">
              {filtered.length === 0 ? (
                <Text c="dimmed" size="sm">
                  {!run
                    ? "Select a run."
                    : logsQuery.isLoading
                      ? "Loading..."
                      : logs.length === 0
                        ? "No log lines left for this run."
                        : "No lines match the current filter."}
                </Text>
              ) : (
                <LogLines logs={filtered} />
              )}
            </ScrollArea>
          </Paper>
        </Stack>
      </Group>
    </Stack>
  );
}
