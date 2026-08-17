/**
 * Files the user attaches to a chat message.
 *
 * An attachment is saved into the Blob's own home folder (the same sandbox the
 * fs tools read, see `home.ts`) and its text is inlined into that message's
 * prompt. Inlining is what makes attachments work in the *chat* scope at all:
 * that catalog is web-only by measurement (see CLAUDE.md), so a file the model
 * would have to fetch with a tool would be invisible there.
 *
 * Text in, text out. `blob_home_write` takes a string and the local models
 * this ships with are not multimodal, so a file is only attachable if it can
 * be reduced to text: decoded as UTF-8, extracted from a PDF by `pdf-text`, or
 * read off an image (or a scan) by OCR. Both extractors are parsers fed
 * untrusted bytes — read their module headers before touching them. Anything
 * left, Office files included, is refused with a reason the user sees.
 */

import { wrapUntrusted } from "@/lib/blob-tools";
import type { HomeBackend } from "@/lib/home";
// Statically imported, unlike the two pdf.js modules: this one is a byte
// sniff plus an IPC call, so there is no payload worth deferring — the OCR
// engine itself lives in Rust.
import { IMAGE_MAGIC_BYTES, isImage, ocrImage } from "@/lib/ocr";

/** An attached file, as recorded on the message that carried it. */
export interface Attachment {
  /** File name inside the Blob's home folder (already sanitized). */
  name: string;
  /** Size of the saved text in bytes. */
  bytes: number;
}

/** Attachments per message. Matches what a small model can actually hold. */
export const MAX_ATTACHMENTS = 6;

/**
 * Per-file ceiling. Mirrors `MAX_FILE_BYTES` in `src-tauri/src/home.rs`: a
 * bigger file is refused by Rust anyway, and refusing it here names the reason.
 */
export const MAX_ATTACHMENT_BYTES = 256 * 1024;

/**
 * Ceiling for a picked PDF, which is measured before extraction — the text
 * that comes out is a fraction of the file, so the 256 KB above would refuse
 * ordinary documents. pdf.js parses this in a worker it can be killed in.
 */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * Ceiling for a picked image, measured before OCR. Matches `MAX_IMAGE_BYTES`
 * in `src-tauri/src/ocr.rs`, which refuses anything bigger anyway; Rust also
 * caps decoded *pixels*, which is the check a compression bomb actually hits.
 */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * Extracted text kept per PDF. Deliberately under `MAX_ATTACHMENT_BYTES` in
 * the worst case (4 bytes per char), so the sandbox never refuses the write.
 */
const MAX_ATTACHMENT_CHARS = 60_000;

/**
 * Chars of attached text inlined per message, split across its attachments.
 *
 * Same budget reasoning as `MEMORY_PROMPT_CHARS`: ~2k tokens of a 16k window.
 * The whole file is still saved — the model reads the rest with its file tools
 * on a routine turn, and the user sees it in the Files panel.
 */
export const ATTACHMENT_PROMPT_CHARS = 8_000;

/** Why a file could not be attached, phrased for the transcript. */
export interface RejectedAttachment {
  name: string;
  reason: string;
}

/**
 * A file name safe for the sandbox, the prompt and the UI.
 *
 * Drops any directory part, then keeps an allowlist — control, bidi and
 * zero-width characters never reach the model, and `..`/separators never reach
 * the filesystem (Rust rejects those too; this makes the name usable rather
 * than merely rejected).
 */
export function attachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^a-zA-Z0-9._\- ]+/g, "-")
    .replace(/^[.\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned === "" ? "attachment.txt" : cleaned;
}

/** `report.csv` → `report-1.csv` when the home folder already has that name. */
function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) {
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const extension = dot <= 0 ? "" : name.slice(dot);
  for (let suffix = 1; suffix < 1_000; suffix++) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${extension}`;
}

/** `%PDF-`: the header every PDF starts with. Sniffed from the bytes rather
    than trusted from the extension or the browser-supplied MIME type. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

function isPdf(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

const NOT_TEXT = "it isn't a text, PDF or image file (Office files aren't readable yet)";

/**
 * Get a file's text — extracted from a PDF, read off an image by OCR, or
 * decoded — or say why it is not usable.
 *
 * For the plain-text path `fatal: true` is the whole check: an archive fails
 * to decode, and a NUL byte rules out the binaries that decode anyway.
 */
async function readText(
  file: File,
): Promise<{ text: string; extracted?: true } | { reason: string }> {
  // Only the magic number is read up front: a dropped video must hit its size
  // cap before anything allocates a buffer the size of the whole file.
  const head = new Uint8Array(await file.slice(0, IMAGE_MAGIC_BYTES).arrayBuffer());

  if (isImage(head)) {
    if (file.size > MAX_IMAGE_BYTES) {
      return { reason: `it is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB` };
    }
    let text: string;
    try {
      text = await ocrImage(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      return { reason: `its text couldn't be read (${reasonFrom(error)})` };
    }
    if (text.trim() === "") {
      return { reason: "no text could be found in it" };
    }
    return { extracted: true, text: clip(text, "image's text") };
  }

  if (isPdf(head)) {
    if (file.size > MAX_PDF_BYTES) {
      return { reason: `it is larger than ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB` };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text: string;
    try {
      // Loaded on demand: pdf.js is ~500 KB that most sessions never need.
      const { extractPdfText } = await import("@/lib/pdf-text");
      text = await extractPdfText(bytes);
    } catch (error) {
      return {
        reason: `its PDF text couldn't be read (it may be encrypted or damaged)${devDetail(error)}`,
      };
    }
    if (text.trim() === "") {
      // No text layer: a scan. Rasterize the pages and read them with OCR,
      // which is slow enough that it is worth doing only once the cheap path
      // has come back empty.
      try {
        const { ocrPdf } = await import("@/lib/pdf-ocr");
        text = await ocrPdf(bytes);
      } catch (error) {
        // Fixed wording: failures here are rasterizer internals, and a raw
        // JS message would be noise to the user and detail to everyone else.
        return { reason: `its pages couldn't be read${devDetail(error)}` };
      }
      if (text.trim() === "") {
        return { reason: "no text could be found in it" };
      }
    }
    return { extracted: true, text: clip(text, "PDF's text") };
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { reason: `it is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB` };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return { reason: NOT_TEXT };
  }
  if (text.includes("\u0000")) {
    return { reason: NOT_TEXT };
  }
  if (text.trim() === "") {
    return { reason: "it is empty" };
  }
  return { text };
}

