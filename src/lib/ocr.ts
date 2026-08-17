/**
 * On-device OCR, for attached images and PDFs that carry no text layer.
 *
 * The work happens in Rust (`src-tauri/src/ocr.rs`) — the webview alternative
 * needs `'wasm-unsafe-eval'` in `script-src`, which applies to the whole page,
 * and trading the app's main containment boundary for one feature is not a
 * trade worth making. Only extracted text comes back over IPC.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";

/** Image formats the Rust decoder is compiled with. */
const IMAGE_MAGIC: ReadonlyArray<{ readonly bytes: readonly number[]; readonly offset?: number }> =
  [
    { bytes: [0x89, 0x50, 0x4e, 0x47] }, // PNG
    { bytes: [0xff, 0xd8, 0xff] }, // JPEG
    { bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF
    { bytes: [0x42, 0x4d] }, // BMP
    { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 }, // WEBP ("WEBP" after the RIFF header)
  ];

/** How many leading bytes a caller must supply for {@link isImage} to decide. */
export const IMAGE_MAGIC_BYTES = 12;

/**
 * Is this an image we can OCR? Decided from the bytes, never from the file
 * name or the browser's MIME guess.
 */
export function isImage(head: Uint8Array): boolean {
  return IMAGE_MAGIC.some(({ bytes, offset = 0 }) =>
    bytes.every((byte, index) => head[offset + index] === byte),
  );
}

/**
 * Read the text in an image, or throw with a reason fit to show the user.
 *
 * An image with no text in it returns `""` — that is an answer, not an error.
 */
export async function ocrImage(bytes: Uint8Array): Promise<string> {
  if (!isTauri()) {
    // Browser dev has no Rust side; failing loudly beats a silent empty result
    // that looks like "this image has no text".
    throw new Error("OCR needs the desktop app");
  }
  // Passed as a `Uint8Array`, which Tauri sends as a raw request body — a
  // plain object argument would serialize megabytes of image as a JSON array
  // of numbers.
  return invoke<string>("ocr_image", bytes);
}
