// Smoke test for the Conductor desktop app's sidecar (packages/core/dist-bin/conductor-server).
//
//   node .claude/skills/run-desktop/smoke.mjs [outDir]
//
// This host can't screenshot a real GTK/Wayland window (no capture path — see
// the desktop-screenshot-tooling-limits memory), so instead of driving the
// Tauri shell directly this runs the same sidecar binary Tauri's Rust host
// spawns, with the same CONDUCTOR_UI_DIST env var it sets, and points headless
// Chromium at its HTTP URL. Tauri and the sidecar serve byte-identical
// HTML/JS, so this proves everything except the native shell itself (see
// TROUBLESHOOTING.md's "Tauri desktop won't launch" section for that half).
// Exit code 0 = pass, 1 = a check failed, 2 = prerequisites missing / hang.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Node globals come from explicit imports (and browser ones via globalThis
// inside page callbacks) so this file passes no-undef with no env config.
import console from "node:console";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";

const PORT = 4199; // scratch port, unlikely to collide with a real `conductor run` (default 4000)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "conductor-sidecar-smoke"));

const sidecarBin = path.join(repoRoot, "packages/core/dist-bin/conductor-server");
const uiDist = path.join(repoRoot, "packages/ui/dist");
const prereqs = [
  [sidecarBin, "bun run --cwd packages/core build:sidecar"],
  [path.join(uiDist, "index.html"), "bun run --cwd packages/ui build"],
];
const missing = prereqs.filter(([p]) => !fs.existsSync(p));
if (missing.length) {
  for (const [p, fix] of missing) console.error(`MISSING ${p}\n  fix: ${fix}`);
  process.exit(2);
}

const chromiumBin = chromium.executablePath();
if (!fs.existsSync(chromiumBin)) {
  console.error(`MISSING Chromium at ${chromiumBin}\n  fix: npx playwright install chromium`);
  process.exit(2);
}

fs.rmSync(outDir, { recursive: true, force: true });
const workspace = path.join(outDir, "workspace"); // sidecar cwd — isolates its auto-created .conductor.yml + SQLite DB
fs.mkdirSync(workspace, { recursive: true });

const serverLog = [];
const consoleErrors = [];
const failures = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(label);
};

const t0 = Date.now();
const server = spawn(sidecarBin, [], {
  cwd: workspace,
  env: { ...process.env, CONDUCTOR_PORT: String(PORT), CONDUCTOR_UI_DIST: uiDist },
});
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));
server.on("error", (e) => serverLog.push(`spawn error: ${e.message}\n`));

const baseUrl = `http://localhost:${PORT}`;
let browser;
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: smoke test exceeded 60s");
  server.kill("SIGKILL");
  browser?.close().finally(() => process.exit(2));
}, 60_000);
try {
  const up = await (async () => {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await globalThis.fetch(`${baseUrl}/api/health`)).ok) return true;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })();
  check(up, "sidecar came up and answered /api/health");
  console.log(`      spawn→up ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  browser = await chromium.launch({ executablePath: chromiumBin, headless: true });
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  await page.goto(baseUrl, { timeout: 30_000, waitUntil: "load" });

  // A blank white window = #root never gets children / body has no text.
  const rendered = await page
    .waitForFunction(
      () =>
        (globalThis.document.querySelector("#root")?.children.length ?? 0) > 0 &&
        globalThis.document.body.innerText.trim().length > 20,
      null,
      { timeout: 15_000 },
    )
    .then(
      () => true,
      () => false,
    );
  check(rendered, "dashboard rendered (non-blank #root)");

  const api = await page.evaluate(async () => {
    const [h, p, pr] = await Promise.all(
      ["/api/health", "/api/profiles", "/api/processes"].map((u) => globalThis.fetch(u)),
    );
    return { health: h.status, profiles: p.status, processes: pr.status };
  });
  check(
    api.health === 200 && api.profiles === 200 && api.processes === 200,
    "sidecar API healthy from the page",
    JSON.stringify(api),
  );
  await page.screenshot({ path: path.join(outDir, "01-dashboard.png") });

  // Drive it like a user. A fresh workspace has no processes, so ProcessBoard
  // renders no tabs - open the Environment view instead, whose scope tabs
  // (Global / <profile>) always exist.
  await page.getByText("Environment", { exact: true }).first().click();
  const envShown = await page
    .getByText("Base path", { exact: true })
    .first()
    .waitFor({ timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
  check(envShown, 'nav "Environment" opens the Environment view');
  const tabs = await page.$$eval('[role="tab"]', (els) =>
    els.map((e) => ({ label: e.textContent?.trim(), selected: e.getAttribute("aria-selected") })),
  );
  const target = tabs.findIndex((t) => t.selected !== "true");
  if (target >= 0) {
    await page.locator('[role="tab"]').nth(target).click();
    const nowSelected = await page
      .locator('[role="tab"]')
      .nth(target)
      .getAttribute("aria-selected");
    check(nowSelected === "true", `clicking tab "${tabs[target].label}" selects it`);
    await page.screenshot({ path: path.join(outDir, "02-environment-tab.png") });
  } else {
    check(false, "found an unselected tab to click", JSON.stringify(tabs));
  }

  check(
    consoleErrors.length === 0,
    "no browser console errors",
    consoleErrors.slice(0, 5).join(" | "),
  );
} catch (err) {
  check(false, "smoke run threw", err.message);
} finally {
  await browser?.close().catch(() => {});
  clearTimeout(watchdog);
}

const exitCode = await new Promise((resolve) => {
  const t = setTimeout(() => {
    server.kill("SIGKILL"); // didn't respond to SIGTERM in time — don't leave it holding the port
    resolve(null);
  }, 5_000);
  server.once("exit", (code) => {
    clearTimeout(t);
    resolve(code);
  });
  server.kill("SIGTERM"); // same signal Tauri's Rust host sends on app quit
});
check(exitCode === 0, "sidecar shut down cleanly on SIGTERM", `exit code ${exitCode}`);
fs.writeFileSync(path.join(outDir, "server.log"), serverLog.join(""));

console.log(`\nartifacts: ${outDir}`);
console.log(failures.length ? `SMOKE FAILED (${failures.length})` : "SMOKE PASSED");
process.exit(failures.length ? 1 : 0);
