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

/** Opens a URL in the system browser. Rejects unless allowed by the capability scope. */
export async function openExternal(url: string): Promise<void> {
  return openUrl(url);
}

/**
 * True when `host` resolves only to public-internet addresses.
 *
 * The HTTP capability scope matches hostname patterns, so it cannot see that a
 * public name points at the local network. Fails closed: outside Tauri, or if
 * the command errors, the host is treated as not public.
 */
export async function hostIsPublic(host: string): Promise<boolean> {
  if (!isTauri()) {
    return false;
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
