import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge, Card, Group, Stack, Text } from "@mantine/core";
import { useProfiles } from "../hooks/useProfiles";
import { useProcesses } from "../hooks/useProcesses";
import { useUiStore } from "../store/ui";
import { SectionHeading } from "./SectionHeading";
import { STATUS_COLOR } from "../lib/statusColor";
import type { CommandInfo, ProcessInfo } from "../lib/api";

const COLUMN_GAP = 56;
const NODE_GAP = 10;
const NODE_WIDTH = 180;

// Stable fallback so a profile with no live processes doesn't force a new
// Map identity (and a re-render) on every call.
const EMPTY_PROCESS_MAP = new Map<string, ProcessInfo>();

interface FlowNode {
  command: CommandInfo;
  depth: number;
  cycle: boolean;
  resolvedDeps: string[];
  unresolvedDeps: string[];
}

/**
 * Finds every command that's a member of ANY dependency cycle reachable
 * from `rootIds`, walking the FULL command graph (not just one profile) —
 * this is the same scope SpawnQueue.checkForCycles uses in
 * packages/core/src/executor/queue.ts, since `deps` reference commands
 * globally and a command can be shared across profiles. `stack` tracks the
 * current DFS path; finding an id already on it means every id from that
 * point to the top of the stack is part of one cycle, not just the id that
 * closed the loop.
 */
function findCycleMembers(rootIds: string[], byId: Map<string, CommandInfo>): Set<string> {
  const cycleMembers = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(id: string) {
    if (visited.has(id)) return;
    const stackIndex = stack.indexOf(id);
    if (stackIndex !== -1) {
      for (let i = stackIndex; i < stack.length; i++) cycleMembers.add(stack[i]);
      return;
    }
    const cmd = byId.get(id);
    if (!cmd) return;

    stack.push(id);
    for (const dep of cmd.deps) if (dep) visit(dep);
    stack.pop();
    visited.add(id);
  }

  for (const id of rootIds) visit(id);
  return cycleMembers;
}

/**
 * Depth = longest chain of in-profile dependencies before a command can
 * start, used only to pick this profile's visual column layout. Cycle
 * membership, though, is checked against the full cross-profile command
 * graph via findCycleMembers — a command can list a dep that belongs to a
 * different profile (commands are global; profiles just reference a
 * subset), and core's real SpawnQueue.checkForCycles traverses that edge
 * too. A dep outside this profile has no node to connect to, so it's
 * dropped from the drawn edges and the depth count, but never from cycle
 * detection.
 */
function layoutProfile(
  profileCommands: CommandInfo[],
  allCommandsById: Map<string, CommandInfo>,
): FlowNode[] {
  const profileIds = new Set(profileCommands.map((c) => c.id));
  const cycleMembers = findCycleMembers(
    profileCommands.map((c) => c.id),
    allCommandsById,
  );

  const depthCache = new Map<string, number>();
  function depthOf(id: string): number {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (cycleMembers.has(id)) {
      depthCache.set(id, 0);
      return 0;
    }
    const cmd = allCommandsById.get(id);
    if (!cmd) return 0;
    const inProfileDeps = cmd.deps.filter((d) => profileIds.has(d));
    const depth = inProfileDeps.length === 0 ? 0 : 1 + Math.max(...inProfileDeps.map(depthOf));
    depthCache.set(id, depth);
    return depth;
  }

  return profileCommands.map((command) => ({
    command,
    depth: depthOf(command.id),
    cycle: cycleMembers.has(command.id),
    resolvedDeps: command.deps.filter((d) => profileIds.has(d)),
    unresolvedDeps: command.deps.filter((d) => !profileIds.has(d)),
  }));
}

interface ProfileFlowProps {
  profileName: string;
  commands: CommandInfo[];
  allCommandsById: Map<string, CommandInfo>;
  processesByCommandId: Map<string, ProcessInfo>;
}

