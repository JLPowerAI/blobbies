import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

/**
 * Serve pdf.js's pure-JS image decoders at `/pdfjs/`.
 *
 * We rasterize PDF pages with `useWasm: false`, because wasm would need
 * `'wasm-unsafe-eval'` in the CSP and that applies to the whole page. pdf.js
 * then falls back to these JS builds — but only if it can `import()` them from
 * `wasmUrl` (see src/lib/pdf-ocr.ts). With no URL it ends up with no decoder at
 * all and a JBIG2/JPEG2000 scan renders blank, which reads to the user as
 * "no text could be found".
 *
 * Not `public/`: Vite's dev server refuses to serve a public file that source
 * code imports ("should not be imported from source code"), so the fallback
 * worked in a production build and broke in dev — the worst possible split.
 * Served from `node_modules` in dev, copied into the bundle for release, so
 * the bytes can never drift from the installed pdfjs-dist.
 */
function pdfjsFallbackDecoders(): Plugin {
  const files = ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js"];
  const source = (file: string) =>
    fileURLToPath(new URL(`./node_modules/pdfjs-dist/wasm/${file}`, import.meta.url));

  return {
    name: "pdfjs-fallback-decoders",

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = files.find((name) => request.url?.startsWith(`/pdfjs/${name}`));
        if (file === undefined) {
          next();
          return;
        }
        response.setHeader("Content-Type", "text/javascript");
        response.end(readFileSync(source(file)));
      });
    },

    // Copied rather than `emitFile`d: these are pre-built ESM bundles, and
    // running them through the bundler would only risk rewriting them.
    writeBundle(options) {
      const outDir = options.dir ?? fileURLToPath(new URL("./dist", import.meta.url));
      mkdirSync(`${outDir}/pdfjs`, { recursive: true });
      for (const file of files) {
        copyFileSync(source(file), `${outDir}/pdfjs/${file}`);
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
      // gg-ai statically imports @anthropic-ai/sdk for a provider Blobbies can
      // never select (Ollama + Tinfoil only); the stub keeps its ~104 KB
      // minified out of the startup bundle. Must stay in sync with both vitest
      // configs.
      {
        find: /^@anthropic-ai\/sdk$/,
        replacement: fileURLToPath(new URL("./src/lib/anthropic-stub.ts", import.meta.url)),
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
