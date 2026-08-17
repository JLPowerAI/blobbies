/**
 * OCR for PDFs that carry no text layer — i.e. scans.
 *
 * Deliberately separate from `pdf-text.ts`. That module turns rendering,
 * fonts, images and the wasm codecs *off*, because reading a text layer needs
 * none of them and each is attack surface. Rasterizing needs the opposite, so
 * the two configurations do not belong in one function with a flag.
 *
 * Still no `eval`, no network and no main-thread parsing: pages are drawn to a
 * canvas here, and the pixels go to the Rust OCR engine.
 */

import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import { ocrImage } from "@/lib/ocr";

/**
 * Pages OCR'd per document. Far below `pdf-text`'s 200: each page costs
 * seconds of CPU, and a scan long enough to matter is not a chat attachment.
 */
const MAX_PAGES = 20;

/**
 * Render scale. Text recognition wants roughly 150+ dpi; PDF user units are
 * 72 dpi, so 2× lands there without producing pixels nothing can use.
 */
const SCALE = 2;

/** Ceiling per rendered page, matching the Rust decoder's pixel budget. */
const MAX_PAGE_PIXELS = 50_000_000;

/** Wall clock for the whole document, rasterizing and OCR together. */
const TIMEOUT_MS = 120_000;

/**
 * Render one page and read it. Throws if that page cannot be rendered, so the
 * caller can tell "this page failed" from "this page holds no text".
 */
async function readPage(pdf: PDFDocumentProxy, index: number): Promise<string> {
  const page = await pdf.getPage(index);
  try {
    const viewport = page.getViewport({ scale: SCALE });
    if (viewport.width * viewport.height > MAX_PAGE_PIXELS) {
      throw new Error("page is too large to read");
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("this device can't render PDF pages");
    }
    // A scan's own background may be transparent; OCR reads dark on light.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    // Release the backing store now; a 20-page scan would otherwise hold every
    // page's pixels at once.
    canvas.width = 0;
    canvas.height = 0;
    if (blob === null) {
      throw new Error("page couldn't be rendered");
    }
    return await ocrImage(new Uint8Array(await blob.arrayBuffer()));
  } finally {
    page.cleanup();
  }
}

/**
 * Read a scanned PDF by rendering its pages and OCR'ing each one.
 *
 * Returns `""` when the pages genuinely hold no readable text; the caller
 * turns that into a reason the user sees.
 */
export async function ocrPdf(bytes: Uint8Array): Promise<string> {
  // Own worker, so pdf.js never builds one from a `blob:` URL that CSP
  // refuses — the reasoning in pdf-text.ts applies unchanged.
  const worker = new Worker(new URL("./pdf-worker.ts", import.meta.url), { type: "module" });
  GlobalWorkerOptions.workerPort = worker;
  const task = getDocument({
    data: bytes,
    // Rendering is on here, unlike pdf-text: without it there are no pixels to
    // read. Fonts stay off the main thread and forms stay off entirely.
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    // No wasm: it would need `'wasm-unsafe-eval'` in the CSP, which applies to
    // the whole page. `wasmUrl` is what makes that safe rather than broken —
    // pdf.js falls back to pure-JS decoders loaded from there, and without it
    // a scan made of JBIG2 or JPEG2000 images renders blank and OCRs as
    // nothing. Files are put in place by `pdfjsFallbackDecoders` (vite.config).
    useWasm: false,
    wasmUrl: "/pdfjs/",
    verbosity: 0,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("the PDF took too long to read"));
    }, TIMEOUT_MS);
  });

  const read = async (): Promise<string> => {
    const pdf = await task.promise;
    const pages: string[] = [];
    // One bad page must not cost the other nineteen, so failures are collected
    // rather than thrown — but if *every* page failed, the first error is
    // rethrown below, because "OCR is broken" and "this scan has no text" are
    // different answers and the user needs the right one.
    let firstFailure: unknown;
    const total = Math.min(pdf.numPages, MAX_PAGES);
    for (let index = 1; index <= total; index++) {
      try {
        const text = await readPage(pdf, index);
        if (text.trim() !== "") {
          pages.push(text);
        }
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (pages.length === 0 && firstFailure !== undefined) {
      throw firstFailure;
    }
    if (pdf.numPages > MAX_PAGES && pages.length > 0) {
      pages.push(`[only the first ${MAX_PAGES} of ${pdf.numPages} pages were read]`);
    }
    return pages.join("\n\n");
  };

  try {
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
    // Not awaited: destroy() is a round trip, so it hangs against a worker the
    // timeout already killed (see pdf-text.ts).
    void task.destroy().catch(() => {});
    worker.terminate();
  }
}
