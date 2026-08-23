//! Screen and window capture, so a Blob can look at something on screen —
//! a web page, an app window, or the whole display.
//!
//! **This is the widest-reaching tool in the app, and the containment is
//! deliberately not "the model will be sensible".**
//!
//! What bounds it:
//! - **The OS gate is the real one.** macOS will not hand any process window
//!   pixels without Screen Recording consent, granted by the user in System
//!   Settings, per app, revocable. Nothing here can ask for it or work around
//!   it; a refusal surfaces as an ordinary error.
//! - **The capture lands in the Blob's home folder**, through the same
//!   `resolve_in_home` sandbox as every other file this app writes. It is a
//!   file the user can open, keep or delete, not a hidden buffer.
//! - **Every capture is visible in the transcript.** The picture is shown in
//!   the chat as it is taken, including on a routine that runs unattended, so
//!   capture cannot happen quietly. That visibility is the compensating
//!   control for the fact that a Blob also has `web_fetch` in the same turn:
//!   it does not prevent an injected instruction from asking for a screenshot,
//!   it makes the ask impossible to hide.
//! - **Bounded size.** Captures are downscaled before they are encoded, so one
//!   screenshot cannot fill the home budget or a context window.
//!
//! What remains reachable, stated plainly: with Screen Recording granted, a
//! prompt injection carried in a fetched page can ask a Blob to capture the
//! screen, and the screen may hold anything the user has open. The user's own
//! consent and the visible transcript are what stand between those two facts.
//! Anyone widening this file should assume the argv is chosen by a hostile web
//! page and read it again with that in mind.

use crate::error::{Error, Result};
use serde::Serialize;

// Everything below is the capture implementation itself, absent on platforms
// this is not built for (see the module docs and Cargo.toml).
#[cfg(any(target_os = "macos", target_os = "windows"))]
use crate::home::{home_root, write_bytes};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use base64::Engine as _;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use base64::engine::general_purpose::STANDARD as BASE64;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use image::codecs::png::PngEncoder;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use image::{ImageEncoder, RgbaImage, imageops::FilterType};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use xcap::{Monitor, Window};

/// Longest edge of a saved capture, in pixels.
///
/// Retina displays hand back 3–6k-pixel frames, which are megabytes of PNG and
/// far more detail than OCR or a vision model needs. 1600 keeps window text
/// legible while putting a full-screen capture in the low hundreds of KB.
#[cfg(any(target_os = "macos", target_os = "windows"))]
const MAX_EDGE: u32 = 1600;

/// Ceiling for one encoded capture. Well above a downscaled screenshot, so it
/// only ever catches something pathological before it reaches the home budget.
#[cfg(any(target_os = "macos", target_os = "windows"))]
const MAX_CAPTURE_BYTES: u64 = 8 * 1024 * 1024;

/// A window a Blob could capture, as offered to the model for discovery.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowInfo {
    pub id: u32,
    pub app: String,
    pub title: String,
}

/// A finished capture: where it was saved, and the bytes to show and read.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capture {
    /// File name inside the Blob's home folder.
    pub name: String,
    /// Absolute path, so the UI can reveal the full-resolution file on click.
    pub path: String,
    /// Base64 PNG, so the caller can preview, OCR and send it without a
    /// second read path for binary files.
    pub png: String,
    pub width: u32,
    pub height: u32,
}

