/**
 * Everything the editor bridge does once it is switched on.
 *
 * Separate from `useAcpBridge.ts` for one reason: that hook has to be in the
 * startup chunk (hooks cannot be lazy), and this is where the weight is — the
 * listener's lifetime, one event subscription for every client, the pairing
 * gate, and behind them the ACP SDK. A user who never turns the bridge on
 * never loads a byte of it.
 *
 * Pairing is enforced here rather than in Rust: a client is identified by what
 * it says in `initialize`, and that frame has to be read as JSON before its
 * name exists. Until the user approves, frames are held and nothing reaches a
 * Blob — an unapproved client cannot prompt, list Blobs or read a transcript.
 *
 * **What pairing is and is not.** The name comes from the connecting process,
 * so remembering it is a convenience for an editor the user already trusts,
 * not a boundary against a local process that has read the token file and is
 * willing to claim that name. The boundaries that do hold sit under it: the
 * bridge does not exist until it is switched on, the token file is user-only,
 * a nameless client is never auto-admitted, one prompt cannot be swapped for
 * another's, and revoking a name disconnects the sessions using it.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { type AcpFrameEvent, type AcpTransport, connectionTransport } from "@/lib/acp/bridge";
import type { AcpHostDeps } from "@/lib/acp/host";
import { createAcpAgent } from "@/lib/acp/host";
import type { AcpBridgeInfo, AcpPairingRequest } from "@/lib/acp/useAcpBridge";

/**
 * Frames a client may send before it is approved.
 *
 * An editor sends `initialize` and waits. A client that keeps talking through
 * a prompt it has not been given is not being polite, so it is dropped rather
 * than buffered indefinitely.
 */
const MAX_UNPAIRED_FRAMES = 8;

/** How the hook hears about anything it has to render. */
export interface AcpAttachCallbacks {
  onInfo: (info: AcpBridgeInfo) => void;
  onConnected: (names: string[]) => void;
  onPairing: (request: AcpPairingRequest | null) => void;
  /** Whether this client name was approved before, so it skips the prompt. */
  isPaired: (name: string) => boolean;
  /** Records a newly approved client name. */
  onPaired: (name: string) => void;
}

export interface AcpAttachment {
  approve: (id: number) => void;
  deny: (id: number) => void;
  /** Disconnect every live client using this name. */
  revoke: (name: string) => void;
  detach: () => void;
}

/**
 * Stand-in for a client that did not name itself.
 *
 * Never treated as a paired identity — it is a label for the dialog, and a
 * name every anonymous client shares cannot be an approval that carries over.
 */
const UNNAMED = "Unknown editor";

/**
 * The client's name from an `initialize` frame, when that is what this is.
 *
 * Returns `undefined` for anything that is not an initialize — the caller uses
 * that to tell "still waiting to learn who this is" from "this is nameless".
 */
export function initializeClientName(line: string): string | undefined {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const record = message as { method?: unknown; params?: { clientInfo?: { name?: unknown } } };
  if (record.method !== "initialize") {
    return undefined;
  }
  const name = record.params?.clientInfo?.name;
  if (typeof name !== "string") {
    return UNNAMED;
  }
  // The name is whatever a process that was unauthenticated a moment ago
  // claimed. React escapes it on render; stripping \p{C} (Unicode's control,
  // format and surrogate category) and clipping the length is what stops it
  // smearing itself across the pairing prompt as extra lines of copy.
  const clean = name.replace(/\p{C}/gu, "").trim().slice(0, 64);
  return clean === "" ? UNNAMED : clean;
}

interface Connection {
  transport: AcpTransport & { feed: { push: (line: string) => void; end: () => void } };
  /** Frames held while the user decides. */
  held: string[];
  name?: string;
  approved: boolean;
}

/**
 * Start the listener and route its connections to the ACP host.
 *
 * @param deps reads the app's current send paths and accessors. A getter, not
 *   a value: they close over state that changes every render, while the host
 *   holds one reference for the life of a connection — so a session opened an
 *   hour ago still sees Blobs created since.
 */
