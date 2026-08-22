import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauri } from "@/lib/tauri";

/**
 * The one outbound POST helper for servers we do not control.
 *
 * `maxRedirections: 0` is load-bearing, not tidiness. The Rust plugin checks
 * the capability scope against the *initial* URL only and then lets reqwest
 * follow redirects, so a server answering 302 with a public `Location` would
 * carry the request — headers, credentials and tool arguments alike —
 * straight off the intended host. `redirect: "error"` covers the browser
 * fallback, which ignores `maxRedirections`.
 *
 * Shared by the MCP client and the Composio transport: both talk to servers
 * whose replies are attacker-controlled in the threat model, and having one
 * copy means the protection cannot be present in one and missing in the
 * other. In a plain browser (dev server, tests) the plugin IPC is absent, so
 * this falls back to `fetch`.
 */
export function httpFetch(url: string, init: RequestInit): Promise<Response> {
  const bounded = { ...init, redirect: "error" as const, maxRedirections: 0 };
  return isTauri() ? tauriFetch(url, bounded) : fetch(url, bounded);
}
