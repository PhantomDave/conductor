import { create } from "zustand";
import type { ProcessInfo } from "../lib/api";

export type UiView = "processes" | "profiles" | "commands" | "environment";

/** Identifies a command's process regardless of its current pid, so the
 * selection survives a restart (which always assigns a new pid). */
export interface ProcessKey {
  profile: string;
  commandId: string;
}

interface UiState {
  view: UiView;
  selectedProcessKey: ProcessKey | null;
  setView: (view: UiView) => void;
  selectProcess: (process: ProcessInfo | ProcessKey | null) => void;
}

/**
 * Client-only navigation state: which page is active, which tab is shown,
 * and which command (if any) is currently focused in the log viewer.
 * Selection is stored as a stable `{ profile, commandId }` key rather than
 * a process snapshot, since a restarted command gets a new pid immediately.
 */
export const useUiStore = create<UiState>((set) => ({
  view: "processes",
  selectedProcessKey: null,
  setView: (view) => set({ view, selectedProcessKey: null }),
  selectProcess: (process) =>
    set({
      selectedProcessKey: process
        ? { profile: process.profile, commandId: process.commandId }
        : null,
    }),
}));
