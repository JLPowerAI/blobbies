import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";

/**
 * Secrets live in the OS keychain (Rust `secrets.rs`, name-allowlisted) —
 * never in the JSON slice store, never in logs. In a plain browser (dev
 * server, jsdom tests) they fall back to localStorage, dev-only.
 */

/** Must match ALLOWED_NAMES in src-tauri/src/secrets.rs. */
export type SecretName =
  | "tinfoil-api-key"
  | "tinfoil-cache-secret"
  | "composio-api-key"
  /** OAuth session for Composio, stored as JSON. Preferred over the key. */
  | "composio-oauth";

export async function getSecret(name: SecretName): Promise<string | null> {
  if (isTauri()) {
    return invoke<string | null>("secret_get", { name });
  }
  try {
    return window.localStorage.getItem(`secret:${name}`);
  } catch {
    return null;
  }
}

export async function setSecret(name: SecretName, value: string): Promise<void> {
  if (isTauri()) {
    await invoke("secret_set", { name, value });
    return;
  }
  try {
    window.localStorage.setItem(`secret:${name}`, value);
  } catch {
    // jsdom without localStorage: nothing to persist to in tests
  }
}

export async function deleteSecret(name: SecretName): Promise<void> {
  if (isTauri()) {
    await invoke("secret_delete", { name });
    return;
  }
  try {
    window.localStorage.removeItem(`secret:${name}`);
  } catch {
    // jsdom without localStorage: nothing to remove
  }
}
