// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::path::BaseDirectory;
use tauri::{image::Image, AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    exited: Arc<AtomicBool>,
}

fn find_free_port() -> std::io::Result<u16> {
    // Bind port 0 and read back whatever the OS picked, then drop the
    // listener so the sidecar can bind it - same trick as Electron's
    // findFreePort(), avoids clashing with anything else on the machine.
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.local_addr().map(|addr| addr.port())
}

async fn wait_for_healthy(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/api/health");
    while tokio::time::Instant::now() < deadline {
        if let Ok(res) = client.get(&url).send().await {
            if res.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(format!(
        "Conductor core did not become healthy on port {port} within {timeout:?}"
    ))
}

/// Resolves the built UI bundle, whether we're running from source (dev,
/// staged next to this monorepo checkout) or from a packaged app (bundled
/// as a `resources` entry) - same dev/packaged split as Electron's
/// resolvePaths(). The sidecar binary itself doesn't need resolving here:
/// `app.shell().sidecar()` already knows how to find it in both modes.
fn ui_dist_path(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest_dir
            .join("../../ui/dist")
            .canonicalize()
            .map_err(|e| format!("packages/ui/dist not found ({e}). Run \"bun run --cwd packages/ui build\" first."))
    } else {
        app.path()
            .resolve("ui-dist", BaseDirectory::Resource)
            .map_err(|e| e.to_string())
    }
}

/// Relays a sidecar output line to our own stdout/stderr, tolerating a
/// stream that cannot be written to - same reasoning as Electron's
/// forward(): losing a log line is fine, losing the app is not.
fn forward(prefix: &str, line: &[u8]) {
    use std::io::Write;
    let text = String::from_utf8_lossy(line);
    let mut stream = std::io::stdout();
    let _ = writeln!(stream, "[core] {prefix}{text}");
}

async fn start_sidecar(app: &AppHandle, state: &SidecarState) -> Result<u16, String> {
    let ui_dist = ui_dist_path(app)?;
    let port = find_free_port().map_err(|e| e.to_string())?;

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let (mut rx, child) = app
        .shell()
        .sidecar("conductor-server")
        .map_err(|e| e.to_string())?
        .current_dir(data_dir)
        .env("CONDUCTOR_PORT", port.to_string())
        .env("CONDUCTOR_UI_DIST", ui_dist.to_string_lossy().to_string())
        // Tell the sidecar's logger to skip pino-pretty (single-file-exe
        // worker-thread resolution crashes - see core's pino.ts). Deliberately
        // NOT NODE_ENV: every dev process Conductor spawns inherits the
        // sidecar's own env as a base layer, so setting it here would leak
        // "production" into tooling launched through the desktop app.
        .env("CONDUCTOR_LOG_JSON", "1")
        .spawn()
        .map_err(|e| e.to_string())?;

    let pid = child.pid();
    *state.child.lock().unwrap() = Some(child);

    let exited = state.exited.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => forward("", &line),
                CommandEvent::Stderr(line) => forward("", &line),
                CommandEvent::Terminated(payload) => {
                    println!(
                        "[core] sidecar exited (code={:?}, signal={:?})",
                        payload.code, payload.signal
                    );
                    exited.store(true, Ordering::SeqCst);
                }
                _ => {}
            }
        }
    });
    println!("[core] sidecar spawned (pid={pid}, port={port})");

    wait_for_healthy(port, Duration::from_secs(15)).await?;
    Ok(port)
}

