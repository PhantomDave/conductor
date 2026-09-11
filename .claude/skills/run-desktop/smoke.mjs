// Smoke test for the Conductor Electron desktop app (dev mode).
//
//   node .claude/skills/run-desktop/smoke.mjs [desktopDir] [outDir]
//
// Launches the REAL app, deliberately WITHOUT --no-sandbox (that switch caused
// the blank-white-window renderer crash fixed in #56), waits for the dashboard
// to render, checks the sidecar API from inside the page, drives the UI (nav ->
// Environment -> switch a scope tab), screenshots, then quits and checks the
// main-process log for renderer deaths and a clean sidecar shutdown.
// Exit code 0 = pass, 1 = a check failed, 2 = prerequisites missing / hang.
import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Node globals come from explicit imports (and browser ones via globalThis
// inside page callbacks) so this file passes no-undef with no env config.
import console from "node:console";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopDir = path.resolve(process.argv[2] ?? path.join(repoRoot, "packages/desktop"));
const outDir = path.resolve(process.argv[3] ?? path.join(os.tmpdir(), "conductor-electron-smoke"));

const electronBin = path.join(desktopDir, "node_modules/electron/dist/electron");
const prereqs = [
  [electronBin, "node packages/desktop/node_modules/electron/install.js"],
  [path.join(desktopDir, "dist/main.js"), "bun run --cwd packages/desktop build:main"],
  [
    path.join(desktopDir, "../core/dist-bin/conductor-server"),
    "bun run --cwd packages/core build:sidecar",
  ],
  [path.join(desktopDir, "../ui/dist/index.html"), "bun run --cwd packages/ui build"],
];
const missing = prereqs.filter(([p]) => !fs.existsSync(p));
if (missing.length) {
  for (const [p, fix] of missing) console.error(`MISSING ${p}\n  fix: ${fix}`);
  process.exit(2);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: smoke test exceeded 150s");
  process.exit(2);
}, 150_000);

const mainLog = [];
const consoleErrors = [];
const failures = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(label);
};

const t0 = Date.now();
const app = await electron.launch({
  executablePath: electronBin,
  args: [desktopDir],
  // Isolate userData (the sidecar's cwd + SQLite DB) from the real ~/.config.
  env: { ...process.env, XDG_CONFIG_HOME: path.join(outDir, "xdg-config") },
  timeout: 60_000,
});
const proc = app.process();
proc.stdout?.on("data", (d) => mainLog.push(String(d)));
proc.stderr?.on("data", (d) => mainLog.push(String(d)));

try {
  const page = await app.firstWindow({ timeout: 60_000 });
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
  await page.waitForLoadState("load");
  check(true, "window loaded sidecar URL", page.url());

  // A blank white window = #root never gets children / body has no text.
  const rendered = await page
    .waitForFunction(
      () =>
        (globalThis.document.querySelector("#root")?.children.length ?? 0) > 0 &&
        globalThis.document.body.innerText.trim().length > 20,
      null,
      { timeout: 30_000 },
    )
    .then(
      () => true,
      () => false,
    );
  check(rendered, "dashboard rendered (non-blank #root)");
  console.log(`      launch→render ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const wins = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      title: w.getTitle(),
      visible: w.isVisible(),
      crashed: w.webContents.isCrashed(),
    })),
  );
  check(
    wins.length === 1 && wins[0].visible && !wins[0].crashed,
    "main window visible, renderer alive",
    JSON.stringify(wins),
  );

  const api = await page.evaluate(async () => {
    const [h, p, pr] = await Promise.all(
      ["/api/health", "/api/profiles", "/api/processes"].map((u) => globalThis.fetch(u)),
    );
    return { health: h.status, profiles: p.status, processes: pr.status };
  });
  check(
    api.health === 200 && api.profiles === 200 && api.processes === 200,
    "sidecar API healthy from renderer",
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
    "no renderer console errors",
    consoleErrors.slice(0, 5).join(" | "),
  );
} catch (err) {
  check(false, "smoke run threw", err.message);
} finally {
  await app.close().catch(() => {});
  clearTimeout(watchdog);
}

const log = mainLog.join("");
fs.writeFileSync(path.join(outDir, "main-process.log"), log);
check(/Window loaded, showing/.test(log), "main process reached 'Window loaded, showing'");
check(
  !/Renderer process gone: reason=(?!clean-exit)/.test(log),
  "no abnormal renderer death in main log",
);
check(!/Failed to (load|start Conductor|create window)/.test(log), "no load/start failures");
check(/sidecar exited \(code=0/.test(log), "sidecar shut down cleanly (exit code 0)");

console.log(`\nartifacts: ${outDir}`);
console.log(failures.length ? `SMOKE FAILED (${failures.length})` : "SMOKE PASSED");
process.exit(failures.length ? 1 : 0);
