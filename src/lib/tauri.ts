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
 * True when running inside the Tauri webview (native window chrome present),
 * false in a plain browser during `pnpm dev`.
 */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
