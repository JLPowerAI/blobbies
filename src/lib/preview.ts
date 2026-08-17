/**
 * Thumbnails for attached images.
 *
 * An attachment is stored as the text we could pull out of it, so an image
 * would otherwise have nothing to show in the transcript but a filename. This
 * makes a small JPEG copy for display only — never used for OCR, which always
 * reads the original bytes.
 *
 * Kept as a data URL on the message itself, so it survives a restart with no
 * second read path and no flicker (`img-src` already allows `data:`).
 *
 * simplification: that puts the bytes in the transcript slice, which Rust caps
 * at 8 MB. Hence the deliberately small budget below — ~30 KB a picture, so a
 * conversation holds a couple of hundred before that matters. If it ever does,
 * the upgrade is a `previews/` folder in the Blob's home plus a lazy read.
 */

/** Longest edge of a stored preview. Bubble width is ~260px; this is retina. */
const MAX_EDGE = 560;

/** Quality/size trade for the stored copy. 0.7 keeps screenshot text legible. */
const QUALITY = 0.7;

/**
 * Hard ceiling for one preview's data URL. A busy photo can outrun the budget
 * even at this size; losing the thumbnail beats bloating every future turn.
 */
const MAX_PREVIEW_CHARS = 60_000;

/**
 * Decoded-pixel cap, mirroring `MAX_PIXELS` in `src-tauri/src/ocr.rs`.
 *
 * A few hundred KB of PNG can legally claim hundreds of megapixels. Rust checks
 * this before decoding; here the decode happens first, so the check bounds the
 * *canvas* — a 50 MP bitmap is ~200 MB of RGBA, and scaling one down would be
 * the webview's problem rather than the OCR engine's.
 */
const MAX_PIXELS = 50_000_000;

/**
 * A small JPEG copy of an image, as a data URL, or `undefined` if this
 * environment cannot render one (jsdom, or an image the decoder refuses).
 *
 * Never throws: a missing thumbnail costs a nicer bubble, not the attachment.
 */
export async function imagePreview(source: Uint8Array | Blob): Promise<string | undefined> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return undefined;
  }
  let bitmap: ImageBitmap | undefined;
  try {
    // A copy of raw bytes, because Blob takes ownership of the view's buffer in
    // some engines and the caller still needs those bytes for OCR. A File is
    // already a Blob and is passed straight through.
    bitmap = await createImageBitmap(
      source instanceof Blob ? source : new Blob([new Uint8Array(source)]),
    );
    if (bitmap.width * bitmap.height > MAX_PIXELS) {
      return undefined;
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (context === null) {
      return undefined;
    }
    // White underneath: a transparent PNG flattened onto JPEG's default black
    // turns dark-on-transparent screenshots into an unreadable smudge.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", QUALITY);
    return url.length > MAX_PREVIEW_CHARS ? undefined : url;
  } catch {
    return undefined;
  } finally {
    bitmap?.close();
  }
}
