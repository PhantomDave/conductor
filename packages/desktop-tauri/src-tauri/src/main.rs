// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};
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
    // listener so the sidecar can bind it, avoiding clashes with anything
    // else on the machine.
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
/// as a `resources` entry). The sidecar binary itself doesn't need resolving here:
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
/// stream that cannot be written to: losing a log line is fine, losing
/// the app is not.
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
/// escalating to SIGKILL. CommandChild::kill() alone is a hard kill, not this.
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

/// Settings page "Check for updates": reports the version the updater compares
/// against (tauri.conf.json's, 0.0.0 in dev builds) and the newer one, if any.
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<serde_json::Value, String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "current": app.package_info().version.to_string(),
        "available": update.map(|u| u.version),
    }))
}

const UP_TO_DATE: &str = "Already up to date";

/// Downloads and installs the latest update, then restarts. tauri-plugin-updater
/// installs immediately on download rather than deferring to next quit, hence
/// the explicit restart. On Linux this only works when running as an AppImage.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or(UP_TO_DATE)?;
    println!("[updater] update {} available, downloading", update.version);
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    println!("[updater] installed, restarting");
    app.request_restart();
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let icon = Image::from_bytes(ICON_BYTES)?;
    let about = AboutMetadataBuilder::new()
        .name(Some("Conductor"))
        .version(Some(app.package_info().version.to_string()))
        .authors(Some(vec!["PhantomDave".into()]))
        .comments(Some("Universal task runner & dashboard for developers"))
        .copyright(Some("© 2026 PhantomDave"))
        .license(Some("MIT"))
        .website(Some("https://github.com/PhantomDave/conductor"))
        .website_label(Some("GitHub"))
        .icon(Some(icon))
        .build();
    let app_menu = SubmenuBuilder::new(app, "Conductor")
        .about(Some(about))
        .separator()
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

const ICON_BYTES: &[u8] = include_bytes!("../icons/icon-source.png");

/// GNOME only shows an app icon for windows matched to an installed .desktop
/// file (WM_CLASS / app_id `conductor`), and a bare AppImage installs none -
/// so write one pointing at this AppImage. No-op outside an AppImage.
fn integrate_appimage(app: &AppHandle) -> std::io::Result<()> {
    let Some(appimage) = std::env::var_os("APPIMAGE") else {
        return Ok(());
    };
    let data = app.path().data_dir().map_err(std::io::Error::other)?;
    let icon = data.join("icons/conductor/conductor.png");
    std::fs::create_dir_all(icon.parent().unwrap())?;
    std::fs::write(&icon, ICON_BYTES)?;
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName=Conductor\nComment=Universal task runner & dashboard for developers\nExec=\"{}\"\nIcon={}\nStartupWMClass=conductor\nTerminal=false\n",
        appimage.to_string_lossy(),
        icon.display()
    );
    let apps = data.join("applications");
    std::fs::create_dir_all(&apps)?;
    std::fs::write(apps.join("conductor.desktop"), entry)
}

async fn create_window(app: &AppHandle, port: u16) -> Result<(), String> {
    let icon = Image::from_bytes(ICON_BYTES).map_err(|e| e.to_string())?;

    let origin = format!("http://127.0.0.1:{port}");
    let url: tauri::Url = format!("{origin}/")
        .parse()
        .expect("loopback url is always well-formed");
    let opener = app.clone();
    let new_window_opener = app.clone();
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
        // target="_blank" links (About card) request a new window instead.
        .on_new_window(move |url, _| {
            let _ = new_window_opener.opener().open_url(url.to_string(), None::<&str>);
            tauri::webview::NewWindowResponse::Deny
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
        .invoke_handler(tauri::generate_handler![check_update, install_update])
        .setup(|app| {
            // Before the window exists, so GNOME can match it on creation.
            if cfg!(target_os = "linux") {
                if let Err(err) = integrate_appimage(app.handle()) {
                    eprintln!("[main] AppImage desktop integration failed: {err}");
                }
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<SidecarState>();
                if let Err(err) = start(handle.clone(), state).await {
                    eprintln!("[main] failed to start Conductor: {err}");
                    handle.exit(1);
                }
            });

            // Silent startup check-and-install, packaged builds only.
            if !cfg!(debug_assertions) {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match install_update(handle).await {
                        Err(err) if err != UP_TO_DATE => eprintln!("[updater] {err}"),
                        _ => {}
                    }
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
