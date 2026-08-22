/**
 * Sim setup: let the harness drive Tinfoil, not just a local Ollama.
 *
 * The sims were written against Ollama and hardcode that assumption, so every
 * prompt and tool description had only ever been tuned against a small local
 * model. Tinfoil is the app's other supported path and the one carrying the
 * frontier models, so it needs the same scrutiny:
 *
 * ```
 * SIM_MODEL=tinfoil:deepseek-v4-flash \
 *   TINFOIL_API_KEY=$(security find-generic-password \
 *     -s com.blobbies.app -a tinfoil-api-key -w) pnpm sim:tools
 * ```
 *
 * The key comes from the environment because the app's own keychain path runs
 * over Tauri IPC, which does not exist under vitest.
 */

import { TextEncoder as NodeTextEncoder } from "node:util";
import { configureTinfoil, registerTinfoilProvider } from "@/lib/tinfoil";
import { isTinfoilModel } from "@/lib/tinfoil-model";

/**
 * Give jsdom Node's TextEncoder.
 *
 * Tinfoil's encrypted-body transport runs through hpke, which type-checks its
 * inputs with `instanceof Uint8Array`. jsdom's TextEncoder returns a
 * Uint8Array from jsdom's realm, so that check fails with `"info" must be
 * Uint8Array` and no request ever leaves. A real webview has a single realm
 * and never hits this, so the shim reproduces the app rather than papering
 * over a bug. Must run before anything imports the transport, which is why it
 * lives in a setup file rather than a test.
 */
class RealmSafeTextEncoder {
  readonly encoding = "utf-8";
  encode(input = ""): Uint8Array {
    // Copy into *this* realm's Uint8Array, whichever that is.
    return Uint8Array.from(new NodeTextEncoder().encode(input));
  }
  encodeInto(input: string, destination: Uint8Array) {
    return new NodeTextEncoder().encodeInto(input, destination);
  }
}
Object.defineProperty(globalThis, "TextEncoder", {
  configurable: true,
  writable: true,
  value: RealmSafeTextEncoder,
});

const model = process.env.SIM_MODEL ?? "";
if (isTinfoilModel(model)) {
  const apiKey = process.env.TINFOIL_API_KEY ?? "";
  if (apiKey === "") {
    throw new Error(
      "SIM_MODEL names a Tinfoil model but TINFOIL_API_KEY is unset. " +
        "Export it from the keychain: TINFOIL_API_KEY=$(security " +
        "find-generic-password -s com.blobbies.app -a tinfoil-api-key -w)",
    );
  }
  registerTinfoilProvider();
  configureTinfoil({ apiKey });
}
