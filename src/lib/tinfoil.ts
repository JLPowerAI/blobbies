import {
  providerRegistry,
  type StreamEvent,
  type StreamOptions,
  type StreamResponse,
  StreamResult,
  type ThinkingLevel,
} from "@kenkaiiii/gg-ai";
import { SecureClient } from "tinfoil";
import { getSecret, setSecret } from "@/lib/secrets";

/**
 * Tinfoil: the one non-local model path, by explicit product decision.
 *
 * Inference runs in attested AMD SEV-SNP enclaves; request bodies are
 * HPKE-encrypted end-to-end (EHBP) and the enclave's code is verified
 * client-side against a Sigstore transparency log before the first byte is
 * sent. `SecureClient` does all of that; this module only routes gg-ai's
 * existing OpenAI provider through its verified transport.
 *
 * The id helpers below live in the leaf `tinfoil-model.ts` so UI modules can
 * check a model id without loading this stack; re-exported for back-compat.
 */
import { TINFOIL_BASE_URL, tinfoilModelId } from "@/lib/tinfoil-model";

export {
  isTinfoilModel,
  TINFOIL_BASE_URL,
  TINFOIL_MODEL_PREFIX,
  tinfoilModelId,
} from "@/lib/tinfoil-model";

interface TinfoilState {
  apiKey: string;
  userCacheSecret: string | undefined;
  /** Created on first use so a saved key doesn't attest at app startup. */
  client: SecureClient | null;
}

let state: TinfoilState | null = null;

/**
 * Install (or clear, with `apiKey: null`) the Tinfoil credentials.
 *
 * The `SecureClient` is created lazily on first request and recreated when
 * the key changes. `userCacheSecret` scopes Tinfoil's server-side prompt
 * cache; persisting one across launches keeps the prefix cache warm.
 */
export function configureTinfoil(options: {
  apiKey: string | null;
  userCacheSecret?: string;
}): void {
  if (options.apiKey === null || options.apiKey === "") {
    state = null;
    return;
  }
  if (
    state !== null &&
    state.apiKey === options.apiKey &&
    state.userCacheSecret === options.userCacheSecret
  ) {
    // Same credentials: keep the existing client (and its completed
    // attestation) instead of forcing a re-verify on the next request.
    return;
  }
  state = { apiKey: options.apiKey, userCacheSecret: options.userCacheSecret, client: null };
}

/**
 * Session cache of the keychain probe. Reading the keychain is not free on
 * macOS: a dev build carries a fresh ad-hoc code signature on every rebuild,
 * so Keychain treats it as a new app and prompts for the login password on
 * every read. One probe per session — invalidated with `force` when Settings
 * changes the key — keeps that to at most one prompt, and only on paths that
 * actually need Tinfoil.
 */
let keychainProbe: Promise<boolean> | null = null;

/**
 * Load the API key from the OS keychain and configure the provider.
 * Creates the persistent cache secret on first use. Returns false when no
 * key is stored (Tinfoil stays off; only local models work).
 *
 * Memoized per session; pass `force` after saving or removing a key.
 */
export function configureTinfoilFromKeychain(force = false): Promise<boolean> {
  if (!force && keychainProbe !== null) {
    return keychainProbe;
  }
  const probe = probeKeychain();
  keychainProbe = probe;
  return probe;
}

async function probeKeychain(): Promise<boolean> {
  const apiKey = await getSecret("tinfoil-api-key");
  if (apiKey === null || apiKey === "") {
    return false;
  }
  let cacheSecret = await getSecret("tinfoil-cache-secret");
  if (cacheSecret === null || cacheSecret === "") {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    cacheSecret = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    await setSecret("tinfoil-cache-secret", cacheSecret);
  }
  configureTinfoil({ apiKey, userCacheSecret: cacheSecret });
  return true;
}

function requireState(): TinfoilState {
  if (state === null) {
    throw new Error("Tinfoil is not configured: add an API key in Settings → Model.");
  }
  return state;
}

function clientFor(current: TinfoilState): SecureClient {
  if (current.client === null) {
    current.client = new SecureClient(
      current.userCacheSecret === undefined ? {} : { userCacheSecret: current.userCacheSecret },
    );
  }
  return current.client;
}

