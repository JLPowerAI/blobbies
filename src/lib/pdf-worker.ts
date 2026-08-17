/**
 * The pdf.js worker, as a module Vite emits into our own bundle.
 *
 * Existing so `pdf-text.ts` can hand pdf.js a `Worker` it built itself. Left to
 * its own devices pdf.js wraps `workerSrc` in a `blob:` URL whenever it thinks
 * the page origin differs (Tauri serves from a custom scheme), which our CSP
 * refuses — and it then silently falls back to parsing the PDF on the main
 * thread, where it cannot be terminated.
 */

import "pdfjs-dist/build/pdf.worker.min.mjs";
