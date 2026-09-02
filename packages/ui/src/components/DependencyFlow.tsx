import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge, Card, Group, Stack, Text } from "@mantine/core";
import { useProfiles } from "../hooks/useProfiles";
import { useProcesses } from "../hooks/useProcesses";
import { useUiStore } from "../store/ui";
import { SectionHeading } from "./SectionHeading";
import type { CommandInfo, ProcessInfo } from "../lib/api";

const STATUS_COLOR: Record<string, string> = {
  running: "green",
  starting: "yellow",
  stopping: "orange",
  stopped: "gray",
  failed: "red",
};

const COLUMN_GAP = 56;
const NODE_GAP = 10;
const NODE_WIDTH = 180;

interface FlowNode {
  command: CommandInfo;
  depth: number;
  cycle: boolean;
}

/**
 * Depth = longest chain of in-profile dependencies before a command can
 * start. Mirrors SpawnQueue.checkForCycles' visiting/visited DFS
 * (packages/core/src/executor/queue.ts) but degrades a cycle to depth 0 +
 * a flag instead of throwing — this only draws a picture, it doesn't run
 * anything. A dep id not present in this profile's own command list has no
 * node to connect to and is silently ignored, same as SpawnQueue's `if
 * (!cmd) return`.
 */
function layoutProfile(commands: CommandInfo[]): FlowNode[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const depthCache = new Map<string, number>();
  const visiting = new Set<string>();
  const cycles = new Set<string>();

  function depthOf(id: string): number {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      cycles.add(id);
      return 0;
    }
    const cmd = byId.get(id);
    if (!cmd) return 0;

    visiting.add(id);
    const inProfileDeps = cmd.deps.filter((d) => byId.has(d));
    const depth = inProfileDeps.length === 0 ? 0 : 1 + Math.max(...inProfileDeps.map(depthOf));
    visiting.delete(id);
    depthCache.set(id, depth);
    return depth;
  }

  return commands.map((command) => ({
    command,
    depth: depthOf(command.id),
    cycle: cycles.has(command.id),
  }));
}

interface ProfileFlowProps {
  profileName: string;
  commands: CommandInfo[];
  processesByCommandId: Map<string, ProcessInfo>;
}

