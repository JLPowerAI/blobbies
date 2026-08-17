//! On-device OCR for attached images and scanned PDF pages.
//!
//! Lives in Rust rather than the webview on purpose. The webview alternative
//! (tesseract.js) needs `'wasm-unsafe-eval'` in `script-src`, which `WKWebView`
//! applies to the whole page — trading the app's main containment boundary for
//! one feature. Here, only the extracted text crosses IPC.
//!
//! Everything below runs on bytes the user got from someone else, so the two
//! decoders are fenced: `image` is compiled with only the formats we accept
//! and given explicit allocation limits, and the pixel budget is checked from
//! the *header* before a single frame is decoded.

use std::io::Cursor;
use std::sync::OnceLock;

use image::ImageReader;
use image::error::{LimitError, LimitErrorKind};
use ocrs::{ImageSource, OcrEngine, OcrEngineParams};
use rten::Model;

use crate::error::{Error, Result};

/// Cap on an image handed to OCR. Larger than a page scan at 300 dpi, far
/// below what would make the decoder a memory problem.
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

/// Cap on decoded pixels (~50 megapixels), checked before decoding. A few
/// hundred KB of PNG can claim gigabytes once expanded; this is the check that
/// makes a decompression bomb a refusal rather than an OOM.
const MAX_PIXELS: u64 = 50_000_000;

/// Ceiling on returned text, mirroring the per-file cap in `home.rs`.
const MAX_TEXT_BYTES: usize = 256 * 1024;

/// Model weights, embedded at build time (see `build.rs`) so OCR works with no
/// network and no first-run download.
const DETECTION_MODEL: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/text-detection.rten"));
const RECOGNITION_MODEL: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/text-recognition.rten"));

/// Built once and reused: parsing 12 MB of weights per image would dominate
/// the runtime of OCR itself.
static ENGINE: OnceLock<std::result::Result<OcrEngine, String>> = OnceLock::new();

fn engine() -> Result<&'static OcrEngine> {
    ENGINE
        .get_or_init(|| {
            // `to_vec` because the model loader needs owned, aligned data;
            // `include_bytes!` only guarantees byte alignment.
            let detection =
                Model::load(DETECTION_MODEL.to_vec()).map_err(|error| error.to_string())?;
            let recognition =
                Model::load(RECOGNITION_MODEL.to_vec()).map_err(|error| error.to_string())?;
            OcrEngine::new(OcrEngineParams {
                detection_model: Some(detection),
                recognition_model: Some(recognition),
                ..Default::default()
            })
            .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| Error::Ocr(error.clone()))
}

/// Read the text in an image.
///
/// Takes a `Request` so the image arrives as a raw IPC body: as a normal
/// argument it would be JSON, i.e. megabytes of image as a list of numbers.
///
/// Returns an empty string when the image simply has no text in it — that is
/// an answer, not a failure, and the caller phrases it for the user.
#[tauri::command]
pub(crate) async fn ocr_image(request: tauri::ipc::Request<'_>) -> Result<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::Ocr("image couldn't be read".into()));
    };
    if bytes.is_empty() {
        return Err(Error::EmptyInput);
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(Error::FileTooLarge);
    }
    let bytes = bytes.clone();
    // OCR is seconds of CPU; on the async runtime's thread it would stall
    // every other command for the duration.
    tauri::async_runtime::spawn_blocking(move || recognize(&bytes))
        .await
        .map_err(|error| Error::Ocr(format!("OCR task failed: {error}")))?
}

/// A decoder for these bytes, with the format sniffed from content (never a
/// caller-supplied MIME type) and an allocation ceiling of its own — that
/// ceiling is what covers formats whose decoded size is not known up front.
fn reader(bytes: &[u8]) -> Result<ImageReader<Cursor<&[u8]>>> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| Error::Ocr("image couldn't be read".into()))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_PIXELS * 4);
    reader.limits(limits);
    Ok(reader)
}

