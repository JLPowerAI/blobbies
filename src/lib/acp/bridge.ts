/**
 * A Web stream pair over the Tauri relay, so the ACP SDK can run in the webview.
 *
 * The SDK wants what a stdio agent has: a readable of incoming bytes and a
 * writable for outgoing ones. Here the wire is `acp.rs` — one loopback socket
 * per editor, its frames arriving as Tauri events and leaving through
 * `acp_send`. This module is the adapter and nothing else; it does not know
 * what a session is.
 *
 * Frames arrive push-based from a socket the app does not control, so the
 * queue is bounded: an editor that floods faster than the host can read gets
 * its connection dropped rather than growing the webview's heap without limit.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * Bytes buffered from one client before it is treated as hostile.
 *
 * Counted in bytes rather than frames because a frame is capped at a megabyte:
 * a few hundred queued frames would be a few hundred megabytes of webview
 * heap, which is the flood this is meant to stop.
 */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export interface AcpFrameEvent {
  id: number;
  line: string;
}

/** The socket half of a bridge — what `host.ts` needs and what tests fake. */
export interface AcpTransport {
  /** Frames from this client, in order, ending when it disconnects. */
  readable: ReadableStream<Uint8Array>;
  /** Frames to this client. */
  writable: WritableStream<Uint8Array>;
  /** Drop the connection (used to refuse an unpaired client). */
  close(): Promise<void>;
}

/** Deliver one frame, or drop the connection when the peer floods. */
export interface AcpFeed {
  push(line: string): void;
  end(): void;
}

/**
 * Build a transport around two functions, so the framing rules are testable
 * without Tauri: `send` puts one line on the wire, `close` drops it.
 */
export function createTransport(
  send: (line: string) => Promise<void>,
  close: () => Promise<void>,
): AcpTransport & { feed: AcpFeed } {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let ended = false;

  let queuedBytes = 0;
  const readable = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    pull() {
      queuedBytes = 0;
    },
    cancel() {
      ended = true;
      void close();
    },
  });

  const feed: AcpFeed = {
    push(line) {
      if (ended || controller === undefined) {
        return;
      }
      const chunk = encoder.encode(`${line}\n`);
      // Reset on every pull, so this measures the backlog while the host is
      // behind rather than the total a well-behaved editor has ever sent.
      queuedBytes += chunk.byteLength;
      if (queuedBytes > MAX_QUEUED_BYTES) {
        feed.end();
        void close();
        return;
      }
      controller.enqueue(chunk);
    },
    end() {
      if (ended || controller === undefined) {
        return;
      }
      ended = true;
      controller.close();
    },
  };

  // The SDK writes whole `…\n` messages; the relay is line-framed, so a chunk
  // is split on newlines rather than passed through with its own inside.
  let pending = "";
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() !== "") {
          await send(line);
        }
      }
    },
    close: () => close(),
    abort: () => close(),
  });

  return { readable, writable, close, feed };
}

/**
 * Attach a transport to one live connection in `acp.rs`.
 *
 * The caller subscribes to `acp://frame` and `acp://close` once and routes by
 * id — one listener for every client, rather than one per connection.
 */
export function connectionTransport(id: number): AcpTransport & { feed: AcpFeed } {
  return createTransport(
    (line) => invoke("acp_send", { id, line }),
    () => invoke("acp_close", { id }),
  );
}
