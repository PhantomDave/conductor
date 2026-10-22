import { useEffect } from "react";
import { notifications as toasts } from "@mantine/notifications";

/**
 * In the desktop app, checks once for a newer release and says so. Installing
 * restarts the app (stopping every managed process), so it is never done
 * unprompted: the user installs from Environment → About when it suits them.
 */
export function useUpdateNotice() {
  useEffect(() => {
    const tauri = window.__TAURI__;
    if (!tauri) return;
    tauri.core
      .invoke<{ current: string; available: string | null }>("check_update")
      .then(({ available }) => {
        if (!available) return;
        toasts.show({
          title: "Update available",
          message: `Conductor v${available} is ready. Install it from Environment → About when your processes can restart.`,
          autoClose: false,
        });
      })
      // Offline or no release feed: nothing to tell the user at startup.
      .catch(() => {});
  }, []);
}
