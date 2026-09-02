import { create } from "zustand";
import type { ProcessInfo } from "../lib/api";

export type UiView = "processes" | "flow" | "profiles" | "commands" | "environment";

/** Identifies a command's process regardless of its current pid, so the
 * selection survives a restart (which always assigns a new pid). */
export interface ProcessKey {
  profile: string;
  commandId: string;
}

/** One-shot request consumed by the target view, such as opening a create modal after navigation. */
export type PendingAction = "newProfile" | "newCommand" | null;

interface UiState {
  view: UiView;
  selectedProcessKey: ProcessKey | null;
  pendingAction: PendingAction;
  setView: (view: UiView) => void;
  selectProcess: (process: ProcessInfo | ProcessKey | null) => void;
  triggerAction: (view: UiView, action: Exclude<PendingAction, null>) => void;
  clearPendingAction: () => void;
}

/**
 * Client-only navigation state: which view is active and which command
 * (if any) is currently focused in the log viewer.
 * Selection is stored as a stable `{ profile, commandId }` key rather than
 * a process snapshot, since a restarted command gets a new pid immediately.
 */
export const useUiStore = create<UiState>((set) => ({
  view: "processes",
  selectedProcessKey: null,
  pendingAction: null,
  setView: (view) => set({ view, selectedProcessKey: null, pendingAction: null }),
  selectProcess: (process) =>
    set({
      selectedProcessKey: process
        ? { profile: process.profile, commandId: process.commandId }
        : null,
      pendingAction: null,
    }),
  triggerAction: (view, action) => set({ view, selectedProcessKey: null, pendingAction: action }),
  clearPendingAction: () => set({ pendingAction: null }),
}));
