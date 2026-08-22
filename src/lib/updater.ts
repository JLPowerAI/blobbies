import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/tauri";

/**
 * In-app updater, wired to this repo's GitHub Releases.
 *
 * One module-level store (subscribe + useSyncExternalStore) instead of props:
 * the Sidebar badge, the Settings → Updates tab, and the background auto-check
 * all observe the same flow without App threading state through both trees.
 * The plugin's `Update` object is a class instance with live methods, so it
 * lives in a module variable rather than in the serializable state.
 *
 * Flow: check → available ("New Update Available") → download (percent) →
 * ready ("Install and Restart") → the plugin swaps the binary and relaunches.
 * Outside the Tauri webview (pnpm dev in a browser, tests) the real path is a
 * no-op and `simulateUpdate` drives the identical state machine for visuals.
 */

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date"; checkedAt: number }
  | { phase: "available"; version: string; currentVersion: string }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "ready"; version: string }
  | { phase: "installing"; version: string }
  | { phase: "failed"; message: string };

let state: UpdateState = { phase: "idle" };
const listeners = new Set<() => void>();

function setState(next: UpdateState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The single updater state, for `useSyncExternalStore`. */
export function getUpdateState(): UpdateState {
  return state;
}

/** React hook: the updater state. Re-renders on every transition. */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, getUpdateState);
}

/** Held between `available` and `download`: the live plugin handle. */
let pending: UpdateHandle | null = null;

/** What the plugin's Update object needs to look like (kept structural for tests).
 *  Mirrors @tauri-apps/plugin-updater's real shape: one onEvent callback
 *  carrying a Started(contentLength?) → Progress(chunkLength) → Finished
 *  union, exactly as the .d.ts declares it. */
interface UpdateHandle {
  readonly version: string;
  readonly currentVersion: string;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
}

/** Event union from @tauri-apps/plugin-updater. */
type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** Overridable in tests; the real plugin is imported lazily so a plain
 *  browser/vitest environment never loads the Tauri IPC layer. */
