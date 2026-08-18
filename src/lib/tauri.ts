import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Typed wrappers around the Rust/plugin surface.
 *
 * Keep every `invoke` call in this module: it is the single place where the
 * untyped IPC boundary is given a type, so a renamed or removed Rust command
 * fails in one file instead of leaking `unknown` through the UI.
 */
export async function greet(name: string): Promise<string> {
  return invoke<string>("greet", { name });
}

/**
 * Opens a URL in the system browser.
 *
 * Scoped by *scheme*, not host. Most links reaching here come from agent
 * markdown, which is remote text citing arbitrary sites — a host allowlist
 * could only ever be an incomplete list of dead links. The boundary that
 * matters is that `javascript:`, `file:` and custom app schemes act on this
 * machine when handed to the system opener, while http(s) can only open a
 * browser. The capability scope enforces the same rule; this half fails with
 * a reason the caller can show instead of an opaque refusal.
 */
export async function openExternal(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That link is not a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only web links can be opened.");
  }
  return openUrl(url);
}

/** Hostnames that always denote this machine or the local network. */
const LOCAL_HOST_PATTERN =
  /^(?:localhost|.*\.local|.*\.internal|0\.0\.0\.0|127(?:\.\d+){3}|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|169\.254(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d+){2}|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*|\[?fe80:.*)$/i;

/**
 * True when `host` resolves only to public-internet addresses.
 *
 * Inside Tauri this resolves the name in Rust, which is the only way to catch
 * a public hostname pointing at the local network. Outside Tauri (dev in a
 * browser, tests) there is no resolver available, so it falls back to a
 * literal check: obvious local names are refused, everything else is allowed
 * so the web tools remain usable in development. The Tauri build is the one
 * that ships, and it keeps the strict behaviour.
 */
export async function hostIsPublic(host: string): Promise<boolean> {
  if (!isTauri()) {
    return !LOCAL_HOST_PATTERN.test(host.trim());
  }
  try {
    return await invoke<boolean>("host_is_public", { host });
  } catch {
    return false;
  }
}

/**
 * True when running inside the Tauri webview (native window chrome present),
 * false in a plain browser during `pnpm dev`.
 */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** What a local command produced. `code` is null when it hit the deadline. */
export interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run one allowlisted program with literal arguments.
 *
 * Returns a string on refusal or failure — the caller shows it to the model,
 * which can then tell the user rather than aborting the turn.
 */
export async function runCommand(program: string, args: string[]): Promise<CommandOutput | string> {
  if (!isTauri()) {
    return "Local commands only run in the desktop app.";
  }
  try {
    return await invoke<CommandOutput>("shell_run", { program, args });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
