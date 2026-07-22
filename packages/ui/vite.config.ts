import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkgJson = JSON.parse(
  readFileSync(resolve(__dirname, "../../package.json"), "utf-8"),
);

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkgJson.version),
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
