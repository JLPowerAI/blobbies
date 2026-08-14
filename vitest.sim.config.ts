import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Agent simulation runner: real `streamBlobTurn` against a real local model.
 *
 * Kept out of `vitest.config.ts` on purpose — these need Ollama running, take
 * minutes, and a small model is non-deterministic, so they must never gate a
 * commit. Run with `pnpm sim`.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // Same shim as the app: the OpenAI SDK refuses to construct in a
      // DOM-like environment without it.
      {
        find: /^openai$/,
        replacement: fileURLToPath(new URL("./src/lib/openai-browser.ts", import.meta.url)),
      },
    ],
  },

  // gg-ai reads process.env at module scope; jsdom has no `process`.
  define: {
    "process.env": "{}",
  },

  test: {
    // Both gg packages must go through the Vite pipeline for the alias above.
    server: { deps: { inline: ["@kenkaiiii/gg-ai", "@kenkaiiii/gg-agent"] } },
    // DOMParser: the web tools parse HTML.
    environment: "jsdom",
    include: ["sim/**/*.sim.ts"],
    // One model, one conversation at a time: parallel runs fight over the
    // model's KV-cache slots and distort the timings the report prints.
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 120_000,
  },
});
