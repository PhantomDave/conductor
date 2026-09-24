fn main() {
    // Declaring the app's commands generates allow-* permissions, which the
    // remote-origin capability in capabilities/sidecar-ui.json grants.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["check_update", "install_update"]),
    ))
    .expect("failed to run tauri-build")
}
