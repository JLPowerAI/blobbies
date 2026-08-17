/**
 * Text out of a PDF, for attachments.
 *
 * pdf.js is a large parser fed bytes the user got from someone else, so this
 * module is the whole of its exposure: text extraction only, in a worker we
 * own, with rendering, fonts, forms, images and the wasm codecs all switched
 * off, and a wall-clock cap that actually terminates the parse.
 *
 * Imported dynamically (see attachments.ts) so the ~500 KB of pdf.js only
 * loads once someone actually attaches a PDF.
 */

import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

/** Pages read per document. A book-length PDF is not a chat attachment. */
const MAX_PAGES = 200;

/**
 * Wall clock for one document — a malformed PDF can keep the parser busy far
 * longer than its size suggests.
 *
 * Enforced as a race, because killing the worker does not on its own make the
 * caller's promise settle: every pdf.js call is a round trip to that worker,
 * so a terminated one leaves `task.promise` (and `task.destroy()`) pending
 * forever. The race is what fails the attachment; the terminate is what stops
 * the CPU burning.
 */
const TIMEOUT_MS = 20_000;

/**
 * Extract a PDF's text, or throw if it is unreadable.
 *
 * Callers treat a throw as "this file is not attachable" and say so; nothing
 * here is trusted enough to be worth a partial result on a parser error.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  // A fresh worker per document, terminated below. We construct it ourselves
  // so pdf.js never calls `new Worker` and so never reaches its blob:-URL
  // wrapper, which our CSP refuses (see pdf-worker.ts). The browser caches the
  // script, so the second PDF starts a worker that is already warm.
  const worker = new Worker(new URL("./pdf-worker.ts", import.meta.url), { type: "module" });
  // `workerPort` is global but `getDocument` reads it synchronously, so two
  // concurrent extractions still each get their own worker. Never put an
  // `await` between these two statements.
  GlobalWorkerOptions.workerPort = worker;
  const task = getDocument({
    // A copy, because pdf.js *transfers* this buffer to the worker: the
    // caller's array would come back detached (`byteLength === 0`) and its
    // next use throws "An ArrayBuffer is detached and could not be cloned".
    // Verified in a real browser — a scanned PDF read here and then passed to
    // pdf-ocr is exactly that sequence.
    data: new Uint8Array(bytes),
    // Hardening. Names checked against pdfjs-dist 6.2.108's own type
    // definitions — `isEvalSupported` no longer exists in v6, so passing it
    // would be a no-op that merely looks safe.
    disableFontFace: true, // no @font-face on the main thread (CVE-2024-4367's path)
    useSystemFonts: false,
    enableXfa: false, // no XFA form engine
    useWasm: false, // no jbig2/openjpeg/qcms wasm decoders
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: 1, // images are never needed for text
    stopAtErrors: false, // salvage what text a damaged file still has
    verbosity: 0,
  });
  const read = async (): Promise<string> => {
    const pdf = await task.promise;
    const pages: string[] = [];
    for (let page = 1; page <= Math.min(pdf.numPages, MAX_PAGES); page++) {
      const loaded = await pdf.getPage(page);
      const { items } = await loaded.getTextContent();
      pages.push(
        items
          // Marked-content entries carry structure, not text, and have no
          // `str` — the `in` check is what narrows the union.
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
          .join(""),
      );
      loaded.cleanup();
    }
    if (pdf.numPages > MAX_PAGES) {
      pages.push(`[only the first ${MAX_PAGES} of ${pdf.numPages} pages were read]`);
    }
    return pages.join("\n");
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("PDF took too long to read"));
        }, TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // Not awaited: destroy() is itself a round trip, so it would hang against
    // a worker the timeout already killed. terminate() is the real cleanup and
    // is safe to call twice; destroy() just lets pdf.js tidy its bookkeeping.
    void task.destroy().catch(() => {});
    worker.terminate();
  }
}