const ProfileFlow = memo(function ProfileFlow({
  profileName,
  commands,
  allCommandsById,
  processesByCommandId,
}: ProfileFlowProps) {
  const { selectProcess, setView } = useUiStore();
  const nodes = useMemo(
    () => layoutProfile(commands, allCommandsById),
    [commands, allCommandsById],
  );

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

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const containerRect = container.getBoundingClientRect();
      const rectOf = (id: string) => {
        const el = nodeRefs.current.get(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: r.left - containerRect.left,
          top: r.top - containerRect.top,
          width: r.width,
          height: r.height,
        };
      };

      const nextEdges: { id: string; d: string }[] = [];
      for (const node of nodes) {
        for (const depId of node.resolvedDeps) {
          const from = rectOf(depId);
          const to = rectOf(node.command.id);
          if (!from || !to) continue;
          const x1 = from.left + from.width;
          const y1 = from.top + from.height / 2;
          const x2 = to.left;
          const y2 = to.top + to.height / 2;
          const midX = (x1 + x2) / 2;
          nextEdges.push({
            id: `${depId}->${node.command.id}`,
            d: `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`,
          });
        }
      }
      setEdges(nextEdges);
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
        <div
          ref={containerRef}
          style={{ position: "relative", display: "inline-block", minWidth: "100%" }}
        >
          <svg
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
            }}
          >
            {edges.map((e) => (
              <path
                key={e.id}
                d={e.d}
                stroke="var(--mantine-color-dark-4)"
                strokeWidth={1.5}
                fill="none"
              />
            ))}
          </svg>

          <Group align="flex-start" gap={COLUMN_GAP} wrap="nowrap">
            {columns.map((col, depth) => (
              <Stack key={depth} gap={NODE_GAP} style={{ width: NODE_WIDTH, flexShrink: 0 }}>
                {col.map(({ command, cycle, resolvedDeps, unresolvedDeps }) => {
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
                        border: `1px solid var(--mantine-color-${cycle ? "red" : process ? color : "dark"}-${process || cycle ? 6 : 4})`,
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
                      {resolvedDeps.length > 0 && (
                        <Text size="xs" c="dimmed" mt={2} truncate>
                          needs: {resolvedDeps.join(", ")}
                        </Text>
                      )}
                      {unresolvedDeps.length > 0 && (
                        <Text size="xs" c="dimmed" fs="italic" mt={2} truncate>
                          also needs (other profile): {unresolvedDeps.join(", ")}
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
});

export function DependencyFlow() {
  const { data: profiles, isLoading, error } = useProfiles();
  const { data: processes } = useProcesses();

  // Commands are global and shared across profiles by id (see layoutProfile's
  // docstring) — merge every profile's resolved commands into one lookup so
  // cycle detection can traverse the same graph SpawnQueue would at runtime.
  const allCommandsById = useMemo(() => {
    const map = new Map<string, CommandInfo>();
    if (profiles) {
      for (const name of Object.keys(profiles)) {
        for (const cmd of profiles[name].commands) map.set(cmd.id, cmd);
      }
    }
    return map;
  }, [profiles]);

  // A derived, poll-stable proxy for `processes`: only the fields this view
  // displays. useProcesses() polls every 5s and ProcessInfo carries
  // cpuPercent/memoryBytes that fluctuate almost every tick — keying
  // processesByProfile off the raw array would rebuild it (and force every
  // ProfileFlow subtree to re-render) on every poll even when no status or
  // health actually changed.
  const statusSignature = useMemo(
    () =>
      (processes ?? []).map((p) => `${p.profile}:${p.commandId}:${p.status}:${p.health}`).join("|"),
    [processes],
  );

  const processesByProfile = useMemo(() => {
    const map = new Map<string, Map<string, ProcessInfo>>();
    for (const p of processes ?? []) {
      if (!map.has(p.profile)) map.set(p.profile, new Map());
      map.get(p.profile)!.set(p.commandId, p);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusSignature is the intentional, poll-stable proxy for `processes` described above.
  }, [statusSignature]);

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
          Every command across every profile, and what it waits on — an edge means "must be healthy
          before this starts." Solid boxes are live right now; dashed ones aren't running.
        </Text>
      </div>

      {profileNames.map((name) => (
        <ProfileFlow
          key={name}
          profileName={name}
          commands={profiles![name].commands}
          allCommandsById={allCommandsById}
          processesByCommandId={processesByProfile.get(name) ?? EMPTY_PROCESS_MAP}
        />
      ))}
    </Stack>
  );
}
