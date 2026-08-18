import { describe, expect, it, vi } from "vitest";
import { requestNotificationPermission, shouldNotify } from "@/lib/notify";

const isPermissionGranted = vi.fn(async () => false);
const requestPermission = vi.fn(async () => "granted");
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => isPermissionGranted(),
  requestPermission: () => requestPermission(),
  sendNotification: vi.fn(),
}));

const base = { trigger: "routine" as const, status: "done" as const, windowFocused: false };

describe("shouldNotify", () => {
  it("notifies for background work that finished, failed, or needs the user", () => {
    expect(shouldNotify(base)).toBe(true);
    expect(shouldNotify({ ...base, status: "failed" })).toBe(true);
    // An ask blocks the run until the user answers: the whole point of a ping.
    expect(shouldNotify({ ...base, status: "waiting_input" })).toBe(true);
    expect(shouldNotify({ ...base, trigger: "answer" })).toBe(true);
  });

  it("stays quiet for anything the user is already watching", () => {
    // Typed a message and is waiting on the reply on screen.
    expect(shouldNotify({ ...base, trigger: "user" })).toBe(false);
    expect(shouldNotify({ ...base, windowFocused: true })).toBe(false);
    // Cancelled by the user, so they already know.
    expect(shouldNotify({ ...base, status: "cancelled" })).toBe(false);
    // Mid-run states are not settled yet.
    expect(shouldNotify({ ...base, status: "running" })).toBe(false);
    expect(shouldNotify({ ...base, status: "queued" })).toBe(false);
  });

  it("honours the Blob's own toggle, and defaults it on", () => {
    expect(shouldNotify({ ...base, blobOptedIn: false })).toBe(false);
    // Opted out beats every other reason to notify.
    expect(shouldNotify({ ...base, status: "waiting_input", blobOptedIn: false })).toBe(false);
    expect(shouldNotify({ ...base, blobOptedIn: undefined })).toBe(true);
  });
});

describe("requestNotificationPermission", () => {
  it("never touches the OS outside Tauri", async () => {
    // Onboarding's Allow button calls this in the browser dev server too,
    // where there is no notification centre and nothing to prompt.
    expect(await requestNotificationPermission()).toBe("unavailable");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(isPermissionGranted).not.toHaveBeenCalled();
  });
});
