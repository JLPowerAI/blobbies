/**
 * Whether the selected model can actually look at a picture.
 *
 * This app turns every attached image into text: `attachments.ts` OCRs it at
 * attach time and tells the model, in as many words, that "the models in this
 * app cannot see images". That was true once. It is now false for the default
 * local model (qwen3.5:9b reports `vision`) and for several Tinfoil models, so
 * a user who attaches a chart gets a garbled OCR dump and a model that has
 * been told not to look — while the bytes to answer properly sat right there.
 *
 * Both providers already publish the answer, so nothing here guesses from the
 * model's name:
 *  - Ollama: `POST /api/show` → `capabilities` contains `"vision"`.
 *  - Tinfoil: `GET /v1/models` → each entry's `multimodal` flag.
 *
 * A leaf module, like `context-window.ts` and for the same reason: the turn
 * path and the eager UI both need it, and neither should drag the provider
 * stack into the startup bundle to ask a yes/no question.
 */
import { isTinfoilModel, tinfoilModelId } from "@/lib/tinfoil-model";

/** Same probe budget as the other Ollama pokes in `ollama.ts`. */
const PROBE_TIMEOUT_MS = 2_000;

const OLLAMA_URL = "http://127.0.0.1:11434";

/**
 * Answers already fetched, keyed by the Settings model string.
 *
 * Module-level rather than React state because scheduled routines build turns
 * with no UI mounted. A model's capabilities do not change under a running
 * app, so one probe per model per session is enough.
 */
const known = new Map<string, boolean>();

/**
 * Tinfoil's `multimodal` flags, recorded when Settings lists the catalog —
 * mirroring `rememberTinfoilWindows`, which reads the same payload.
 *
 * Absent until the catalog loads, which `modelSeesImages` treats as "no": a
 * false negative costs OCR text (today's behaviour), a false positive sends an
 * image to a model that will reject the request outright.
 */
const tinfoilVision = new Map<string, boolean>();

/** Record which Tinfoil models accept images, from the public catalog. */
export function rememberTinfoilVision(models: { id: string; multimodal?: boolean }[]): void {
  for (const model of models) {
    if (typeof model.multimodal === "boolean") {
      tinfoilVision.set(model.id, model.multimodal);
    }
  }
}

/**
 * True when this model accepts image content blocks.
 *
 * Fails closed everywhere: an unreachable Ollama, a malformed payload, or a
 * model missing from the catalog all read as "text only", which is exactly
 * what the app did before this existed.
 */
export async function modelSeesImages(model: string): Promise<boolean> {
  const cached = known.get(model);
  if (cached !== undefined) {
    return cached;
  }
  if (isTinfoilModel(model)) {
    const listed = tinfoilVision.get(tinfoilModelId(model));
    // Not in the catalog yet: answer "text only" for this turn but do NOT
    // remember it. The catalog is fetched by the model picker, so a scheduled
    // routine can easily run first with nothing loaded — caching that miss
    // would send OCR text to a vision model for the rest of the session, long
    // after the flags arrived.
    if (listed === undefined) {
      return false;
    }
    known.set(model, listed);
    return listed;
  }
  const answer = await ollamaSeesImages(model);
  known.set(model, answer);
  return answer;
}

/** `/api/show` for one local model, reduced to the vision question. */
async function ollamaSeesImages(model: string): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return false;
    }
    const payload: unknown = await response.json();
    // A local HTTP payload is still untrusted input: check the shape rather
    // than casting, so a surprising body reads as "no" instead of throwing
    // inside a turn.
    const capabilities =
      payload !== null && typeof payload === "object" && "capabilities" in payload
        ? (payload as { capabilities: unknown }).capabilities
        : null;
    return Array.isArray(capabilities) && capabilities.includes("vision");
  } catch {
    return false;
  }
}

/** Drop cached answers. For tests, and for a model pulled mid-session. */
export function forgetModelCapabilities(): void {
  known.clear();
  tinfoilVision.clear();
}
