mod commands;
mod error;
mod home;
mod notifications;
mod oauth;
mod ocr;
mod secrets;
mod shell;
mod skills;
mod store;
mod textutil;

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
        .plugin(tauri_plugin_notification::init())
        // Updater: checks this repo's GitHub Releases for a newer version and
        // installs it in place. Process: relaunches the app after an update.
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::ollama_installed,
            commands::ollama_start,
            commands::host_is_public,
            shell::shell_allowed,
            shell::shell_run,
            store::store_read,
            store::store_write,
            store::store_delete_blob,
            store::store_list_blobs,
            store::store_export_blob,
            home::blob_home_list,
            home::blob_home_read,
            home::blob_home_write,
            home::blob_home_delete,
            ocr::ocr_image,
            notifications::request_notification_permission,
            notifications::send_notification,
            oauth::oauth_listen_port,
            oauth::oauth_await_redirect,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            skills::skills_list
        ])
        .setup(|app| {
            store::startup_maintenance(app.handle());
            skills::seed_bundled(app.handle());
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
