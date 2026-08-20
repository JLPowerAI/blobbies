import { beforeEach, describe, expect, it, vi } from "vitest";
import { notify, requestNotificationPermission, shouldNotify } from "@/lib/notify";

const isPermissionGranted = vi.fn(async () => false);
const requestPermission = vi.fn(async () => "granted");
const sendNotification = vi.fn();
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => isPermissionGranted(),
  requestPermission: () => requestPermission(),
  sendNotification: (...args: unknown[]) => sendNotification(...args),
}));

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

// Module-level mocks: call history must not leak between tests.
beforeEach(() => {
  vi.clearAllMocks();
});

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
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks through our Rust command, which is the one path that reaches macOS", async () => {
    // The plugin's own request is a desktop stub that always says granted;
    // the real UNUserNotificationCenter call lives behind our command, so
    // that is what Allow must hit.
    const w = window as unknown as { __TAURI_INTERNALS__?: object };
    w.__TAURI_INTERNALS__ = {};
    try {
      invoke.mockResolvedValue("granted");
      expect(await requestNotificationPermission()).toBe("granted");
      expect(invoke).toHaveBeenCalledWith("request_notification_permission");
      expect(requestPermission).not.toHaveBeenCalled();

      invoke.mockResolvedValue("denied");
      expect(await requestNotificationPermission()).toBe("denied");

      invoke.mockRejectedValue(new Error("command missing"));
      expect(await requestNotificationPermission()).toBe("unavailable");
    } finally {
      delete w.__TAURI_INTERNALS__;
    }
  });
});

describe("notify", () => {
  it("stays a no-op outside Tauri", async () => {
    await notify("Blobbies", "hello");
    expect(sendNotification).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends through the Rust command on macOS, never the plugin's deprecated path", async () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: object };
    w.__TAURI_INTERNALS__ = {};
    const agent = Object.getOwnPropertyDescriptor(globalThis.navigator, "userAgent");
    Object.defineProperty(globalThis.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh) Test",
    });
    try {
      invoke.mockResolvedValue(undefined);
      await notify("Blobbies", "  hello  ");
      expect(invoke).toHaveBeenCalledWith("send_notification", {
        title: "Blobbies",
        body: "hello",
      });
      expect(sendNotification).not.toHaveBeenCalled();
    } finally {
      delete w.__TAURI_INTERNALS__;
      if (agent) {
        Object.defineProperty(globalThis.navigator, "userAgent", agent);
      }
    }
  });
});
