/**
 * Mounts the ACP editor bridge in the app, when the user has turned it on.
 *
 * Only React state and the toggle's lifetime live here. Hooks cannot be lazy,
 * so this file is in the startup chunk and everything with weight — the
 * listener, the pairing gate, the ACP SDK — is behind the `import()` in the
 * effect (`attach.ts`), where a user who never enables the bridge never
 * reaches it.
 */

import { useEffect, useRef, useState } from "react";
import type { AcpAttachment } from "@/lib/acp/attach";
import type { AcpHostDeps } from "@/lib/acp/host";
import { isTauri } from "@/lib/tauri";

/** Where the app told the relay to connect, plus the path a user configures. */
export interface AcpBridgeInfo {
  port: number;
  configPath: string;
  relayPath: string;
}

/** A client waiting for the user to approve it. */
export interface AcpPairingRequest {
  id: number;
  /** The client's self-reported name — untrusted text, rendered as such. */
  name: string;
}

export interface AcpBridge {
  info: AcpBridgeInfo | null;
  /** Names of clients currently connected. */
  connected: string[];
  /** The connection waiting on the user, if any. */
  pairing: AcpPairingRequest | null;
  /** Anything that went wrong turning the bridge on. */
  error: string | null;
  approve: (id: number) => void;
  deny: (id: number) => void;
  /** Forget a client name AND disconnect any session already using it. */
  revoke: (name: string) => void;
}

/**
 * @param enabled whether the user has turned the bridge on.
 * @param deps the app's send paths and accessors, handed to the host.
 * @param isPaired whether a client name was approved before (skips the prompt).
 * @param onPaired records a newly approved client name.
 */
export function useAcpBridge(
  enabled: boolean,
  deps: AcpHostDeps,
  isPaired: (name: string) => boolean,
  onPaired: (name: string) => void,
): AcpBridge {
  const [info, setInfo] = useState<AcpBridgeInfo | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const [pairing, setPairing] = useState<AcpPairingRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attachment = useRef<AcpAttachment | null>(null);

  // Read through a ref, never captured: every one of these closes over app
  // state that changes each render, and the bridge outlives any single one.
  const latest = useRef({ deps, isPaired, onPaired });
  latest.current = { deps, isPaired, onPaired };

  useEffect(() => {
    if (!enabled || !isTauri()) {
      setInfo(null);
      setConnected([]);
      setPairing(null);
      setError(null);
      return;
    }
    let cancelled = false;

    void import("@/lib/acp/attach")
      .then(({ attachAcp }) =>
        attachAcp(() => latest.current.deps, {
          onInfo: setInfo,
          onConnected: setConnected,
          onPairing: setPairing,
          isPaired: (name) => latest.current.isPaired(name),
          onPaired: (name) => latest.current.onPaired(name),
        }),
      )
      .then((attached) => {
        // Turned off again while the listener was starting: it has to be shut
        // down, not adopted, or the socket outlives the switch.
        if (cancelled) {
          attached.detach();
          return;
        }
        attachment.current = attached;
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });

    return () => {
      cancelled = true;
      attachment.current?.detach();
      attachment.current = null;
    };
  }, [enabled]);

  return {
    info,
    connected,
    pairing,
    error,
    approve: (id) => attachment.current?.approve(id),
    deny: (id) => attachment.current?.deny(id),
    revoke: (name) => attachment.current?.revoke(name),
  };
}
