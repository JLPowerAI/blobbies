/**
 * Stub for `@anthropic-ai/sdk`, aliased in vite.config.ts and both vitest
 * configs.
 *
 * Blobbies has exactly two model paths by product decision — local Ollama and
 * Tinfoil — and nothing in `src/` imports Anthropic. But `@kenkaiiii/gg-ai`
 * statically imports the SDK at module scope for *its* Anthropic provider,
 * which drags ~104 KB minified (26 KB gzip) into the startup bundle — measured:
 * main chunk 1,138 → 1,034 kB when stubbed — parsed on every launch for a
 * provider this app can never select.
 *
 * The alias swaps it for this file. gg-ai only touches `Anthropic` inside its
 * provider factory (`new Anthropic(...)`) and in an `instanceof
 * Anthropic.APIError` check, so a throwing constructor plus an APIError class
 * nothing ever instantiates keeps both paths well-defined. Selecting an
 * anthropic model would fail loudly here instead of shipping the SDK to every
 * user who never will.
 */

// biome-ignore lint/style/noDefaultExport: gg-ai imports the SDK default export
export default class UnavailableAnthropic {
  constructor() {
    throw new Error(
      "The Anthropic SDK is stubbed out of Blobbies: only Ollama and Tinfoil are model paths.",
    );
  }

  /** Satisfies gg-ai's `instanceof Anthropic.APIError` classifier; never thrown. */
  static readonly APIError = class APIError extends Error {};
}