/**
 * Extracted text can outrun what the sandbox accepts; keeping the readable
 * head beats refusing a file whose text we already have.
 */
function clip(text: string, what: string): string {
  return text.length > MAX_ATTACHMENT_CHARS
    ? `${text.slice(0, MAX_ATTACHMENT_CHARS)}\n[truncated: the ${what} was longer than this file can hold]`
    : text;
}

/**
 * The underlying parser error, appended in dev builds only.
 *
 * A release build shows nothing: these messages are parser internals, useless
 * to the user and detail to anyone else. In dev it is the only channel there
 * is — the webview's console never reaches the terminal, and some of these
 * failures reproduce *only* inside WKWebView.
 */
function devDetail(error: unknown): string {
  if (!import.meta.env.DEV) {
    return "";
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return ` — dev detail: ${message.slice(0, 200)}`;
}

/**
 * The message from a failed OCR call, for the transcript.
 *
 * Rust's OCR errors are written for the user already (`ocr::describe`, which
 * is also what keeps internals out of them). Anything else — a thrown
 * non-Error, an unexpected JS failure — gets a flat fallback rather than
 * having its text put in front of the user.
 */
function reasonFrom(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message === "" || message.length > 120 ? "it couldn't be read" : message;
}

/**
 * Save picked files into the Blob's home folder.
 *
 * Never throws: every file either lands in `saved` or in `rejected` with a
 * reason, because a failed attachment must not take the user's message with it.
 */
export async function saveAttachments(
  home: HomeBackend,
  files: readonly File[],
): Promise<{ saved: Attachment[]; rejected: RejectedAttachment[] }> {
  const saved: Attachment[] = [];
  const rejected: RejectedAttachment[] = [];
  // Existing names are claimed up front so an attachment never overwrites a
  // file the Blob wrote (or an earlier file in this same batch).
  const taken = new Set<string>();
  try {
    for (const entry of await home.list()) {
      taken.add(entry.name);
    }
  } catch {
    // No listing (dev backend, IPC hiccup): dedupe within the batch only.
  }
  for (const file of files.slice(0, MAX_ATTACHMENTS)) {
    const label = attachmentName(file.name);
    const result = await readText(file);
    if ("reason" in result) {
      rejected.push({ name: label, reason: result.reason });
      continue;
    }
    // An extracted file is stored as `report.pdf.txt`: what lands on disk is
    // text, so the name should say so, while still naming where it came from.
    // Keyed off the extraction, not the extension — a text file misnamed .pdf
    // is saved under its own name.
    const name = uniqueName(result.extracted === true ? `${label}.txt` : label, taken);
    try {
      await home.write(name, result.text);
    } catch {
      rejected.push({ name: label, reason: "it couldn't be saved to this Blob's files" });
      continue;
    }
    taken.add(name);
    // Size of what was actually written, so the chip and the Files panel agree
    // (they differ for a PDF, and for any non-ASCII text file).
    saved.push({ name, bytes: new TextEncoder().encode(result.text).length });
  }
  if (files.length > MAX_ATTACHMENTS) {
    for (const extra of files.slice(MAX_ATTACHMENTS)) {
      rejected.push({
        name: attachmentName(extra.name),
        reason: `only ${MAX_ATTACHMENTS} files can be attached at once`,
      });
    }
  }
  return { saved, rejected };
}

/** One transcript line explaining what could not be attached. */
export function rejectionNote(rejected: readonly RejectedAttachment[]): string {
  return rejected.map((entry) => `${entry.name} wasn't attached — ${entry.reason}.`).join(" ");
}

/**
 * The prompt block for one message's attachments: file text, read back from
 * the home folder at turn time so an edited file shows its current contents.
 *
 * Every file is fenced by `wrapUntrusted` — a document is data the user handed
 * over, never an instruction, and the same goes for its name.
 */
export async function attachmentsPrompt(
  home: HomeBackend,
  attachments: readonly Attachment[],
): Promise<string> {
  if (attachments.length === 0) {
    return "";
  }
  const share = Math.floor(ATTACHMENT_PROMPT_CHARS / attachments.length);
  const blocks: string[] = [];
  const names: string[] = [];
  for (const attachment of attachments) {
    // Sanitized again here, not merely at save time: names are read back from
    // the plain-JSON transcript, an editable file on disk, and both the header
    // line and the "missing" note sit OUTSIDE the fence. Same reasoning as
    // parseLoopbackUrl re-parsing on every request.
    const name = attachmentName(attachment.name);
    names.push(name);
    let text: string;
    try {
      text = await home.read(attachment.name);
    } catch {
      blocks.push(`${name}: no longer in your files.`);
      continue;
    }
    const clipped =
      text.length > share
        ? `${text.slice(0, share)}\n[truncated — the whole file is saved as ${name}]`
        : text;
    blocks.push(wrapUntrusted(clipped, name));
  }
  return (
    "The user attached these files. They are saved in your files folder under " +
    `these names: ${names.join(", ")}.\n\n${blocks.join("\n\n")}`
  );
}