export const updaterTransport = {
  async check(): Promise<UpdateHandle | null> {
    const { check } = await import("@tauri-apps/plugin-updater");
    return check();
  },
  async relaunch(): Promise<void> {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
};

/** Accumulated bytes of the current download, plus the total once the server
 *  announces it, so percent can be computed per Progress event (the plugin
 *  reports increments, not running totals). */
let received = 0;
let contentLength = 0;

/**
 * Check GitHub Releases for a newer version.
 *
 * Interactive or background: both land in the same store. "No update" is a
 * normal outcome (`up-to-date`), not an error — the sidebar badge simply
 * never appears. Failures set `failed` but never throw: a background check
 * must not take the app down with it.
 */
export async function checkForUpdates(): Promise<void> {
  if (!isTauri()) return;
  if (state.phase === "checking" || state.phase === "downloading" || state.phase === "installing") {
    return;
  }
  setState({ phase: "checking" });
  try {
    const update = await updaterTransport.check();
    if (update === null) {
      setState({ phase: "up-to-date", checkedAt: Date.now() });
      return;
    }
    pending = update;
    setState({
      phase: "available",
      version: update.version,
      currentVersion: update.currentVersion,
    });
  } catch (error) {
    setState({
      phase: "failed",
      message: error instanceof Error ? error.message : "Could not check for updates.",
    });
  }
}

/**
 * Download the pending update, reporting percent (0–100, rounded).
 *
 * `contentLength` is absent when the server answers chunked without a total;
 * the bar then shows an indeterminate shimmer at a fixed low percent rather
 * than a liar's 100%.
 */
export async function downloadUpdate(): Promise<void> {
  const handle = pending;
  if (handle === null || (state.phase !== "available" && state.phase !== "failed")) return;
  received = 0;
  contentLength = 0;
  setState({ phase: "downloading", version: handle.version, percent: 0 });
  try {
    await handle.downloadAndInstall((event) => {
      if (event.event === "Started") {
        contentLength = event.data.contentLength ?? 0;
        return;
      }
      if (event.event === "Finished") return;
      received += event.data.chunkLength;
      const percent =
        contentLength > 0 ? Math.min(99, Math.round((received / contentLength) * 100)) : 5;
      if (state.phase === "downloading") {
        setState({ ...state, percent });
      }
    });
    setState({ phase: "ready", version: handle.version });
  } catch (error) {
    // The handle is kept on purpose: "Update failed — retry" re-runs this
    // function against the same plugin object. Nulling it here made the
    // retry a silent no-op.
    setState({
      phase: "failed",
      message: error instanceof Error ? error.message : "The download did not finish.",
    });
  }
}

/**
 * Install the downloaded update and restart the app.
 *
 * The plugin replaces the app and relaunches it; if installing itself throws
 * (disk full, permissions), the state says so instead of vanishing silently.
 */
export async function installAndRestart(): Promise<void> {
  if (state.phase !== "ready") return;
  const { version } = state;
  setState({ phase: "installing", version });
  try {
    await updaterTransport.relaunch();
    // Relaunch should end the process; if it somehow returns, do not strand
    // the UI in "installing" forever.
    setState({ phase: "idle" });
  } catch (error) {
    setState({
      phase: "failed",
      message: error instanceof Error ? error.message : "The update could not be installed.",
    });
  }
}

/**
 * Click handler for both update controls: whatever the current phase needs
 * next. The sidebar badge and the Settings button are one control each, from
 * check through green pill to restart, and they share this state, so starting
 * a download in one shows progress in the other.
 */
export function updateClickAction(): void {
  const s = state;
  if (s.phase === "available") {
    void downloadUpdate();
  } else if (s.phase === "failed") {
    // Two failure origins, two retries: a broken download keeps its handle
    // (re-download), a failed check has none (re-check).
    if (pending !== null) {
      void downloadUpdate();
    } else {
      void checkForUpdates();
    }
  } else if (s.phase === "ready") {
    void installAndRestart();
  } else if (s.phase === "idle" || s.phase === "up-to-date") {
    void checkForUpdates();
  }
}

/** Label for an update control at each phase. Shared, so the sidebar card and
 *  the Settings button can never drift apart on wording. */
export function updateActionLabel(phase: UpdateState["phase"], percent: number): string {
  switch (phase) {
    case "checking":
      return "Checking…";
    case "available":
      return "Download now";
    case "downloading":
      return `Downloading… ${percent}%`;
    case "ready":
      return "Install and Restart now";
    case "installing":
      return "Installing…";
    case "failed":
      return "Retry";
    default:
      return "Check for Updates";
  }
}

/** How often the background check repeats. Four hours: often enough to catch
 *  a release within a work session, rare enough to stay invisible. */
const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let autoCheckStarted = false;

/**
 * Start the background auto-check (now, then every few hours).
 *
 * Called once from main.tsx; guarded so StrictMode's double-mount and any
 * future second call stay a single interval. No-op outside Tauri.
 */
export function initAutoUpdate(): void {
  if (autoCheckStarted || !isTauri()) return;
  autoCheckStarted = true;
  void checkForUpdates();
  window.setInterval(() => void checkForUpdates(), AUTO_CHECK_INTERVAL_MS);
}

/** Dev-only: drive the real state machine with a fake update, for visual work. */
export async function simulateUpdate(): Promise<void> {
  setState({ phase: "available", version: "9.9.9", currentVersion: "0.1.0" });
  received = 0;
  setState({ phase: "downloading", version: "9.9.9", percent: 0 });
  for (let percent = 0; percent <= 100; percent += 5) {
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    if (state.phase !== "downloading") return; // user navigated away / reset
    setState({ phase: "downloading", version: "9.9.9", percent });
  }
  setState({ phase: "ready", version: "9.9.9" });
}

/** Test/dev helper: back to idle. */
export function resetUpdateState(): void {
  pending = null;
  received = 0;
  contentLength = 0;
  setState({ phase: "idle" });
}
