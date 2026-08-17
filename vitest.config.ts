import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // Mirror vite.config.ts: jsdom trips the OpenAI SDK's browser guard too.
      {
        find: /^openai$/,
        replacement: fileURLToPath(new URL("./src/lib/openai-browser.ts", import.meta.url)),
      },
      // Mirror vite.config.ts: keeps the Anthropic SDK out of the module graph.
      {
        find: /^@anthropic-ai\/sdk$/,
        replacement: fileURLToPath(new URL("./src/lib/anthropic-stub.ts", import.meta.url)),
      },
    ],
  },
  test: {
    // gg-ai must go through the Vite pipeline (not Node's resolver) so the
    // "openai" alias above rewrites its import, matching app builds.
    server: {
      deps: {
        inline: ["@kenkaiiii/gg-ai", "@kenkaiiii/gg-agent"],
      },
    },
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.{test,spec}.{ts,tsx}",
        "src/test/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
    },
  },
});
