import { invoke } from "@tauri-apps/api/core";
import type { Agent, Message, Routine } from "@/data/agents";
import { type ActiveRun, parseRun } from "@/lib/run-state";
import { isTauri } from "@/lib/tauri";

/**
 * Typed access to the on-disk slice store (Rust side, atomic writes).
 * In a plain browser (dev server, jsdom tests) it falls back to localStorage
 * under the same keys, so behavior is identical without Tauri.
 */

export type BlobSliceName = "config" | "routines" | "transcript" | "runs";

export interface Settings {
  userName: string;
  theme: string;
  timezone: string;
  /** Ollama model tag used for chat, e.g. "llama3.2:latest". Empty = unset. */
  model: string;
  plugins: string[];
}

export interface UiLayout {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  detailOpen: boolean;
}

/** How long edits coalesce before hitting disk. */
const WRITE_DEBOUNCE_MS = 300;

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
const pendingValues = new Map<string, unknown>();

/** In-memory fallback when localStorage is unavailable (e.g. jsdom). */
const memoryBackend = new Map<string, string>();

function backendGet(key: string): string | null {
  try {
    if (typeof window.localStorage === "object" && window.localStorage !== null) {
      return window.localStorage.getItem(key);
    }
  } catch {
    // fall through to memory
  }
  return memoryBackend.get(key) ?? null;
}

function backendSet(key: string, value: string): void {
  try {
    if (typeof window.localStorage === "object" && window.localStorage !== null) {
      window.localStorage.setItem(key, value);
      return;
    }
  } catch {
    // fall through to memory
  }
  memoryBackend.set(key, value);
}

function backendRemove(key: string): void {
  try {
    if (typeof window.localStorage === "object" && window.localStorage !== null) {
      window.localStorage.removeItem(key);
      return;
    }
  } catch {
    // fall through to memory
  }
  memoryBackend.delete(key);
}

/** Test hook: wipe the fallback backend. */
export function clearFallbackBackend(): void {
  memoryBackend.clear();
  try {
    window.localStorage.clear();
  } catch {
    // no localStorage: memory clear was enough
  }
}

async function rawRead(key: string): Promise<unknown> {
  if (isTauri()) {
    return invoke("store_read", { key });
  }
  const raw = backendGet(`slice:${key}`);
  try {
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function rawWrite(key: string, value: unknown): Promise<void> {
  if (isTauri()) {
    await invoke("store_write", { key, value });
    return;
  }
  backendSet(`slice:${key}`, JSON.stringify(value));
}

/** Write immediately, cancelling any pending debounce for the key. */
async function flushWrite(key: string, value: unknown): Promise<void> {
  const timer = pendingWrites.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingWrites.delete(key);
    pendingValues.delete(key);
  }
  await rawWrite(key, value);
}

/** Debounced write; rapid successive calls collapse into one disk write. */
function queueWrite(key: string, value: unknown): void {
  pendingValues.set(key, value);
  const existing = pendingWrites.get(key);
  if (existing !== undefined) {
    clearTimeout(existing);
  }
  pendingWrites.set(
    key,
    setTimeout(() => {
      pendingWrites.delete(key);
      const latest = pendingValues.get(key);
      pendingValues.delete(key);
      void rawWrite(key, latest);
    }, WRITE_DEBOUNCE_MS),
  );
}

/** Flush every pending write synchronously-ish; called on window unload. */
function flushAll(): void {
  for (const [key, timer] of pendingWrites) {
    clearTimeout(timer);
    void rawWrite(key, pendingValues.get(key));
  }
  pendingWrites.clear();
  pendingValues.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushAll);
}

// ---------------------------------------------------------------- typed API

export async function loadRoster(): Promise<Agent[] | null> {
  const value = await rawRead("roster");
  return Array.isArray(value) ? (value as Agent[]) : null;
}

export function saveRoster(rows: Agent[]): void {
  queueWrite("roster", rows);
}

export async function loadSettings(): Promise<Partial<Settings> | null> {
  const value = await rawRead("settings");
  return value !== null && typeof value === "object" ? (value as Partial<Settings>) : null;
}

export function saveSettings(settings: Settings): void {
  queueWrite("settings", settings);
}

export async function loadUiLayout(): Promise<Partial<UiLayout> | null> {
  const value = await rawRead("ui-layout");
  return value !== null && typeof value === "object" ? (value as Partial<UiLayout>) : null;
}

export function saveUiLayout(layout: UiLayout): void {
  queueWrite("ui-layout", layout);
}

export async function loadBlobRoutines(id: string): Promise<Routine[] | null> {
  const value = await rawRead(`blobs/${id}/routines`);
  return Array.isArray(value) ? (value as Routine[]) : null;
}

export function saveBlobRoutines(id: string, routines: Routine[]): void {
  queueWrite(`blobs/${id}/routines`, routines);
}

export async function loadBlobTranscript(id: string): Promise<Message[] | null> {
  const value = await rawRead(`blobs/${id}/transcript`);
  return Array.isArray(value) ? (value as Message[]) : null;
}

export function saveBlobTranscript(id: string, messages: Message[]): void {
  queueWrite(`blobs/${id}/transcript`, messages);
}

export function saveBlobConfig(id: string, config: Agent): void {
  queueWrite(`blobs/${id}/config`, config);
}

export async function loadBlobRun(id: string): Promise<ActiveRun | null> {
  return parseRun(await rawRead(`blobs/${id}/runs`));
}

/**
 * Immediate write, not debounced: the record exists so a crash mid-run is
 * visible on relaunch, which a 300ms debounce window would defeat.
 */
export async function saveBlobRun(id: string, run: ActiveRun): Promise<void> {
  await flushWrite(`blobs/${id}/runs`, run);
}

/** Soft-delete: moves the Blob dir to trash (purged after 30 days). */
export async function deleteBlobData(id: string): Promise<void> {
  if (isTauri()) {
    await invoke("store_delete_blob", { id });
    return;
  }
  for (const slice of ["config", "routines", "transcript", "runs"]) {
    backendRemove(`slice:blobs/${id}/${slice}`);
  }
}

/** Immediate (non-debounced) roster write, for create/delete. */
export async function flushRoster(rows: Agent[]): Promise<void> {
  await flushWrite("roster", rows);
}
