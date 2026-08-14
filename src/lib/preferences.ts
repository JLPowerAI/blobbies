/** localStorage-backed preferences that degrade to defaults when unavailable. */

export function readPreference(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preferences simply don't persist when storage is unavailable.
  }
}
