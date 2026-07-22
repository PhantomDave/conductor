import { app, BrowserWindow, Menu, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";

// On Linux, disable hardware acceleration early to avoid GPU-related crashes
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
}

// AppImage extracts to a fresh mountpoint under /tmp on every launch, so
// chrome-sandbox can never keep the setuid-root (4755) ownership Chromium's
// sandbox requires - it fails fatally on most modern kernels that restrict
// unprivileged user namespaces (Ubuntu 24.04+, Fedora, etc.). Conductor
// only ever renders its own bundled UI (no remote/untrusted content), so
// disabling the sandbox here is a safe, standard workaround for Electron
// apps distributed as AppImage. --disable-dev-shm-usage is added for the
// same reason it's paired with --no-sandbox in containerized/CI setups:
// some restricted environments give Chromium a /dev/shm it can't actually
// use, and this makes it fall back to a regular temp file instead of
// crashing. Must be set before app is ready.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-dev-shm-usage");
  // Disable GPU acceleration to avoid crashes on systems with GPU issues
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  // Use software rendering as fallback
  app.commandLine.appendSwitch("enable-software-rasterizer");
  // Additional stability flags for restricted Linux environments
  app.commandLine.appendSwitch("disable-features", "TranslateUI,BackingStoreLimit");
  app.commandLine.appendSwitch("disable-extensions");
  app.commandLine.appendSwitch("no-first-run");
  app.commandLine.appendSwitch("disable-breakpad");
  app.commandLine.appendSwitch("disable-client-side-phishing-detection");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("disable-sync");
  // Disable GTK theming integration which may cause crashes on broken GTK setups
  app.commandLine.appendSwitch("disable-gtk-im-module");
  // Force X11 backend if available to avoid Wayland compatibility issues
  // (Chromium/Electron on Wayland can be unstable)
  if (!process.env.WAYLAND_DISPLAY) {
    app.commandLine.appendSwitch("ozone-platform", "x11");
  }
}

let sidecar: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

/** Finds a free TCP port by asking the OS to bind port 0 and reading back
 * whatever it picked - avoids clashing with anything else on the machine
 * (including another instance of Conductor's CLI/server). */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Polls the sidecar's health endpoint until it responds or the timeout
 * elapses, so we don't show a blank/erroring window while it boots. */
async function waitForHealthy(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // Not up yet - keep polling.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Conductor core did not become healthy on port ${port} within ${timeoutMs}ms`);
}

function sidecarBinaryName(): string {
  return process.platform === "win32" ? "conductor-server.exe" : "conductor-server";
}

/** Resolves the sidecar server binary and the built UI bundle, whether
 * we're running from source (dev) or from a packaged app (extraResources). */
function resolvePaths(): { sidecarPath: string; uiDistPath: string } {
  if (app.isPackaged) {
    const resources = process.resourcesPath;
    return {
      sidecarPath: join(resources, "sidecar", sidecarBinaryName()),
      uiDistPath: join(resources, "ui-dist"),
    };
  }

  // Dev mode: run against the freshly-built binary/bundle sitting next to
  // this monorepo checkout (`bun run --cwd packages/core build:sidecar`
  // and `bun run --cwd packages/ui build` before `bun run dev` here).
  const repoRoot = join(__dirname, "..", "..", "..");
  return {
    sidecarPath: join(repoRoot, "packages", "core", "dist-bin", sidecarBinaryName()),
    uiDistPath: join(repoRoot, "packages", "ui", "dist"),
  };
}

async function startSidecar(): Promise<number> {
  const { sidecarPath, uiDistPath } = resolvePaths();

  if (!existsSync(sidecarPath)) {
    throw new Error(
      `Conductor core binary not found at ${sidecarPath}. Run "bun run --cwd packages/core build:sidecar" first.`,
    );
  }

  const port = await findFreePort();
  const userDataDir = app.getPath("userData");

  sidecar = spawn(sidecarPath, [], {
    cwd: userDataDir,
    env: {
      ...process.env,
      CONDUCTOR_PORT: String(port),
      CONDUCTOR_UI_DIST: uiDistPath,
      // Tell the sidecar's logger to skip pino-pretty (see pino.ts - its
      // worker-thread module resolution crashes inside this single-file
      // executable). Deliberately NOT NODE_ENV: env-resolution.ts's
      // baseLayers() inherits the sidecar's own process.env as the base
      // layer for every command Conductor spawns, so setting NODE_ENV
      // here used to leak "production" into every managed dev process -
      // breaking dev-mode tooling (e.g. Next.js's JSX runtime selection)
      // for anything launched through the desktop app, even though the
      // exact same command worked fine run locally.
      CONDUCTOR_LOG_JSON: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  sidecar.stdout?.on("data", (chunk) => process.stdout.write(`[core] ${chunk}`));
  sidecar.stderr?.on("data", (chunk) => process.stderr.write(`[core] ${chunk}`));
  sidecar.on("exit", (code, signal) => {
    console.log(`[core] sidecar exited (code=${code}, signal=${signal})`);
    sidecar = null;
  });

  await waitForHealthy(port);
  return port;
}

/** Sends SIGTERM and gives the sidecar a moment to run its own graceful
 * shutdown (which stops every managed dev process it started) before the
 * app process tree disappears. */
async function stopSidecar(): Promise<void> {
  if (!sidecar || sidecar.exitCode !== null) return;
  const proc = sidecar;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 5_000);
    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

async function createWindow(port: number) {
  try {
    console.log("Creating BrowserWindow...");
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 860,
      title: "Conductor",
      show: false, // Don't show until ready
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    console.log("BrowserWindow created, attaching event handlers...");

    // Any link that would normally navigate away (e.g. a "view on GitHub"
    // link) should open in the OS browser instead of inside the app window.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });

    console.log("Loading URL...");
    await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    
    console.log("Window loaded, showing...");
    mainWindow.show();
  } catch (err) {
    console.error("Failed to create window:", err);
    throw err;
  }
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Conductor",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Check for Updates...", click: () => void autoUpdater.checkForUpdatesAndNotify() },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (!sidecar || sidecar.exitCode !== null) return;
  // Delay quitting until the sidecar (and everything it started) has had
  // a chance to shut down cleanly, instead of orphaning child processes.
  event.preventDefault();
  void stopSidecar().then(() => app.quit());
});

app.whenReady().then(async () => {
  buildMenu();
  try {
    // Check for display server before trying to create window
    if (process.platform === "linux") {
      const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
      if (!display) {
        console.error(
          "No X11 or Wayland display found. Set DISPLAY=:0 or run with a display server.",
        );
        console.error("For headless testing, use Xvfb or similar virtual display.");
        throw new Error("No display server available (set DISPLAY environment variable)");
      }
    }

    const port = await startSidecar();
    await createWindow(port);
  } catch (err) {
    console.error("Failed to start Conductor:", err);
    app.quit();
    return;
  }

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error("Auto-update check failed:", err);
    });
  }
});
