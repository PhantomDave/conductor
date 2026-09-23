import type { CommandInfo } from "./api";

/**
 * Expands `selectedIds` to every command they transitively depend on —
 * mirrors SpawnQueue.ensureStarted in packages/core/src/executor/queue.ts,
 * which starts a command's deps even when they aren't in the profile's
 * command_ids. Unknown ids are skipped; `seen` guards against cycles.
 */
export function depClosure(selectedIds: string[], byId: Map<string, CommandInfo>): CommandInfo[] {
  const seen = new Set<string>();
  const out: CommandInfo[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const cmd = byId.get(id);
    if (!cmd) return;
    out.push(cmd);
    for (const dep of cmd.deps) if (dep) visit(dep);
  };
  for (const id of selectedIds) visit(id);
  return out;
}
