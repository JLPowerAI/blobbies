//! macOS notifications, which the notification plugin cannot deliver:
//! its desktop permission calls are hardcoded to "granted" (so macOS never
//! shows the prompt, never lists the app in System Settings), and its send
//! path rides notify-rust's default backend — the deprecated
//! `NSUserNotification` API, which modern macOS silently drops even for
//! authorized apps.
//!
//! So this module owns both halves on macOS: the authorization ask (once,
//! from the user's own click on Allow) and the send
//! (`UNUserNotificationCenter`, the modern API). Windows and Linux deliver
//! fine through the plugin and stay on it.
//!
//! The permission grant also installs the app's chime: macOS resolves
//! `UNNotificationSound soundNamed:` against the bundle's `Library/Sounds`
//! (which Tauri's bundler cannot populate) or `~/Library/Sounds`, so the
//! bundled resource is copied there on first grant.

// The one `unsafe` in this module dereferences the settings pointer that the
// OS hands its completion block; the pointer is non-null by signature and
// points at an OS-owned object alive for the call.
#![expect(
    unsafe_code,
    reason = "deref of the OS-provided settings pointer in the completion block; unavoidable, audited"
)]

use tauri::Manager;

/// Resource name and install name of the notification chime.
const SOUND_NAME: &str = "blobbies-notif";
/// What `soundNamed:` needs: custom sounds are looked up by filename, and
/// Apple's contract is the name *with* its extension. Bare names match only
/// system sounds, failing silently for bundled ones.
const SOUND_FILE: &str = "blobbies-notif.caf";

/// Ask the OS for alert+sound authorization. Windows and Linux need no
/// separate prompt through this command (the plugin's send path handles
/// them), so it reports granted there.
#[tauri::command]
pub(crate) async fn request_notification_permission(
    app: tauri::AppHandle,
) -> Result<&'static str, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};

        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        // The completion handler: called once with whether the user allowed
        // it. Retained by the notification center for the duration of the
        // request, so it outlives this frame's `block`.
        let block = block2::RcBlock::new(
            move |granted: objc2::runtime::Bool, _error: *mut objc2_foundation::NSError| {
                let _ = tx.send(granted.as_bool());
            },
        );
        let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound;
        center.requestAuthorizationWithOptions_completionHandler(options, &block);
        // Blocks this command's worker thread until the user answers the
        // prompt. Commands run on the async pool (the keyring calls already
        // block the same way), and the UI stays live.
        let granted = rx
            .recv()
            .map_err(|_| "no answer from the notification center".to_string())?;
        if granted {
            install_sound(&app);
        }
        Ok(if granted { "granted" } else { "denied" })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        Ok("granted")
    }
}

/// Send a notification. macOS goes through `UNUserNotificationCenter` directly:
/// the plugin's send path uses notify-rust's default backend, which is the
/// deprecated `NSUserNotification` API that modern macOS silently drops even
/// for authorized apps. Windows and Linux deliver fine through the plugin,
/// so those keep the plugin path in the frontend.
#[tauri::command]
pub(crate) async fn send_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::NSString;
        use objc2_user_notifications::{
            UNMutableNotificationContent, UNNotificationRequest, UNNotificationSound,
            UNUserNotificationCenter,
        };

        let center = UNUserNotificationCenter::currentNotificationCenter();
        if !authorized(&center) {
            return Ok(());
        }
        install_sound(&app);

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        content.setBody(&NSString::from_str(&body));
        content.setSound(Some(&UNNotificationSound::soundNamed(&NSString::from_str(
            SOUND_FILE,
        ))));
        let identifier = format!(
            "{SOUND_NAME}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&identifier),
            &content,
            None,
        );
        center.addNotificationRequest_withCompletionHandler(&request, None);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, title, body);
        Ok(())
    }
}

/// Whether the center is authorized (or provisionally so). Undetermined
/// counts as unauthorized here: the prompt belongs to onboarding's Allow
/// click, not to a background send.
#[cfg(target_os = "macos")]
fn authorized(center: &objc2_user_notifications::UNUserNotificationCenter) -> bool {
    use objc2_user_notifications::UNAuthorizationStatus;
    let (tx, rx) = std::sync::mpsc::channel();
    let block = block2::RcBlock::new(
        move |settings: std::ptr::NonNull<objc2_user_notifications::UNNotificationSettings>| {
            let status = unsafe { settings.as_ref().authorizationStatus() };
            let _ = tx.send(status);
        },
    );
    center.getNotificationSettingsWithCompletionHandler(&block);
    matches!(
        rx.recv(),
        Ok(UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Provisional)
    )
}

/// Copy the bundled chime to `~/Library/Sounds` so macOS can find it by name
/// when a notification asks for `sound: "blobbies-notif"`.
#[cfg(target_os = "macos")]
fn install_sound(app: &tauri::AppHandle) {
    let Ok(home) = app.path().home_dir() else {
        return;
    };
    let dest = home
        .join("Library/Sounds")
        .join(format!("{SOUND_NAME}.caf"));
    if dest.exists() {
        return;
    }
    let Ok(resource) = app.path().resolve(
        format!("resources/sounds/{SOUND_NAME}.caf"),
        tauri::path::BaseDirectory::Resource,
    ) else {
        return;
    };
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::copy(resource, dest);
}
