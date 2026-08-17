import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

/**
 * pdf.js's pure-JS image decoders, served so `wasmUrl` can reach them.
 *
 * We render PDF pages with `useWasm: false` (wasm would need
 * `'wasm-unsafe-eval'` in the CSP, see src/lib/pdf-ocr.ts). pdf.js then falls
 * back to these JS builds — but only if it can `import()` them from `wasmUrl`.
 * With no URL set it silently ends up with no decoder at all, and a scan made
 * of JBIG2 or JPEG2000 images renders as a blank white page that OCRs as
 * "no text found".
 *
 * They land in `public/pdfjs/` (gitignored) rather than being committed, so
 * they cannot drift from the installed pdfjs-dist.
 */
function pdfjsFallbackDecoders(): Plugin {
  const files = ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js"];
  return {
    name: "pdfjs-fallback-decoders",
    buildStart() {
      const target = fileURLToPath(new URL("./public/pdfjs", import.meta.url));
      mkdirSync(target, { recursive: true });
      for (const file of files) {
        const from = fileURLToPath(
          new URL(`./node_modules/pdfjs-dist/wasm/${file}`, import.meta.url),
        );
        const to = `${target}/${file}`;
        // Skipped when unchanged: public/ is watched, and rewriting these on
        // every start would trigger a full page reload each time.
        if (existsSync(to) && statSync(to).size === statSync(from).size) {
          continue;
        }
        copyFileSync(from, to);
      }
    },
  };
}

// Must stay in sync with `build.devUrl` in src-tauri/tauri.conf.json.
const DEV_PORT = 1421;
const HMR_PORT = DEV_PORT + 1;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pdfjsFallbackDecoders()],

  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // gg-ai's OpenAI client refuses to construct in a webview; the shim
      // forces `dangerouslyAllowBrowser` (safe: localhost Ollama, no real key).
      {
        find: /^openai$/,
        replacement: fileURLToPath(new URL("./src/lib/openai-browser.ts", import.meta.url)),
      },
    ],
  },

  // Keep gg-ai in the plugin pipeline so the "openai" alias above applies to
  // its imports during dev pre-bundling as well.
  optimizeDeps: {
    exclude: ["@kenkaiiii/gg-ai", "@kenkaiiii/gg-agent"],
  },

  // gg-ai's dist reads `process.env.*` at module scope, which throws in a
  // browser/webview (no `process`). Rewrite the expression to an empty object.
  define: {
    "process.env": "{}",
  },

  // Tauri ships its own webview: target it directly instead of legacy browsers.
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },

  // 1. Prevent Vite from obscuring Rust errors.
  clearScreen: false,
  server: {
    // 2. Tauri expects a fixed port and fails if it is taken.
    port: DEV_PORT,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: HMR_PORT } : undefined,
    watch: {
      // 3. Vite must not watch the Rust side.
      ignored: ["**/src-tauri/**"],
    },
  },
});