/// Sends SIGTERM and gives the sidecar up to 5s to run its own graceful
/// shutdown (which stops every managed dev process it started) before
/// escalating to SIGKILL - same two-step teardown as Electron's
/// stopSidecar(). CommandChild::kill() alone is a hard kill, not this.
async fn stop_sidecar(state: &SidecarState) {
    let Some(child) = state.child.lock().unwrap().take() else {
        return;
    };
    if state.exited.load(Ordering::SeqCst) {
        return;
    }

    #[cfg(windows)]
    {
        let _ = child.kill();
        return;
    }

    #[cfg(unix)]
    {
        let pid = child.pid();
        drop(child);
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !state.exited.load(Ordering::SeqCst) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if !state.exited.load(Ordering::SeqCst) {
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
    }
}

/// Checks for an update and installs it if one is available, mirroring
/// Electron's autoUpdater.checkForUpdatesAndNotify() - but tauri-plugin-updater
/// installs immediately on download rather than deferring to next quit, so we
/// explicitly restart once the install finishes. `log_if_current` distinguishes
/// the menu-triggered check (should say something either way) from the silent
/// startup check (Electron only logs there, never prompts).
async fn check_for_updates(app: AppHandle, log_if_current: bool) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(err) => {
            eprintln!("[updater] unavailable: {err}");
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            println!("[updater] update {} available, downloading", update.version);
            if let Err(err) = update.download_and_install(|_, _| {}, || {}).await {
                eprintln!("[updater] download/install failed: {err}");
                return;
            }
            println!("[updater] installed, restarting");
            app.request_restart();
        }
        Ok(None) => {
            if log_if_current {
                println!("[updater] already up to date");
            }
        }
        Err(err) => eprintln!("[updater] check failed: {err}"),
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(app, "Conductor")
        .about(None)
        .separator()
        .text("check_for_updates", "Check for Updates...")
        .quit()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let menu = MenuBuilder::new(app).items(&[&app_menu, &edit_menu]).build()?;
    app.set_menu(menu)?;
    Ok(())
}

async fn create_window(app: &AppHandle, port: u16) -> Result<(), String> {
    let icon_bytes = include_bytes!("../../../desktop/build/icon.png");
    let icon = Image::from_bytes(icon_bytes).map_err(|e| e.to_string())?;

    let origin = format!("http://127.0.0.1:{port}");
    let url: tauri::Url = format!("{origin}/")
        .parse()
        .expect("loopback url is always well-formed");
    let opener = app.clone();
    let nav_origin = origin.clone();

    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Conductor")
        .inner_size(1280.0, 860.0)
        .icon(icon)
        .map_err(|e| e.to_string())?
        .visible(false)
        // Any navigation off our own sidecar origin (e.g. a "view on GitHub"
        // link) opens in the OS browser instead of inside the app window -
        // same intent as Electron's setWindowOpenHandler.
        .on_navigation(move |url| {
            if url.origin().unicode_serialization() == nav_origin {
                return true;
            }
            let _ = opener.opener().open_url(url.to_string(), None::<&str>);
            false
        })
        .build()
        .map_err(|e| e.to_string())?;

    println!("[main] window loaded, showing");
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

async fn start(app: AppHandle, state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    if cfg!(target_os = "linux") {
        let has_display = std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some();
        if !has_display {
            return Err("No X11 or Wayland display found. Set DISPLAY=:0 or run with a display server.".into());
        }
    }

    build_menu(&app).map_err(|e| e.to_string())?;
    let port = start_sidecar(&app, &state).await?;
    create_window(&app, port).await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SidecarState {
            child: Mutex::new(None),
            exited: Arc::new(AtomicBool::new(false)),
        })
        .setup(|app| {
            app.on_menu_event(|app, event| {
                if event.id() == "check_for_updates" {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        check_for_updates(handle, true).await;
                    });
                }
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<SidecarState>();
                if let Err(err) = start(handle.clone(), state).await {
                    eprintln!("[main] failed to start Conductor: {err}");
                    handle.exit(1);
                }
            });

            // Silent startup check, packaged builds only - same gating as
            // Electron's app.isPackaged check before checkForUpdatesAndNotify().
            if !cfg!(debug_assertions) {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    check_for_updates(handle, false).await;
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::ExitRequested { .. }) {
                let state = app_handle.state::<SidecarState>().inner();
                let child_is_live = state.child.lock().unwrap().is_some();
                if child_is_live {
                    let handle = app_handle.clone();
                    tauri::async_runtime::block_on(async move {
                        stop_sidecar(handle.state::<SidecarState>().inner()).await;
                    });
                }
            }
        });
}
