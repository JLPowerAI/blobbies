import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";

/**
 * Local Ollama server access. Blobbies is local-only by design: this endpoint
 * is the sole model source, and it must stay allowed by the webview CSP
 * (`connect-src` in tauri.conf.json).
 */
export const OLLAMA_URL = "http://127.0.0.1:11434";

/** How long a liveness probe waits before declaring the server down. */
const PROBE_TIMEOUT_MS = 2500;

export interface OllamaModel {
  /** Full tag, e.g. "llama3.2:latest" — also the model id used for chat. */
  name: string;
}

/**
 * True when the Ollama binary/app is present on this machine, even if the
 * server is not running. In a plain browser there is no way to see the
 * filesystem, so a responding server is the only signal.
 */
export async function isOllamaInstalled(): Promise<boolean> {
  if (!isTauri()) {
    return (await getOllamaVersion()) !== null;
  }
  try {
    return await invoke<boolean>("ollama_installed");
  } catch {
    return false;
  }
}

/** Server version when Ollama is running, null when unreachable. */
export async function getOllamaVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json();
    const version =
      payload !== null && typeof payload === "object" && "version" in payload
        ? payload.version
        : null;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return null;
  }
}

/**
 * Launch the local Ollama server (a headless `ollama serve`), then wait until
 * it answers. Resolves true once the server is reachable, false when it never
 * came up (or when not running inside Tauri).
 */
export async function startOllama(): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }
  try {
    await invoke("ollama_start");
  } catch {
    return false;
  }
  // The app/server takes a moment to bind the port; poll for up to ~10s.
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await getOllamaVersion()) !== null) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Ask the server to release a model's memory now instead of waiting out its
 * keep_alive timer. An empty-messages chat with `keep_alive: 0` is Ollama's
 * documented unload; used when the user switches models so the old one
 * (gigabytes of weights + KV cache) doesn't sit resident beside the new one
 * for the rest of its 30-minute timer. Best-effort: on any failure the timer
 * frees it eventually.
 */
export async function unloadOllamaModel(model: string): Promise<void> {
  if (model === "") {
    return;
  }
  try {
    await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [], keep_alive: 0 }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    // Server down or model already gone — nothing to free.
  }
}

/** Models already pulled locally, via GET /api/tags. Empty when unreachable. */
export async function listOllamaModels(): Promise<OllamaModel[]> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return [];
    }
    const payload: unknown = await response.json();
    const rows =
      payload !== null && typeof payload === "object" && "models" in payload
        ? payload.models
        : null;
    if (!Array.isArray(rows)) {
      return [];
    }
    const models: OllamaModel[] = [];
    for (const row of rows) {
      if (row === null || typeof row !== "object") {
        continue;
      }
      const record = row as Record<string, unknown>;
      if (typeof record.name !== "string" || record.name.length === 0) {
        continue;
      }
      models.push({ name: record.name });
    }
    return models;
  } catch {
    return [];
  }
}
