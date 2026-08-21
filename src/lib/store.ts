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
  // Where the archive boundary sits is a fact about the files just deleted,
  // so it has to go with them: a stale boundary would slice the next
  // conversation from an offset its storage no longer has.
  sealedTranscripts.clear();
  rollovers.clear();
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

/**
 * Messages kept in the rewritable `transcript` slice. Past this, the oldest
 * are sealed into `transcript-1`, `transcript-2`, … and never rewritten.
 *
 * A conversation is written out in full on every save, so a single growing
 * slice makes each message cost more than the last — measured at 8ms/2MB per
 * save at 2,000 messages, 14ms/8MB at 7,000, 83ms/64MB at 55,000, all of it
 * re-written every few seconds while someone is typing. It also ends at a
 * wall: past `MAX_SLICE_BYTES` (8MB) Rust refuses the write, correctly, since
 * a larger file could never be read back — and the conversation silently
 * stops persisting. Rolling keeps the rewritten part flat and small, so
 * neither happens however long a conversation runs.
 */
const LIVE_TRANSCRIPT_MAX = 800;

/** How many of the oldest move into an archive when that limit is passed. */
const TRANSCRIPT_ARCHIVE_CHUNK = 400;

/** Per conversation: archives written, and how many messages they hold. */
const sealedTranscripts = new Map<string, { archives: number; messages: number }>();

/** One rollover at a time per conversation, so two cannot claim one number. */
const rollovers = new Map<string, Promise<void>>();

/**
 * Read a conversation back: every archive oldest-first, then the live slice.
 *
 * Duplicates are dropped by message id because the crash window demands it.
 * A rollover writes the archive first and truncates the live slice second, so
 * a crash between the two leaves those messages in both places — the safe
 * direction (nothing is lost), but the reader has to be the one that notices.
 */
async function loadTranscript(base: string): Promise<Message[] | null> {
  let archived: Message[] = [];
  let archives = 0;
  for (;;) {
    const value = await rawRead(`${base}/transcript-${archives + 1}`);
    if (!Array.isArray(value)) {
      break;
    }
    archived = archived.concat(value as Message[]);
    archives += 1;
  }
  const live = await rawRead(`${base}/transcript`);
  if (archives === 0) {
    sealedTranscripts.delete(base);
    return Array.isArray(live) ? (live as Message[]) : null;
  }
  sealedTranscripts.set(base, { archives, messages: archived.length });
  if (!Array.isArray(live)) {
    return archived;
  }
  const seen = new Set(archived.map((message) => message.id));
  return archived.concat((live as Message[]).filter((message) => !seen.has(message.id)));
}

/**
 * Persist a conversation, rolling its oldest messages away once it is long
 * enough that rewriting all of them has become the expensive part.
 *
 * Callers always pass the whole conversation — archived prefix included — so
 * the already-sealed count is what decides where the live slice starts.
 */
function saveTranscript(base: string, messages: Message[]): void {
  const mark = sealedTranscripts.get(base) ?? { archives: 0, messages: 0 };
  // Clamped: a caller holding fewer messages than we have sealed would
  // otherwise slice from beyond the end and quietly persist nothing.
  const alreadySealed = Math.min(mark.messages, messages.length);
  const live = messages.slice(alreadySealed);
  // Always queue the untruncated live slice first. If the archive below fails
  // or the app dies mid-rollover, this is what is on disk, and it still holds
  // every message.
  queueWrite(`${base}/transcript`, live);
  if (live.length <= LIVE_TRANSCRIPT_MAX) {
    return;
  }
  const chunk = live.slice(0, TRANSCRIPT_ARCHIVE_CHUNK);
  const rest = live.slice(TRANSCRIPT_ARCHIVE_CHUNK);
  const next = (rollovers.get(base) ?? Promise.resolve())
    .then(async () => {
      const current = sealedTranscripts.get(base) ?? { archives: 0, messages: 0 };
      // A rollover queued behind another one has already been superseded:
      // its chunk was computed against a boundary that has since moved.
      if (current.messages !== alreadySealed) {
        return;
      }
      await rawWrite(`${base}/transcript-${current.archives + 1}`, chunk);
      sealedTranscripts.set(base, {
        archives: current.archives + 1,
        messages: current.messages + chunk.length,
      });
      queueWrite(`${base}/transcript`, rest);
    })
    .catch(() => {
      // Nothing was truncated, so the live slice still carries everything and
      // the next save tries again. `startWrite` reports the failure itself.
    });
  rollovers.set(base, next);
}

export async function loadBlobRoutines(id: string): Promise<Routine[] | null> {
  const value = await rawRead(`blobs/${id}/routines`);
  return Array.isArray(value) ? (value as Routine[]) : null;
}

export function saveBlobRoutines(id: string, routines: Routine[]): void {
  queueWrite(`blobs/${id}/routines`, routines);
}

export async function loadBlobTranscript(id: string): Promise<Message[] | null> {
  return await loadTranscript(`blobs/${id}`);
}

export function saveBlobTranscript(id: string, messages: Message[]): void {
  saveTranscript(`blobs/${id}`, messages);
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
  return await loadTranscript(`groups/${id}`);
}

export function saveGroupTranscript(id: string, messages: Message[]): void {
  saveTranscript(`groups/${id}`, messages);
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
