import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// Must stay in sync with `build.devUrl` in src-tauri/tauri.conf.json.
const DEV_PORT = 1421;
const HMR_PORT = DEV_PORT + 1;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
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
