mod commands;
mod error;
mod store;

pub use error::Error;

/// Build and run the Tauri application.
///
/// # Panics
/// Panics if the webview runtime cannot be initialised, which is unrecoverable.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[expect(
    clippy::expect_used,
    reason = "there is no UI left to report into if the webview runtime fails to start"
)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::ollama_installed,
            commands::ollama_start,
            commands::host_is_public,
            store::store_read,
            store::store_write,
            store::store_delete_blob,
            store::store_list_blobs
        ])
        .setup(|app| {
            store::startup_maintenance(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Release the model's memory (weights + KV-cache snapshots, gigabytes)
            // as soon as the app closes, instead of waiting out keep_alive.
            if matches!(event, tauri::RunEvent::Exit) {
                commands::ollama_unload_on_exit(app);
            }
        });
}
