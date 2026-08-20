import { sendNotification } from "@tauri-apps/plugin-notification";
import type { RunStatus, RunTrigger } from "@/lib/run-state";
import { isTauri } from "@/lib/tauri";

/** Keep the body a glance, not a transcript — the OS truncates anyway. */
const BODY_LIMIT = 100;

/**
 * Should this settled run interrupt the user with an OS notification?
 *
 * Pure so the policy is testable without the plugin: the rules are the whole
 * feature, and every one of them is a way of not being annoying.
 */
export function shouldNotify(event: {
  trigger: RunTrigger;
  status: RunStatus;
  /** False when the app is in the background or another window has focus. */
  windowFocused: boolean;
  /** The Blob's `notifications` setting; undefined means the default (on). */
  blobOptedIn?: boolean | undefined;
}): boolean {
  // Off for this Blob wins over everything else.
  if (event.blobOptedIn === false) {
    return false;
  }
  // The user is looking at the reply as it arrives; a banner adds nothing.
  if (event.windowFocused) {
    return false;
  }
  // A run the user started by typing is one they are waiting on in-app.
  // Routine fires and answers to earlier asks are the background work worth
  // surfacing.
  if (event.trigger === "user") {
    return false;
  }
  // waiting_input blocks the run until the user acts, so it always earns one.
  return event.status === "waiting_input" || event.status === "done" || event.status === "failed";
}

/**
 * Ask the OS for notification permission, on the user's say-so.
 *
 * The only caller is onboarding's Allow button: a prompt nobody asked for is
 * the mistake `notify` avoids by requesting lazily, and a click on Allow is
 * exactly that ask. Never call this on mount.
 *
 * Goes through our own Rust command rather than the plugin's request: the
 * plugin's desktop permission calls are hardcoded to "granted" and never
 * reach UNUserNotificationCenter, so macOS never shows the prompt, never
 * lists the app in System Settings, and drops every notification it sends.
 */
export async function requestNotificationPermission(): Promise<
  "granted" | "denied" | "unavailable"
> {
  if (!isTauri()) {
    return "unavailable";
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<"granted" | "denied">("request_notification_permission");
  } catch {
    // The command is missing or the OS refused to answer.
    return "unavailable";
  }
}

/**
 * Show one notification. Failures are swallowed — a missing notification
 * must never break a run.
 *
 * macOS sends through our own Rust command: the plugin's desktop send path
 * rides notify-rust's default backend, the deprecated `NSUserNotification`
 * API, which modern macOS silently drops even for authorized apps. The OS
 * permission ask itself belongs to onboarding's Allow
 * (see requestNotificationPermission), never to a background send.
 *
 * The chime is macOS-only (installed to ~/Library/Sounds by our permission
 * command); other platforms get the OS default through the plugin.
 */
export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri()) {
    return;
  }
  try {
    const onMac = navigator.userAgent.includes("Macintosh");
    if (onMac) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("send_notification", {
        title,
        body: body.trim().slice(0, BODY_LIMIT),
      });
      return;
    }
    sendNotification({ title, body: body.trim().slice(0, BODY_LIMIT) });
  } catch {
    // No notification centre, or the user denied it. Nothing to do.
  }
}
