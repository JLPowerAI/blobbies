import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Agent, Message, Routine } from "@/data/agents";
import type { BlobMemory } from "@/lib/blob-tools";
import { type Group, groupIdFromConversation } from "@/lib/groups";
import type { McpServerConfig } from "@/lib/mcp";
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
  /**
   * Local MCP servers. Lives here rather than in a new slice because it is
   * app-wide config, not Blob state — and this file is not a secret store:
   * `parseLoopbackUrl` rejects URLs carrying credentials.
   */
  mcpServers?: McpServerConfig[];
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

/**
 * Every localStorage key this module has written, so the test hook below can
 * wipe exactly those: `localStorage.clear()` would take the app's own
 * preferences (`pref:*`) with it, and they share the origin.
 */
const writtenKeys = new Set<string>();

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
      writtenKeys.add(key);
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

/** Test hook: wipe the fallback backend, leaving other keys on the origin. */
export function clearFallbackBackend(): void {
  memoryBackend.clear();
  for (const key of writtenKeys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // no localStorage: the memory clear above was enough
    }
  }
  writtenKeys.clear();
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

/** Slice keys whose most recent write failed. */
const failedKeys = new Set<string>();
const saveFailureListeners = new Set<(keys: ReadonlySet<string>) => void>();

/**
 * Watch for slices that have stopped saving.
 *
 * A failed write is otherwise invisible: the app holds every message in
 * memory and keeps rendering it, so a conversation that no longer persists
 * looks exactly like one that does — until a restart, when everything after
 * the failure is gone. The likeliest cause is a transcript outgrowing
 * `MAX_SLICE_BYTES` (8 MB, enforced in `store.rs`), where refusing the write
 * is correct: a larger file could never be read back, and the next save would
 * overwrite the last good copy. Correct, but worth saying out loud.
 *
 * Returns an unsubscribe function.
 */
export function onSaveFailure(listener: (keys: ReadonlySet<string>) => void): () => void {
  saveFailureListeners.add(listener);
  return () => {
    saveFailureListeners.delete(listener);
  };
}

/** Record a slice's write outcome, notifying only when it actually changes. */
function setFailed(key: string, failed: boolean): void {
  const changed = failed ? !failedKeys.has(key) : failedKeys.delete(key);
  if (failed) {
    failedKeys.add(key);
  }
  // Every keystroke queues a write; re-notifying on each success would
  // re-render subscribers for nothing.
  if (!changed) {
    return;
  }
  for (const listener of saveFailureListeners) {
    listener(failedKeys);
  }
}

/**
 * Start a write nobody is awaiting, and report a failure instead of dropping
 * it on the floor.
 *
 * The debounced and unload paths are fire-and-forget by design — no caller is
 * left to await them. Without this the rejection surfaces as an unhandled
 * promise rejection with a bare Rust string and a stack pointing into this
 * module, which says nothing about which slice failed.
 *
 * Deliberately not a retry: a write that failed here is already superseded by
 * whatever is in memory, and the next change writes the whole slice again.
 * That is also why a later success clears the flag: the next write carries
 * everything the failed one would have.
 */
function startWrite(key: string, value: unknown): void {
  void rawWrite(key, value)
    .then(() => setFailed(key, false))
    .catch((error: unknown) => {
      // Naming the key is the point: "roster" failing and one Blob's transcript
      // failing are very different problems.
      console.error(`Could not save ${key}:`, error);
      setFailed(key, true);
    });
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
      startWrite(key, latest);
    }, WRITE_DEBOUNCE_MS),
  );
}

/**
 * Flush every pending write synchronously-ish; called on window unload.
 *
 * These are the writes most likely to fail: the window is going away, and in
 * Tauri the Rust side may finish tearing down before the reply lands — which
 * is where "Couldn't find callback id" comes from. Reporting beats an
 * unhandled rejection thrown from a page that no longer exists.
 */
function flushAll(): void {
  for (const [key, timer] of pendingWrites) {
    clearTimeout(timer);
    startWrite(key, pendingValues.get(key));
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

/**
 * Memories shared by every Blob ("All Blobs" scope), stored in the root
 * `user` slice. Per-Blob memories stay in that Blob's config.
 */
export async function loadUserMemories(): Promise<BlobMemory[] | null> {
  const value = await rawRead("user");
  return Array.isArray(value) ? (value as BlobMemory[]) : null;
}

export function saveUserMemories(memories: BlobMemory[]): void {
  queueWrite("user", memories);
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

/**
 * Group chats. The list is one root slice (names and ids only); each group's
 * transcript is its own slice, so a busy group never bloats the list.
 */
export async function loadGroups(): Promise<Group[] | null> {
  const value = await rawRead("groups");
  return Array.isArray(value) ? (value as Group[]) : null;
}

export function saveGroups(groups: Group[]): void {
  queueWrite("groups", groups);
}

export async function loadGroupTranscript(id: string): Promise<Message[] | null> {
  const value = await rawRead(`groups/${id}/transcript`);
  return Array.isArray(value) ? (value as Message[]) : null;
}

export function saveGroupTranscript(id: string, messages: Message[]): void {
  queueWrite(`groups/${id}/transcript`, messages);
}

/**
 * Persist a conversation without caring which kind it is — the turn loop
 * writes through here, since a Blob's reply lands in its own transcript or in
 * a group's depending only on where it was asked.
 */
export function saveConversation(conversationId: string, messages: Message[]): void {
  const groupId = groupIdFromConversation(conversationId);
  if (groupId === null) {
    saveBlobTranscript(conversationId, messages);
    return;
  }
  saveGroupTranscript(groupId, messages);
}

/**
 * The slice key a conversation's messages are written to.
 *
 * Exported so the UI can match a conversation against `onSaveFailure` without
 * rebuilding the key format — a second copy of `blobs/${id}/transcript` would
 * drift from this one and quietly stop matching.
 */
export function conversationSliceKey(conversationId: string): string {
  const groupId = groupIdFromConversation(conversationId);
  return groupId === null ? `blobs/${conversationId}/transcript` : `groups/${groupId}/transcript`;
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

/**
 * Write every slice this Blob owns to one JSON file in Downloads and reveal
 * it in the file manager. Returns the path, or null outside Tauri.
 *
 * The bundle is assembled in Rust so the filename and target directory are
 * validated there — the Blob name is user text going into a path.
 */
export async function exportBlob(id: string, name: string): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }
  const path = await invoke<string>("store_export_blob", { id, name });
  await revealItemInDir(path);
  return path;
}

/** Immediate (non-debounced) roster write, for create/delete. */
export async function flushRoster(rows: Agent[]): Promise<void> {
  await flushWrite("roster", rows);
}
