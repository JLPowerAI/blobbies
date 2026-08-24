mod capture;
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
mod tray;

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
            capture::capture_list_windows,
            capture::capture_take,
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
            // Best-effort: an app with no tray icon is a smaller failure than
            // no app at all, and every tray action has an equivalent inside
            // the window.
            if let Err(error) = tray::init(app.handle()) {
                eprintln!("could not create the tray icon: {error}");
            }
            Ok(())
        })
        .menu(tray::app_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == tray::HIDE_ID {
                tray::hide_main_window(app);
            }
        })
        // Closing the window puts Blobbies in the tray rather than ending it:
        // routines run on a schedule and finished runs raise notifications, so
        // a red X that killed the process would silently switch those off.
        // ⌘Q lands on the menu item above, and the dock's Quit on the run loop
        // below; the tray's Quit Blobbies is the one way out.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            // ⌘Q, the dock's Quit, "Quit" in the app menu: all of them mean
            // "get this off my screen", and none of them should stop the
            // schedule. Hide instead, exactly like the window's close button.
            //
            // `code` is what separates the two intents — Tauri leaves it
            // `None` for a user gesture and sets it for a programmatic
            // `exit()`, which is what the tray's Quit calls. So the tray item
            // falls straight through here and really does end the process, and
            // it stays the only thing that can.
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => {
                api.prevent_exit();
                tray::hide_main_window(app);
            }
            // Release the model's memory (weights + KV-cache snapshots, gigabytes)
            // as soon as the app closes, instead of waiting out keep_alive.
            tauri::RunEvent::Exit => commands::ollama_unload_on_exit(app),
            _ => {}
        });
}