/**
 * Verified-transport fetch: attests the enclave on first use, then sends the
 * request with an HPKE-encrypted body. Adds the Authorization header when the
 * caller didn't (the openai SDK sets its own; direct structured calls don't).
 */
export async function tinfoilFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const current = requireState();
  const headers = new Headers(init?.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${current.apiKey}`);
  }
  return clientFor(current).fetch(input, { ...init, headers });
}

/**
 * Delegate to gg-ai's built-in OpenAI provider over the verified transport.
 *
 * `SecureClient.fetch` only accepts URLs on the attested enclave origin
 * (`https://<bundle.domain>`), which is not guaranteed to be
 * inference.tinfoil.sh — so readiness is awaited first and the enclave's own
 * base URL is handed to the SDK.
 */
async function* streamTinfoil(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const openai = providerRegistry.get("openai");
  if (openai === undefined) {
    throw new Error("gg-ai openai provider is not registered");
  }
  const current = requireState();
  const client = clientFor(current);
  await client.ready();
  // getBaseURL() returns the attested router base *including* /v1 and a
  // trailing slash (e.g. https://router.inf6.tinfoil.sh/v1/) — verified live.
  // Normalize instead of appending: a doubled /v1/v1 path 400s.
  const attested = (client.getBaseURL() ?? TINFOIL_BASE_URL).replace(/\/+$/, "");
  const enclaveBase = attested.endsWith("/v1") ? attested : `${attested}/v1`;
  const { thinking, ...rest } = options;
  const delegated = openai.stream({
    ...rest,
    provider: "openai",
    model: tinfoilModelId(options.model),
    baseUrl: enclaveBase,
    apiKey: current.apiKey,
    fetch: tinfoilFetch,
    // "none" is this app's thinking-off sentinel, not a legal OpenAI
    // reasoning_effort — drop it so Tinfoil's reasoning models use their
    // default effort instead of receiving an invalid value.
    ...(thinking === undefined || thinking === ("none" as ThinkingLevel) ? {} : { thinking }),
  });
  yield* delegated;
  return await delegated.response;
}

/**
 * Register the "tinfoil" provider with gg-ai. Idempotent; call before the
 * first stream (module top of ai.ts, next to the native Ollama provider).
 */
export function registerTinfoilProvider(): void {
  providerRegistry.register("tinfoil", {
    stream: (options: StreamOptions) => new StreamResult(streamTinfoil(options), options.signal),
  });
}

/** One chat model from Tinfoil's public catalog. */
export interface TinfoilModel {
  id: string;
  name: string;
}

/**
 * Public model catalog (no auth, no enclave needed — metadata only).
 * Returns [] on any failure so the Settings UI degrades quietly.
 */
export async function listTinfoilModels(): Promise<TinfoilModel[]> {
  try {
    const response = await fetch(`${TINFOIL_BASE_URL}/models`);
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as {
      data?: { id?: string; name?: string; type?: string }[];
    };
    return (payload.data ?? [])
      .filter((model) => model.type === "chat" && typeof model.id === "string")
      .map((model) => ({ id: model.id as string, name: model.name ?? (model.id as string) }));
  } catch {
    return [];
  }
}

/**
 * One grammar-constrained call through the verified transport: OpenAI
 * structured outputs stand in for Ollama's `format`. Returns the raw content
 * string, or null on any failure — callers keep their fail-closed contract.
 */
export async function tinfoilStructuredCall(options: {
  model: string;
  messages: { role: string; content: string }[];
  schema: Record<string, unknown>;
  schemaName: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string | null> {
  try {
    // Relative path: SecureClient.fetch resolves it against the attested
    // enclave base URL and rejects any other origin.
    const response = await tinfoilFetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      body: JSON.stringify({
        model: tinfoilModelId(options.model),
        stream: false,
        messages: options.messages,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        response_format: {
          type: "json_schema",
          json_schema: { name: options.schemaName, strict: true, schema: options.schema },
        },
      }),
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return payload.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}