function ProfileFlow({ profileName, commands, processesByCommandId }: ProfileFlowProps) {
  const { selectProcess, setView } = useUiStore();
  const nodes = useMemo(() => layoutProfile(commands), [commands]);

  const columns = useMemo(() => {
    const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
    const cols: FlowNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
    for (const n of nodes) cols[n.depth].push(n);
    for (const col of cols) col.sort((a, b) => a.command.id.localeCompare(b.command.id));
    return cols;
  }, [nodes]);

  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [edges, setEdges] = useState<{ id: string; d: string }[]>([]);
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const containerRect = container.getBoundingClientRect();
      const rectOf = (id: string) => {
        const el = nodeRefs.current.get(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left - containerRect.left, top: r.top - containerRect.top, width: r.width, height: r.height };
      };

      const nextEdges: { id: string; d: string }[] = [];
      for (const node of nodes) {
        for (const depId of node.command.deps) {
          const from = rectOf(depId);
          const to = rectOf(node.command.id);
          if (!from || !to) continue;
          const x1 = from.left + from.width;
          const y1 = from.top + from.height / 2;
          const x2 = to.left;
          const y2 = to.top + to.height / 2;
          const midX = (x1 + x2) / 2;
          nextEdges.push({ id: `${depId}->${node.command.id}`, d: `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}` });
        }
      }
      setEdges(nextEdges);
      setSvgSize({ width: containerRect.width, height: containerRect.height });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [nodes]);

  if (commands.length === 0) {
    return (
      <Stack gap="xs">
        <Text size="xs" fw={700} c="dimmed">
          {profileName.toUpperCase()}
        </Text>
        <Text size="sm" c="dimmed">
          No commands in this profile yet.
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="xs">
      <Group gap={6}>
        <Text size="xs" fw={700} c="dimmed">
          {profileName.toUpperCase()}
        </Text>
        <Text size="xs" c="dimmed">
          · {commands.length} command{commands.length === 1 ? "" : "s"}
        </Text>
      </Group>

      <div style={{ overflowX: "auto", paddingBottom: 4 }}>
        <div ref={containerRef} style={{ position: "relative", display: "inline-block", minWidth: "100%" }}>
          <svg
            width={svgSize.width}
            height={svgSize.height}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            {edges.map((e) => (
              <path key={e.id} d={e.d} stroke="var(--mantine-color-dark-4)" strokeWidth={1.5} fill="none" />
            ))}
          </svg>

          <Group align="flex-start" gap={COLUMN_GAP} wrap="nowrap">
            {columns.map((col, depth) => (
              <Stack key={depth} gap={NODE_GAP} style={{ width: NODE_WIDTH, flexShrink: 0 }}>
                {col.map(({ command, cycle }) => {
                  const process = processesByCommandId.get(command.id);
                  const color = process ? (STATUS_COLOR[process.status] ?? "gray") : "gray";
                  const clickable = Boolean(process);
                  return (
                    <div
                      key={command.id}
                      ref={(el) => {
                        if (el) nodeRefs.current.set(command.id, el);
                        else nodeRefs.current.delete(command.id);
                      }}
                      onClick={
                        clickable
                          ? () => {
                              selectProcess(process!);
                              setView("processes");
                            }
                          : undefined
                      }
                      style={{
                        border: `1px solid var(--mantine-color-${process ? color : "dark"}-${process ? 6 : 4})`,
                        borderStyle: process ? "solid" : "dashed",
                        background: "var(--mantine-color-dark-7)",
                        padding: "8px 12px",
                        cursor: clickable ? "pointer" : "default",
                      }}
                    >
                      <Group gap={6} wrap="nowrap" justify="space-between">
                        <Text size="sm" fw={600} c={process ? undefined : "dimmed"} truncate>
                          {command.name || command.id}
                        </Text>
                        {cycle && (
                          <Badge color="red" size="xs" variant="light">
                            cycle
                          </Badge>
                        )}
                      </Group>
                      <Text size="xs" c={process ? color : "dimmed"} mt={2}>
                        {process ? process.status : "not running"}
                      </Text>
                      {command.deps.length > 0 && (
                        <Text size="xs" c="dimmed" mt={2} truncate>
                          needs: {command.deps.join(", ")}
                        </Text>
                      )}
                    </div>
                  );
                })}
              </Stack>
            ))}
          </Group>
        </div>
      </div>
    </Stack>
  );
}

export function DependencyFlow() {
  const { data: profiles, isLoading, error } = useProfiles();
  const { data: processes } = useProcesses();

  const processesByProfile = useMemo(() => {
    const map = new Map<string, Map<string, ProcessInfo>>();
    for (const p of processes ?? []) {
      if (!map.has(p.profile)) map.set(p.profile, new Map());
      map.get(p.profile)!.set(p.commandId, p);
    }
    return map;
  }, [processes]);

  if (isLoading) return <Text c="dimmed">Loading flow...</Text>;
  if (error) {
    return <Text c="red">Could not reach Conductor core API. Is `bun run dev:core` running?</Text>;
  }

  const profileNames = profiles ? Object.keys(profiles).sort((a, b) => a.localeCompare(b)) : [];

  if (profileNames.length === 0) {
    return (
      <Card withBorder padding="lg">
        <Text c="dimmed">No profiles configured yet. Add one from the Profiles tab.</Text>
      </Card>
    );
  }

  return (
    <Stack gap="xl">
      <div>
        <SectionHeading>flow</SectionHeading>
        <Text c="dimmed" size="sm" mt={4}>
          Every command across every profile, and what it waits on — an edge means "must be healthy before this
          starts." Solid boxes are live right now; dashed ones aren't running.
        </Text>
      </div>

      {profileNames.map((name) => (
        <ProfileFlow
          key={name}
          profileName={name}
          commands={profiles![name].commands}
          processesByCommandId={processesByProfile.get(name) ?? new Map()}
        />
      ))}
    </Stack>
  );
}