export async function attachAcp(
  deps: () => AcpHostDeps,
  callbacks: AcpAttachCallbacks,
): Promise<AcpAttachment> {
  const { ndJsonStream } = await import("@agentclientprotocol/sdk");
  const connections = new Map<number, Connection>();
  /** Connection ids waiting on the user, oldest first. */
  let pending: number[] = [];
  const app = createAcpAgent({
    roster: () => deps().roster(),
    groups: () => deps().groups(),
    transcript: (id) => deps().transcript(id),
    sendToBlob: (blob, text) => deps().sendToBlob(blob, text),
    sendToGroup: (group, text) => deps().sendToGroup(group, text),
    stop: (id) => deps().stop(id),
    defaultBlob: () => deps().defaultBlob(),
  });

  const refreshConnected = () => {
    callbacks.onConnected(
      [...connections.values()].filter((one) => one.approved).map((one) => one.name ?? UNNAMED),
    );
  };

  const admit = (id: number) => {
    const entry = connections.get(id);
    if (entry === undefined) {
      return;
    }
    entry.approved = true;
    for (const line of entry.held) {
      entry.transport.feed.push(line);
    }
    entry.held = [];
    refreshConnected();
  };

  const drop = (id: number) => {
    const entry = connections.get(id);
    connections.delete(id);
    entry?.transport.feed.end();
    void invoke("acp_close", { id }).catch(() => undefined);
    // A prompt for a connection that no longer exists must never stay on
    // screen: the click would land on whatever id took its place.
    if (pending[0] === id) {
      pending.shift();
    } else {
      pending = pending.filter((waiting) => waiting !== id);
    }
    showNextPending();
    refreshConnected();
  };

  /** Show the oldest connection still waiting, or nothing. */
  const showNextPending = () => {
    const next = pending[0];
    const entry = next === undefined ? undefined : connections.get(next);
    callbacks.onPairing(
      next === undefined || entry === undefined ? null : { id: next, name: entry.name ?? UNNAMED },
    );
  };

  const unlisteners: UnlistenFn[] = [
    await listen<{ id: number }>("acp://open", ({ payload }) => {
      const transport = connectionTransport(payload.id);
      connections.set(payload.id, { transport, held: [], approved: false });
      // One agent connection per client. The frames are newline-delimited
      // JSON, exactly as a stdio agent's are.
      app.connect(ndJsonStream(transport.writable, transport.readable));
    }),
    await listen<AcpFrameEvent>("acp://frame", ({ payload }) => {
      const entry = connections.get(payload.id);
      if (entry === undefined) {
        return;
      }
      if (entry.approved) {
        entry.transport.feed.push(payload.line);
        return;
      }
      if (entry.name === undefined) {
        const name = initializeClientName(payload.line);
        if (name !== undefined) {
          entry.name = name;
          // A client that did not name itself is never auto-admitted: the
          // placeholder is a label for a dialog, not an identity to match on.
          if (name !== UNNAMED && callbacks.isPaired(name)) {
            entry.held.push(payload.line);
            admit(payload.id);
            return;
          }
          // Queued, not swapped in: a second client must not be able to
          // replace the prompt the user is already looking at and collect
          // their click for itself.
          pending.push(payload.id);
          if (pending.length === 1) {
            showNextPending();
          }
        }
      }
      if (entry.held.length >= MAX_UNPAIRED_FRAMES) {
        drop(payload.id);
        return;
      }
      entry.held.push(payload.line);
    }),
    await listen<{ id: number }>("acp://close", ({ payload }) => {
      connections.get(payload.id)?.transport.feed.end();
      connections.delete(payload.id);
      pending = pending.filter((waiting) => waiting !== payload.id);
      showNextPending();
      refreshConnected();
    }),
  ];

  const started = await invoke<{ port: number; configPath: string }>("acp_start");
  const relayPath = await invoke<string>("acp_relay_path");
  callbacks.onInfo({ ...started, relayPath });

  return {
    approve: (id) => {
      const name = connections.get(id)?.name;
      if (name !== undefined && name !== UNNAMED) {
        callbacks.onPaired(name);
      }
      pending = pending.filter((waiting) => waiting !== id);
      showNextPending();
      admit(id);
    },
    deny: (id) => {
      drop(id);
    },
    /**
     * Revoke a client name: forgetting it is not enough, because a session
     * admitted under it keeps its access until the socket closes.
     */
    revoke: (name) => {
      for (const [id, entry] of [...connections]) {
        if (entry.name === name) {
          drop(id);
        }
      }
    },
    detach: () => {
      for (const unlisten of unlisteners) {
        unlisten();
      }
      for (const entry of connections.values()) {
        entry.transport.feed.end();
      }
      connections.clear();
      void invoke("acp_stop").catch(() => undefined);
    },
  };
}
