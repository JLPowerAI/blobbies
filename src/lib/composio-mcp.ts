/**
 * Composio over MCP: one transport, every platform.
 *
 * This replaces the `composio` CLI. That binary ships for macOS and Linux
 * only — no Windows build exists, and their installer stops with "Windows is
 * not supported" — and because every plugin action shelled out to it, the
 * entire 942-app surface was dead on Windows rather than merely awkward. A
 * hosted MCP endpoint has no binary to install, so the same code path works
 * everywhere, and Composio maintains the tool surface instead of us tracking
 * an 80MB dependency and its installer.
 *
 * **The endpoint is pinned here, not configurable.** `mcp-config.ts` refuses
 * anything but loopback for user-added servers, and that stays true: a person
 * still cannot point Blobbies at an arbitrary remote MCP server. This module
 * is a constant we chose, reviewed in public, in one place — the trust
 * boundary widens by exactly one known vendor rather than by "any URL".
 *
 * **Composio's own meta-tools are not exposed to Blobs.** Their catalog
 * includes `COMPOSIO_REMOTE_BASH_TOOL` and `COMPOSIO_REMOTE_WORKBENCH`, which
 * run code in *their* sandbox against uploaded files. Handing those to a Blob
 * would push user data off the machine for processing, which is the exact
 * thing this app exists to avoid. `blob-tools.ts` keeps its own three tools
 * (`app_find_tool`, `app_tool_schema`, `app_run_tool`) as the façade, and the
 * allowlist below is what any of them may reach.
 */

import { httpFetch } from "@/lib/http";
import { getSecret } from "@/lib/secrets";

/** Composio Connect: their shared hosted MCP server. */
export const COMPOSIO_MCP_URL = "https://connect.composio.dev/mcp";

/** Where a user creates the key this module authenticates with. */
export const COMPOSIO_DASHBOARD_URL = "https://platform.composio.dev/developers";

/**
 * The MCP protocol revision this client speaks, echoed on every request.
 * Matches `mcp.ts`, so the two clients cannot drift apart.
 */
const PROTOCOL_VERSION = "2025-06-18";

/**
 * Composio meta-tools this app is willing to call.
 *
 * Default-deny, and the omissions are the point: `COMPOSIO_REMOTE_BASH_TOOL`
 * and `COMPOSIO_REMOTE_WORKBENCH` execute code in Composio's cloud sandbox,
 * so they are absent and stay absent. If Composio adds a tool later, it is
 * unreachable until someone adds it here on purpose.
 */
const ALLOWED_TOOLS = new Set([
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
]);

/** A wedged server must not hold a chat turn or a routine open forever. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Response ceiling: a hostile or broken server could otherwise stream on. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Failure already phrased for a person, or for a model to act on. */
export class ComposioError extends Error {}

/** The negotiated session id, reused until the server forgets it. */
let sessionId: string | null = null;

/** In-flight handshake, so a burst of tool calls performs exactly one. */
let handshake: Promise<string> | null = null;

let nextRequestId = 1;

/** Drop the session, so the next call re-handshakes. Used after auth changes. */
export function forgetComposioSession(): void {
  sessionId = null;
  handshake = null;
}

/**
 * The credential, from the OS keychain.
 *
 * Returned per call rather than cached in a module variable: a key changed in
 * Settings must take effect on the next request, and holding a second copy in
 * memory earns nothing the keychain does not already do.
 */
async function apiKey(): Promise<string> {
  const key = (await getSecret("composio-api-key")) ?? "";
  if (key.trim() === "") {
    throw new ComposioError(
      "No Composio key yet. Open Settings \u2192 Plugins and connect your account.",
    );
  }
  return key.trim();
}

/**
 * Read a body, giving up past the ceiling.
 *
 * `response.text()` buffers everything before any cap could apply, so a
 * server that streams without end would take the app's memory with it.
 */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return (await response.text()).slice(0, MAX_RESPONSE_BYTES);
  }
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text.slice(0, MAX_RESPONSE_BYTES);
}

