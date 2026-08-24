//! The menu bar / system tray presence.
//!
//! Blobbies keeps working with its window shut — routines fire on a schedule
//! and finished runs raise OS notifications — so closing the window hides it
//! instead of ending the process (see `lib.rs`). That trade only works if the
//! running app is visible and reachable somewhere, which is this icon: click
//! it to get the window back, or to quit for real.
//!
//! Three items, deliberately: open, update, quit. Everything else already has
//! a home in the app itself.

#[cfg(target_os = "macos")]
use tauri::image::Image;
use tauri::{
    AppHandle, Emitter, Manager, Runtime,
    menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconId},
};

/// Emitted when "Check for Updates" is chosen. The updater lives in the
/// webview (`src/lib/updater.ts`), which owns the whole check → download →
/// install state machine and the UI that reports it; duplicating any of that
/// in Rust would give the same release two sources of truth.
pub(crate) const CHECK_UPDATES_EVENT: &str = "tray://check-for-updates";

const OPEN_ID: &str = "tray-open";
const UPDATES_ID: &str = "tray-check-updates";
const QUIT_ID: &str = "tray-quit";

/// The ⌘Q item that replaces the standard macOS Quit.
pub(crate) const HIDE_ID: &str = "app-hide-to-tray";

/// The standard menu, with macOS's Quit swapped for "Hide to Menu Bar".
///
/// ⌘Q has to be caught here rather than in the run loop: the predefined Quit
/// item is the macOS `terminate:` action, which tears the process down without
/// ever raising `ExitRequested`, so there is nothing to prevent by the time
/// Tauri hears about it. A plain menu item with the same shortcut gives the
/// keystroke somewhere to land.
///
/// Everything else about the menu is left alone — replacing it wholesale would
/// take Edit with it, and a chat app without ⌘C is not a trade worth making.
///
/// # Errors
/// Returns the Tauri error if the default menu or the replacement item cannot
/// be built.
pub(crate) fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;

    // macOS only: the other platforms keep Quit under File, where it is the
    // ordinary way to leave an app and not a reflex.
    #[cfg(target_os = "macos")]
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
        // Quit is the last item of the app menu (see `Menu::default`), and the
        // only predefined one down there.
        if let Some(MenuItemKind::Predefined(quit)) = app_menu.items()?.last() {
            app_menu.remove(quit)?;
        }
        // Named for what it does. Calling it "Quit" while it declines to quit
        // is how an app earns a reputation for ignoring its own menus.
        let hide = MenuItem::with_id(app, HIDE_ID, "Hide to Menu Bar", true, Some("CmdOrCtrl+Q"))?;
        app_menu.append(&hide)?;
    }

    Ok(menu)
}

/// A blob face, alpha only, for the macOS menu bar.
///
/// Menu bar icons are template images: the system paints them with the current
/// menu bar's foreground colour, so it must be the silhouette (the eyes are
/// punched through) rather than the app's blue gradient, which would stay blue
/// on a dark menu bar and look pasted on. Other platforms get the normal app
/// icon, where a flat black shape would disappear on a dark taskbar.
#[cfg(target_os = "macos")]
const TEMPLATE_ICON: &[u8] = include_bytes!("../icons/tray-template.png");

/// Build the tray icon and its menu.
///
/// # Errors
/// Returns the Tauri error if the menu, the icon or the tray cannot be built —
/// the caller logs it and keeps going, since an app with no tray icon is a
/// smaller failure than no app at all.
pub(crate) fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open Blobbies", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, UPDATES_ID, "Check for Updates…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit Blobbies", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &updates, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TrayIconId::new("main"))
        .menu(&menu)
        // The menu is the whole interaction, so open it on either button.
        // Left-click-shows-window is a Windows habit that on macOS just makes
        // the icon feel broken half the time.
        .show_menu_on_left_click(true)
        .tooltip("Blobbies")
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => show_main_window(app),
            UPDATES_ID => {
                // Show the window first: the check reports into the Updates
                // tab, and an update that downloads behind a hidden window is
                // indistinguishable from a menu item that did nothing.
                show_main_window(app);
                let _ = app.emit(CHECK_UPDATES_EVENT, ());
            }
            QUIT_ID => app.exit(0),
            _ => {}
        });

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .icon(Image::from_bytes(TEMPLATE_ICON)?)
            .icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
    }

    builder.build(app)?;
    Ok(())
}

/// Put the main window away without ending the process — what ⌘Q does now.
///
/// The app itself is hidden too on macOS, or it would keep the menu bar and
/// stay frontmost with nothing on screen, which reads as a hang.
pub(crate) fn hide_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.hide();
}

/// Bring the main window back: un-hide, un-minimise, focus.
///
/// All three, because the window can be in any of those states and each one
/// alone leaves a case where the menu item appears to do nothing — hidden
/// windows ignore `set_focus`, minimised ones ignore `show`.
pub(crate) fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    // Un-hide the *app* first. ⌘Q hides the whole application, and while it is
    // hidden macOS ignores requests to show or focus its windows — do this the
    // other way round and the first reopen after a ⌘Q does nothing.
    #[cfg(target_os = "macos")]
    let _ = app.show();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}
