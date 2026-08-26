import { isTinfoilModel, tinfoilModelId } from "@/lib/tinfoil-model";

/**
 * Context window requested for every Blob turn, in tokens.
 *
 * Ollama's stock server default is 4096, which a normal conversation fills in
 * a few exchanges — the model then silently truncates the transcript and the
 * reply dies mid-sentence. The native /api/chat endpoint accepts a per-request
 * `num_ctx`, so the app asks for a real window instead of requiring every
 * user to reconfigure their Ollama install.
 *
 * simplification: fixed budget, not adaptive to model or free RAM. 16k of KV
 * cache is tens of MB for the small models this app targets; an adaptive pick
 * would need /api/ps probing and an eviction story.
 *
 * Lives here (a leaf module) rather than in ollama-native.ts so the eager UI
 * can read it without dragging the gg-ai provider stack into the startup
 * bundle; ollama-native re-exports it.
 */
export const OLLAMA_NUM_CTX = 16384;

/**
 * How many tokens the selected model will actually accept.
 *
 * Not one number for the app: the same conversation is tiny against
 * deepseek-v4-flash's 1M window and over budget against a local 16k one.
 * Sizing history to a single constant meant Tinfoil users lost history at
 * under 1% of their window while local users still risked overflow.
 */

/**
 * Fallback for a Tinfoil model whose window we could not fetch.
 *
 * The floor across their tool-capable chat models, so it can only ever be too
 * cautious. Guessing high would overflow the enclave, and an enclave overflow
 * is the one error we cannot recover from: gg-agent triggers `force` by
 * regexing the provider's error text, and Tinfoil's wording is unverified.
 */
const TINFOIL_FALLBACK_WINDOW = 131_072;

/**
 * Windows fetched from Tinfoil's public catalog, keyed by bare model id.
 *
 * Module-level rather than React state because `streamBlobTurn` is called from
 * scheduled routines too, which never touch the UI. Populated by
 * `rememberTinfoilWindows` when Settings lists the models; empty until then,
 * which the fallback covers.
 */
const tinfoilWindows = new Map<string, number>();

/** Record `context_window` values from Tinfoil's catalog for later lookups. */
export function rememberTinfoilWindows(
  models: { id: string; contextWindow?: number | undefined }[],
): void {
  for (const model of models) {
    // A model that reports no usable window keeps the conservative fallback:
    // a zero would make every conversation look over budget, and a NaN (which
    // `typeof` calls a number) would make every comparison false and disable
    // trimming entirely. `listTinfoilModels` filters these too — this is a
    // separate exported entry point, so it does not rely on that.
    if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
      tinfoilWindows.set(model.id, model.contextWindow);
    }
  }
}

/**
 * The window for a Settings model choice, in tokens.
 *
 * Local models report a far larger trained window than they serve — Ollama
 * advertises qwen3.5:9b as 262144 — because we pass `num_ctx` ourselves. What
 * we asked for is what the server allocates, so that is the honest number.
 */
export function contextWindow(model: string): number {
  if (!isTinfoilModel(model)) {
    return OLLAMA_NUM_CTX;
  }
  return tinfoilWindows.get(tinfoilModelId(model)) ?? TINFOIL_FALLBACK_WINDOW;
}

/**
 * How many characters of one tool's output may enter the prompt.
 *
 * Same 3%-of-window budget `fetchTextLimit` gives a fetched page, and for the
 * same reason: a result is only useful if the model can hold it. A flat cap
 * is wrong in both directions — 3,000 characters is most of a 16k local
 * window and 0.3% of deepseek's.
 */
export function toolTextLimit(model?: string): number {
  return windowTextLimit(model === undefined ? OLLAMA_NUM_CTX : contextWindow(model));
}

/**
 * The 3%-of-window share, in characters, that any one blob of external text
 * may take: a fetched page, an MCP result, an app result.
 *
 * One function because it is one budget — `fetchTextLimit` had this body
 * first and now delegates, so a page and a tool result cannot drift apart.
 * 5.3 characters per token is this app's ratio for prose, where the usual
 * conservative 4 assumes code.
 */
export function windowTextLimit(window: number): number {
  return Math.min(Math.max(Math.round(window * 0.03 * 5.3), 3_000), 60_000);
}

/**
 * Cut oversized tool output, and say so in words the model can act on.
 *
 * A silent cut is the expensive failure: JSON stops mid-object, the model
 * reads what it got as the whole answer, and reports a partial list as
 * complete. Naming the real size and the remedy — narrow the call — is what
 * turns "the search worked but I only saw six of forty repos" into a retry
 * that fits.
 */
export function capToolText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return (
    `${text.slice(0, limit)}\n[cut off: the tool returned ${text.length} characters and you ` +
    `can read only the first ${limit}. The rest is gone — it is not in a file and not ` +
    "retrievable. Run the call again asking for fewer items or fewer fields, and tell the " +
    "user which part you could not see rather than treating this as the whole answer.]"
  );
}
