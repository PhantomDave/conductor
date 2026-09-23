import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The release tag is the app's real version. release.yml writes it into
// tauri.conf.json before building the UI; the committed placeholder there is
// 0.0.0, so local builds fall back to the nearest git tag.
function appVersion(): string {
  const tauriConf = JSON.parse(
    readFileSync(resolve(__dirname, "../desktop-tauri/src-tauri/tauri.conf.json"), "utf-8"),
  );
  if (tauriConf.version !== "0.0.0") return tauriConf.version;
  try {
    return execSync("git describe --tags --abbrev=0", { encoding: "utf-8" })
      .trim()
      .replace(/^v/, "");
  } catch {
    return "dev";
  }
}

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(appVersion()),
  },
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
