/**
 * What a turn is doing, published per conversation for anything watching from
 * outside the React tree.
 *
 * The app renders a turn straight from state; an external ACP client cannot —
 * it needs the same beats as events, in order, keyed by the conversation they
 * belong to. Rather than move orchestration out of `App.tsx` (the group
 * router, the lanes, the run records all live there), the existing choke
 * points publish here and the ACP host subscribes.
 *
 * Module-level like `updater.ts`, with no React and no Tauri: `App.tsx`
 * publishes, `lib/acp/host.ts` listens, and neither needs the other. Publishing
 * with nobody subscribed is a Map lookup, so the common case — no editor
 * attached — costs nothing per segment.
 */

import type { Message } from "@/data/agents";
import type { BlobActivity } from "@/lib/activity";
import type { ActiveRun } from "@/lib/run-state";

export type ConversationEvent =
  /** One finished speech bubble. `blobId` is the speaker (groups have several). */
  | { type: "segment"; blobId: string; text: string }
  /** A tool call that has already settled — Blobs report calls, not intents. */
  | {
      type: "tool_call";
      blobId: string;
      name: string;
      args?: string;
      result?: string;
      failed?: boolean;
    }
  /** Coarse status word for the speaker, on change only. */
  | { type: "activity"; blobId: string; activity: BlobActivity }
  /** The turn parked on a question; the run is `waiting_input` until answered. */
  | { type: "ask"; blobId: string; question: string; kind: "question" | "action" }
  /** A run record moved. Carries the whole record: status alone loses the ask. */
  | { type: "run_status"; status: ActiveRun["status"]; run: ActiveRun }
  /** A message landed in the transcript from anywhere (including the app's UI). */
  | { type: "message"; message: Message }
  /**
   * The exchange this conversation was running has settled: one turn for a
   * Blob, every responder for a group.
   */
  | { type: "exchange_end"; outcome: "done" | "failed" | "cancelled" };

type Listener = (event: ConversationEvent) => void;

const listeners = new Map<string, Set<Listener>>();

/** Listen to one conversation. Returns the unsubscribe. */
export function subscribeConversation(conversationId: string, listener: Listener): () => void {
  const existing = listeners.get(conversationId);
  const set = existing ?? new Set<Listener>();
  if (existing === undefined) {
    listeners.set(conversationId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(conversationId);
    }
  };
}

/** True when anything is watching — the guard callers use to skip work. */
export function hasConversationListeners(conversationId: string): boolean {
  return listeners.has(conversationId);
}

/**
 * Publish one event. A throwing listener must never take a turn down with it:
 * this runs inside `requestReply`, where the reply is the user's actual work.
 */
export function publishConversation(conversationId: string, event: ConversationEvent): void {
  const set = listeners.get(conversationId);
  if (set === undefined) {
    return;
  }
  for (const listener of [...set]) {
    try {
      listener(event);
    } catch {
      // A broken observer is not a broken turn.
    }
  }
}
