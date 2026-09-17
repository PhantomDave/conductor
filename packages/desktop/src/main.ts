import { app, BrowserWindow, dialog, Menu, shell } from "electron";
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
// setuid sandbox helper requires - it fails fatally on most modern kernels
// that restrict unprivileged user namespaces (Ubuntu 24.04+, Fedora, etc.).
// --disable-setuid-sandbox skips that helper while KEEPING the namespace
// sandbox. Must be set before app is ready.
//
// Deliberately NOT --no-sandbox, which is what this used to be. That switch
// tears down the whole sandbox, and an unsandboxed renderer allocates its own
// shared memory rather than having the browser process broker it. On some
// kernels that allocation fails and Chromium answers with a fatal CHECK():
//
//   ERROR ... Creating shared memory in /dev/shm/.org.chromium.Chromium.XXXXXX
//             failed: No such process (3)
//   FATAL ... This is frequently caused by incorrect permissions on /dev/shm.
//
// The renderer then dies of SIGTRAP the instant a page loads, which presents
// as a blank white window with nothing logged in the main process. That last
// line is a red herring - it reproduced on a host whose /dev/shm was mode
// 1777 with 31GB free. Bisected against a minimal Electron app, three runs
// each: no switches survives, --no-sandbox crashes, this one survives.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("disable-setuid-sandbox");
  // Everything that used to live here - disable-gpu, disable-gpu-compositing,
  // enable-software-rasterizer, disable-features=TranslateUI/BackingStoreLimit,
  // disable-extensions, no-first-run, disable-breakpad, disable-sync,
  // disable-gtk-im-module and friends - is gone. Bisected individually against
  // a minimal Electron app, none of them was needed to render, and the crash
  // they were nominally guarding against turned out to come from --no-sandbox
  // above. That is not proof they never helped some other machine, so: add any
  // of them back, but only with a reproduction attached.
  //
  // The ozone/x11 block that used to sit here was also inverted: it read
  // `if (!process.env.WAYLAND_DISPLAY)` while its comment claimed to force X11
  // to dodge Wayland instability, so it only ever applied X11 on sessions that
  // were already using X11. Forcing X11 was separately confirmed not to affect
  // the crash, so it is gone rather than corrected - Electron handles Wayland
  // via --ozone-platform-hint if it is ever actually wanted.
}

let sidecar: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
/** Set once shutdown starts, so teardown noise (a renderer going away because
 * we are quitting) is not reported as a failure. */
let isQuitting = false;

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

/** Relays a sidecar output chunk to our own stdout/stderr, tolerating a
 * stream that cannot be written to. A double-clicked AppImage has no
 * terminal attached, and a piped launch can have its reader go away at any
 * time - in both cases the write raises EPIPE, and an unhandled EPIPE takes
 * down the whole main process with a modal "A JavaScript error occurred"
 * dialog. Losing a log line is fine; losing the app is not. */
function forward(stream: NodeJS.WriteStream, chunk: Buffer | string): void {
  try {
    stream.write(`[core] ${chunk.toString()}`);
  } catch {
    // Stream is closed or broken - drop the line.
  }
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

  sidecar.stdout?.on("data", (chunk) => forward(process.stdout, chunk));
  sidecar.stderr?.on("data", (chunk) => forward(process.stderr, chunk));
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

    // A renderer that dies takes the page with it but leaves the window
    // frame up, so the only symptom is a blank white rectangle and a silent
    // main process. Surface the reason instead - `details.reason` is what
    // distinguishes a Chromium CHECK() abort from an OOM kill or a plain
    // crash, and it is the difference between a one-line diagnosis and an
    // afternoon of bisecting launch flags.
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      const message = `Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`;
      // "clean-exit" is what a normal shutdown looks like - the renderer goes
      // away because we asked it to. Only an unexpected death is news, and
      // only then is a modal warranted; popping one during quit would put an
      // error box in front of every user who simply closed the app.
      if (details.reason === "clean-exit" || isQuitting) {
        console.log(message);
        return;
      }
      console.error(message);
      dialog.showErrorBox("Conductor: the UI process stopped", message);
    });

    // Distinct failure: the renderer is alive but the page never loaded
    // (sidecar died mid-request, wrong port, UI bundle missing).
    mainWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL) => {
        console.error(`Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
      },
    );

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
  isQuitting = true;
  if (!sidecar || sidecar.exitCode !== null) return;
  // Delay quitting until the sidecar (and everything it started) has had
  // a chance to shut down cleanly, instead of orphaning child processes.
  event.preventDefault();
  void stopSidecar().then(() => app.quit());
});

void app.whenReady().then(async () => {
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
