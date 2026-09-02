/** Shared Mantine color name per process status — used by every view that
 * renders a process's live state (ProcessBoard, Sidebar, LogViewer, Flow). */
export const STATUS_COLOR: Record<string, string> = {
  running: "green",
  starting: "yellow",
  stopping: "orange",
  stopped: "gray",
  failed: "red",
};
