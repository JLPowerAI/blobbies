mod commands;
mod error;

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
        .invoke_handler(tauri::generate_handler![commands::greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