fn recognize(bytes: &[u8]) -> Result<String> {
    // Read the dimensions first and decode only if they pass: a few hundred KB
    // of PNG can legally claim hundreds of megapixels, and decoding it is the
    // whole attack. `reader()` is consumed by both calls, hence two of them.
    let (width, height) = reader(bytes)?
        .into_dimensions()
        .map_err(|error| Error::Ocr(describe(&error)))?;
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(Error::Ocr("image is too large to read".into()));
    }

    let decoded = reader(bytes)?
        .decode()
        .map_err(|error| Error::Ocr(describe(&error)))?;

    // Composite onto white rather than calling `into_rgb8()`, which drops the
    // alpha channel and so turns a transparent background black — black text
    // on black reads as no text at all. Screenshots and exported logos are
    // routinely RGBA, so this is the common case, not an edge one.
    let mut image = decoded.into_rgba8();
    for pixel in image.pixels_mut() {
        let [red, green, blue, alpha] = pixel.0;
        // Source-over onto white, rounded: v*a + 255*(255-a), over 255.
        let over = |value: u8| {
            let blended =
                (u32::from(value) * u32::from(alpha) + 255 * (255 - u32::from(alpha)) + 127) / 255;
            u8::try_from(blended).unwrap_or(u8::MAX)
        };
        pixel.0 = [over(red), over(green), over(blue), u8::MAX];
    }
    let image = image::DynamicImage::ImageRgba8(image).into_rgb8();

    let source = ImageSource::from_bytes(image.as_raw(), image.dimensions())
        .map_err(|error| Error::Ocr(error.to_string()))?;
    let engine = engine()?;
    let input = engine
        .prepare_input(source)
        .map_err(|error| Error::Ocr(error.to_string()))?;
    let mut text = engine
        .get_text(&input)
        .map_err(|error| Error::Ocr(error.to_string()))?;
    if text.len() > MAX_TEXT_BYTES {
        // Cut on a char boundary: `text` is UTF-8 and slicing mid-sequence panics.
        let cut = (0..=MAX_TEXT_BYTES)
            .rev()
            .find(|index| text.is_char_boundary(*index))
            .unwrap_or(0);
        text.truncate(cut);
    }
    Ok(text)
}

/// Keep decoder errors free of internals while still telling the user which
/// half went wrong: an unreadable file and an oversized one need different
/// responses from them.
fn describe(error: &image::ImageError) -> String {
    match error {
        image::ImageError::Limits(limit)
            if matches!(
                LimitError::kind(limit),
                LimitErrorKind::DimensionError | LimitErrorKind::InsufficientMemory
            ) =>
        {
            "image is too large to read".into()
        }
        image::ImageError::Unsupported(_) => "image format isn't supported".into(),
        _ => "image couldn't be read".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bytes that are not an image at all must be refused, not panic the
    /// decoder — this is the untrusted-input path.
    #[test]
    fn rejects_non_images() {
        assert!(recognize(b"not an image at all, just bytes").is_err());
        assert!(recognize(&[0xff; 64]).is_err());
    }

    /// The real attack: a 380 KB PNG that expands to 400 megapixels. It must
    /// be refused from its header, without ever being decoded.
    #[test]
    fn refuses_a_decompression_bomb_without_decoding_it() {
        let error = recognize(&fixture("bomb.png")).unwrap_err();
        assert!(format!("{error}").contains("too large"), "got: {error}");
    }

    /// The happy path, proving the embedded models actually read text — off an
    /// image with a transparent background, which is the case that silently
    /// returned nothing before compositing was added.
    #[test]
    fn reads_text_out_of_an_image() {
        let text = recognize(&fixture("hello.png")).unwrap();
        assert!(text.contains("Hello Blobbies"), "got: {text:?}");
    }

    /// Panics rather than skipping when a fixture is missing: these files are
    /// committed, so absence is a broken checkout, and a test that quietly
    /// passes without them would hide OCR being broken outright.
    fn fixture(name: &str) -> Vec<u8> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        std::fs::read(&path)
            .unwrap_or_else(|error| panic!("missing fixture {}: {error}", path.display()))
    }
}