/**
 * Pull the JSON-RPC envelope out of a response body.
 *
 * The transport allows two shapes and Composio uses the second: a plain JSON
 * body, or an SSE stream whose `data:` line carries the payload. Reading only
 * JSON would work in a test and fail against the real server.
 */
function parseEnvelope(body: string): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as Record<string, unknown>;
  }
  // Last data: line wins — a stream may carry progress notifications first.
  const lines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  const last = lines.at(-1);
  if (last === undefined) {
    throw new ComposioError("Composio sent a response this app could not read.");
  }
  return JSON.parse(last) as Record<string, unknown>;
}

/** One JSON-RPC round trip to the pinned endpoint. */
async function rpc(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const key = await apiKey();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await httpFetch(COMPOSIO_MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "x-consumer-api-key": key,
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextRequestId++, method, params }),
      // `httpFetch` refuses redirects for us — load-bearing here, because a 302
      // off this host would carry the API key with it.
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
  } catch (error) {
    throw new ComposioError(
      error instanceof Error && error.name === "TimeoutError"
        ? "Composio did not answer in time."
        : "Could not reach Composio. Check your connection.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new ComposioError(
      "Composio rejected the key. Open Settings \u2192 Plugins and reconnect.",
    );
  }
  if (!response.ok) {
    throw new ComposioError(`Composio answered ${response.status}.`);
  }

  // The server picks the session id on initialize and expects it echoed back.
  const issued = response.headers.get("mcp-session-id");
  if (issued !== null && /^[\x20-\x7e]{1,200}$/.test(issued)) {
    sessionId = issued;
  }

  const envelope = parseEnvelope(await readCapped(response));
  const failure = envelope.error as { message?: unknown } | undefined;
  if (failure !== undefined) {
    throw new ComposioError(
      typeof failure.message === "string" ? failure.message : "Composio reported an error.",
    );
  }
  return envelope.result;
}

/**
 * Ensure a live session, handshaking at most once for a burst of callers.
 *
 * Three tool calls firing together at the start of a turn would otherwise
 * open three sessions and keep the last, leaking the other two.
 */
async function ready(signal?: AbortSignal): Promise<string> {
  if (sessionId !== null) {
    return sessionId;
  }
  handshake ??= (async () => {
    await rpc(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "blobbies", version: "0.1.8" },
      },
      signal,
    );
    if (sessionId === null) {
      throw new ComposioError("Composio did not open a session.");
    }
    return sessionId;
  })().finally(() => {
    handshake = null;
  });
  return handshake;
}

/**
 * Call one allowlisted Composio tool and return its text content.
 *
 * A dropped session is retried once: the server expires them, and a Blob
 * mid-task should not surface that as a failure the user has to act on.
 */
export async function callComposioTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (!ALLOWED_TOOLS.has(name)) {
    throw new ComposioError(`\`${name}\` is not a tool this app calls.`);
  }
  const invoke = async (): Promise<unknown> => {
    await ready(signal);
    return rpc("tools/call", { name, arguments: args }, signal);
  };
  let result: unknown;
  try {
    result = await invoke();
  } catch (error) {
    // Only a session problem is worth a second attempt; a bad key or a
    // rejected argument would fail again identically.
    if (error instanceof ComposioError && /session/i.test(error.message)) {
      forgetComposioSession();
      result = await invoke();
    } else {
      throw error;
    }
  }

  const content = (result as { content?: { type?: string; text?: string }[] } | null)?.content;
  if (!Array.isArray(content)) {
    return typeof result === "string" ? result : JSON.stringify(result ?? {});
  }
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Whether the stored key actually works, as a login check.
 *
 * Runs a real handshake rather than checking that a key is present: a revoked
 * or mistyped key is indistinguishable from a good one until it is used, and
 * "connected" is the one thing the Plugins tab must not get wrong.
 */
export async function composioReachable(signal?: AbortSignal): Promise<boolean> {
  try {
    await ready(signal);
    return true;
  } catch {
    return false;
  }
}
