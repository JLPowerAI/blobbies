/**
 * MCP server config types and the URL allowlist validator.
 *
 * Lives in this zod-free leaf (the `memory.ts` pattern) so the UI can import
 * them without dragging `mcp.ts` — and through it zod and blob-tools — into
 * the startup chunk (`scripts/bundle-budget.mjs`). `mcp.ts` re-exports
 * everything here; existing imports keep working.
 */
export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface McpTool {
  /** Server-supplied name, used on the wire. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Hosts that are unambiguously this machine *and* that the Tauri capability
 * actually allows (the two loopback globs under `http:default`).
 *
 * `::1` is absent deliberately: no allow entry covers it, and Tauri denies
 * anything unmatched — accepting it here would mean saving a connection that
 * fails at request time with an opaque scope error.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Is this a URL we are willing to talk MCP to?
 *
 * Allowlist, not a denylist: exactly http on an exact loopback host with an
 * explicit port — every rule mirroring what the Tauri capability permits, so
 * a connection the UI accepts is one that can actually send a request. A
 * name that merely contains "localhost" (`localhost.attacker.com`,
 * `mylocalhost.io`) resolves wherever its owner points it, so only the whole
 * host counts. `0.0.0.0` is refused too — it is a bind-all address, not a
 * destination, and its meaning as a target varies by platform.
 *
 * Returns the normalized URL, or null with a reason the UI can show.
 */
export function parseLoopbackUrl(raw: string): { url: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { error: "That is not a valid URL." };
  }
  // http only, and this is not an oversight. `capabilities/default.json`
  // *denies* `https://localhost` and `https://127.*.*.*` to stop the web
  // tools reaching local services, and deny beats allow in Tauri's scope
  // (verified: `denied_takes_precedence` in the plugin). Accepting https here
  // would save a connection that can never send a request. Widening that deny
  // list to make https loopback work would reopen the hole it exists to close.
  if (parsed.protocol !== "http:") {
    return { error: "Only http:// URLs on this machine are supported." };
  }
  // URL lowercases the host and keeps IPv6 brackets, so an exact-set check is
  // safe here; case tricks and trailing dots are handled by the parser.
  const host = parsed.hostname.replace(/\.$/, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    return {
      error: "Only servers on this machine are supported (localhost or 127.0.0.1).",
    };
  }
  // Credentials in the URL would be sent on every request; drop them loudly
  // rather than quietly storing a secret in the settings JSON.
  if (parsed.username !== "" || parsed.password !== "") {
    return { error: "Remove the username/password from the URL." };
  }
  // The capability globs carry `:*`, which does not match a URL with no port.
  // Requiring one keeps this validator and the capability in exact agreement.
  if (parsed.port === "") {
    return { error: "Include the port, e.g. http://127.0.0.1:3000/mcp." };
  }
  return { url: parsed.toString() };
}
