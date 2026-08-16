import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
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
 * Show one notification, asking for OS permission the first time.
 *
 * Permission is requested lazily, never at boot: an OS prompt the user did
 * not earn by acting is the same mistake as the keychain probe. Failures are
 * swallowed — a missing notification must never break a run.
 */
export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri()) {
    return;
  }
  try {
    if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") {
      return;
    }
    sendNotification({ title, body: body.trim().slice(0, BODY_LIMIT) });
  } catch {
    // No notification centre, or the user denied it. Nothing to do.
  }
}
