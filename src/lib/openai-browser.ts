import { OpenAI } from "openai/client";

export { APIPromise } from "openai/api-promise";
/**
 * gg-ai constructs its OpenAI client without `dangerouslyAllowBrowser`, so the
 * SDK refuses to run inside a webview (it assumes a secret API key would be
 * exposed). Blobbies only ever talks to localhost Ollama with a placeholder
 * key, so there is nothing to expose. Vite aliases the bare "openai" import to
 * this module, which forces the flag on.
 *
 * The star re-export below keeps openai's public named surface (APIError,
 * APIPromise, …) available: the `tinfoil` package re-exports those names from
 * bare "openai", which the vite alias points here. Explicit local exports
 * shadow the star, so the forced-flag class stays the OpenAI/default export.
 */
export * from "openai/error";
export { PagePromise } from "openai/pagination";
export { toFile } from "openai/uploads";
// biome-ignore lint/style/noDefaultExport: gg-ai imports `openai` as a default export
export default class BrowserSafeOpenAI extends OpenAI {
  constructor(options: ConstructorParameters<typeof OpenAI>[0] = {}) {
    super({ ...options, dangerouslyAllowBrowser: true });
  }
}

export { BrowserSafeOpenAI as OpenAI };
