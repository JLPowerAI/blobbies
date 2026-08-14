import { OpenAI } from "openai/client";

/**
 * gg-ai constructs its OpenAI client without `dangerouslyAllowBrowser`, so the
 * SDK refuses to run inside a webview (it assumes a secret API key would be
 * exposed). Blobbies only ever talks to localhost Ollama with a placeholder
 * key, so there is nothing to expose. Vite aliases the bare "openai" import to
 * this module, which forces the flag on.
 */
// biome-ignore lint/style/noDefaultExport: gg-ai imports `openai` as a default export
export default class BrowserSafeOpenAI extends OpenAI {
  constructor(options: ConstructorParameters<typeof OpenAI>[0] = {}) {
    super({ ...options, dangerouslyAllowBrowser: true });
  }
}

export { BrowserSafeOpenAI as OpenAI };
