// Copies the compiled sidecar binary into src-tauri/binaries/ with the
// target-triple suffix Tauri's `externalBin` mechanism expects, in both dev
// and packaged builds (see https://v2.tauri.app/develop/sidecar/).
import { execSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";

const here = dirname(fileURLToPath(import.meta.url));
const ext = process.platform === "win32" ? ".exe" : "";
const src = join(here, "..", "..", "core", "dist-bin", `conductor-server${ext}`);

if (!existsSync(src)) {
  console.error(`Sidecar binary not found at ${src}`);
  console.error('Run "bun run --cwd packages/core build:sidecar" first.');
  process.exit(1);
}

const targetTriple = execSync("rustc --print host-tuple").toString().trim();
const binariesDir = join(here, "..", "src-tauri", "binaries");
mkdirSync(binariesDir, { recursive: true });
const dest = join(binariesDir, `conductor-server-${targetTriple}${ext}`);
copyFileSync(src, dest);
if (process.platform !== "win32") chmodSync(dest, 0o755);
console.log(`Staged sidecar -> ${dest}`);