/// Windows currently on screen, minimized ones excluded.
///
/// This is also the app's honest permission probe: on macOS without Screen
/// Recording consent the window list comes back with empty titles rather than
/// failing, which the caller reports as "grant access" instead of "no windows".
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
pub(crate) fn capture_list_windows() -> Result<Vec<WindowInfo>> {
    Err(Error::CaptureUnsupported)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
pub(crate) fn capture_list_windows() -> Result<Vec<WindowInfo>> {
    let windows = Window::all().map_err(|error| Error::Capture(error.to_string()))?;
    let mut listed = Vec::new();
    for window in windows {
        // Any of these can fail per-window (the window closed mid-enumeration);
        // one bad entry must not lose the whole list.
        let (Ok(id), Ok(app), Ok(title)) = (window.id(), window.app_name(), window.title()) else {
            continue;
        };
        if window.is_minimized().unwrap_or(false) || (app.is_empty() && title.is_empty()) {
            continue;
        }
        listed.push(WindowInfo { id, app, title });
    }
    Ok(listed)
}

/// Capture a window by id, or the primary monitor when `window_id` is absent.
///
/// `name` is the file to write inside the Blob's home; it goes through the
/// same path sandbox as every other write, so a model-chosen name cannot
/// escape the folder.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
pub(crate) fn capture_take(
    _app: tauri::AppHandle,
    _id: &str,
    _name: &str,
    _window_id: Option<u32>,
) -> Result<Capture> {
    Err(Error::CaptureUnsupported)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn capture_take(
    app: tauri::AppHandle,
    id: &str,
    name: &str,
    window_id: Option<u32>,
) -> Result<Capture> {
    let image = match window_id {
        Some(wanted) => capture_window(wanted)?,
        None => capture_primary()?,
    };
    let image = downscale(image);
    let (width, height) = (image.width(), image.height());

    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            image.as_raw(),
            width,
            height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| Error::Capture(error.to_string()))?;

    let home = home_root(&crate::store::data_root(&app)?, id)?;
    write_bytes(&home, name, &png, MAX_CAPTURE_BYTES)?;
    // Re-resolved rather than joined by hand: this is the one path that leaves
    // the sandbox as a string, so it goes through the same containment check
    // that decided where the bytes were allowed to land.
    let path = crate::home::resolve_in_home(&home, name)?;

    Ok(Capture {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        png: BASE64.encode(&png),
        width,
        height,
    })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn capture_window(wanted: u32) -> Result<RgbaImage> {
    let windows = Window::all().map_err(|error| Error::Capture(error.to_string()))?;
    let found = windows
        .into_iter()
        .find(|window| window.id().is_ok_and(|id| id == wanted))
        .ok_or(Error::WindowGone)?;
    found
        .capture_image()
        .map_err(|error| Error::Capture(error.to_string()))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn capture_primary() -> Result<RgbaImage> {
    let monitors = Monitor::all().map_err(|error| Error::Capture(error.to_string()))?;
    let primary = monitors
        .iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or(Error::WindowGone)?;
    primary
        .capture_image()
        .map_err(|error| Error::Capture(error.to_string()))
}

/// Shrink to `MAX_EDGE` on the longest side, preserving aspect. Images already
/// within the cap are returned untouched rather than re-sampled.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn downscale(image: RgbaImage) -> RgbaImage {
    let longest = image.width().max(image.height());
    if longest <= MAX_EDGE || longest == 0 {
        return image;
    }
    // Integer math, in u64: the f64 route needs two lossy casts back to u32,
    // and the values here are pixel counts that never need a mantissa.
    // `max(1)` because a very long, thin window would otherwise scale to zero
    // and the encoder would reject the dimensions.
    let scale = |edge: u32| -> u32 {
        u32::try_from(u64::from(edge) * u64::from(MAX_EDGE) / u64::from(longest))
            .unwrap_or(MAX_EDGE)
            .max(1)
    };
    image::imageops::resize(
        &image,
        scale(image.width()),
        scale(image.height()),
        FilterType::Triangle,
    )
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downscale_caps_the_longest_edge_and_keeps_aspect() {
        let wide = downscale(RgbaImage::new(3840, 2160));
        assert_eq!(wide.width(), MAX_EDGE);
        assert_eq!(wide.height(), 900);

        let tall = downscale(RgbaImage::new(1000, 4000));
        assert_eq!(tall.height(), MAX_EDGE);
        assert_eq!(tall.width(), 400);
    }

    #[test]
    fn downscale_leaves_a_small_capture_alone() {
        let small = downscale(RgbaImage::new(800, 600));
        assert_eq!((small.width(), small.height()), (800, 600));
    }

    #[test]
    fn downscale_never_rounds_a_thin_window_to_zero() {
        // A 1px-wide strip scaled by 1600/8000 rounds to 0, which the PNG
        // encoder rejects outright.
        let thin = downscale(RgbaImage::new(1, 8000));
        assert!(thin.width() >= 1 && thin.height() >= 1);
    }

    #[test]
    fn base64_carries_bytes_that_are_not_text() {
        // The capture crosses to the webview as base64 because a PNG is not
        // UTF-8; this pins the encoding the TS side decodes.
        let png_magic = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(BASE64.encode(png_magic), "iVBORw0KGgo=");
    }
}
