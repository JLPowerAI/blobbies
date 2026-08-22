import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installAndRestart,
  resetUpdateState,
  simulateUpdate,
  updateActionLabel,
  updateClickAction,
  updaterTransport,
} from "@/lib/updater";

// The store no-ops outside the Tauri webview; the tests drive the real
// machine, so the guard must answer true.
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));

/** A fake plugin Update: captures the event callback and stays pending until
 *  the test signals Finished — mirroring how a real download behaves. */
function fakeHandle() {
  let onEvent: ((event: unknown) => void) | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handle = {
    version: "0.2.0",
    currentVersion: "0.1.0",
    downloadAndInstall: vi.fn((callback?: (event: unknown) => void) => {
      onEvent = callback;
      return done;
    }),
  };
  return {
    handle,
    emit: (event: unknown) => onEvent?.(event),
    finish,
  };
}

afterEach(() => {
  resetUpdateState();
  vi.restoreAllMocks();
});

describe("checkForUpdates", () => {
  it("lands on up-to-date when the endpoint has nothing newer", async () => {
    vi.spyOn(updaterTransport, "check").mockResolvedValue(null);
    await checkForUpdates();
    const { getUpdateState } = await import("@/lib/updater");
    expect(getUpdateState()).toEqual({ phase: "up-to-date", checkedAt: expect.any(Number) });
  });

  it("announces the found version with the current one alongside", async () => {
    const { handle } = fakeHandle();
    vi.spyOn(updaterTransport, "check").mockResolvedValue(handle);
    await checkForUpdates();
    const { getUpdateState } = await import("@/lib/updater");
    expect(getUpdateState()).toEqual({
      phase: "available",
      version: "0.2.0",
      currentVersion: "0.1.0",
    });
  });

  it("fails closed with a message instead of throwing", async () => {
    vi.spyOn(updaterTransport, "check").mockRejectedValue(new Error("offline"));
    await expect(checkForUpdates()).resolves.toBeUndefined();
    const { getUpdateState } = await import("@/lib/updater");
    expect(getUpdateState()).toEqual({ phase: "failed", message: "offline" });
  });
});

describe("downloadUpdate", () => {
  it("tracks percent from Started + Progress events", async () => {
    const { handle, emit, finish } = fakeHandle();
    vi.spyOn(updaterTransport, "check").mockResolvedValue(handle);
    const { getUpdateState } = await import("@/lib/updater");
    await checkForUpdates();

    const downloading = downloadUpdate();
    emit({ event: "Started", data: { contentLength: 200 } });
    emit({ event: "Progress", data: { chunkLength: 50 } });
    expect(getUpdateState()).toMatchObject({ phase: "downloading", percent: 25 });
    emit({ event: "Progress", data: { chunkLength: 100 } });
    expect(getUpdateState()).toMatchObject({ phase: "downloading", percent: 75 });
    emit({ event: "Finished" });
    finish();
    await downloading;
    expect(getUpdateState()).toEqual({ phase: "ready", version: "0.2.0" });
  });

  it("never reports 100 before Finished: the bar must not finish early", async () => {
    const { handle, emit, finish } = fakeHandle();
    vi.spyOn(updaterTransport, "check").mockResolvedValue(handle);
    const { getUpdateState } = await import("@/lib/updater");
    await checkForUpdates();

    const downloading = downloadUpdate();
    emit({ event: "Started", data: { contentLength: 100 } });
    emit({ event: "Progress", data: { chunkLength: 100 } });
    expect(getUpdateState()).toMatchObject({ phase: "downloading", percent: 99 });
    finish();
    await downloading;
  });

  it("survives a server that never announces a total", async () => {
    const { handle, emit, finish } = fakeHandle();
    vi.spyOn(updaterTransport, "check").mockResolvedValue(handle);
    const { getUpdateState } = await import("@/lib/updater");
    await checkForUpdates();

    const downloading = downloadUpdate();
    emit({ event: "Started", data: {} });
    emit({ event: "Progress", data: { chunkLength: 12345 } });
    expect(getUpdateState()).toMatchObject({ phase: "downloading", percent: 5 });
    finish();
    await downloading;
    expect(getUpdateState()).toEqual({ phase: "ready", version: "0.2.0" });
  });

  it("reports a failed download instead of hanging on downloading", async () => {
    const { handle } = fakeHandle();
    handle.downloadAndInstall.mockRejectedValue(new Error("network dropped"));
    vi.spyOn(updaterTransport, "check").mockResolvedValue(handle);
    const { getUpdateState } = await import("@/lib/updater");
    await checkForUpdates();

    await downloadUpdate();
    expect(getUpdateState()).toEqual({ phase: "failed", message: "network dropped" });
  });

  it("retries after a failed download: the handle is kept and the second attempt lands on ready", async () => {
    const { handle, emit, finish } = fakeHandle();
    handle.downloadAndInstall.mockRejectedValueOnce(new Error("network dropped"));
    vi.spyOn(updaterTransport, "check").mockResolvedValue(handle);
    const { getUpdateState } = await import("@/lib/updater");
    await checkForUpdates();

    await downloadUpdate();
    expect(getUpdateState()).toMatchObject({ phase: "failed" });

    const retrying = downloadUpdate();
    emit({ event: "Started", data: { contentLength: 100 } });
    emit({ event: "Progress", data: { chunkLength: 100 } });
    finish();
    await retrying;
    expect(getUpdateState()).toEqual({ phase: "ready", version: "0.2.0" });
  });
});

describe("installAndRestart", () => {
  it("installs via relaunch once the download is ready", async () => {
    const relaunch = vi.spyOn(updaterTransport, "relaunch").mockResolvedValue();
    const { handle, emit, finish } = fakeHandle();
    vi.spyOn(updaterTransport, "check").mockResolvedValue(handle);
    const { getUpdateState } = await import("@/lib/updater");
    await checkForUpdates();
    const downloading = downloadUpdate();
    emit({ event: "Started", data: {} });
    finish();
    await downloading;

    await installAndRestart();
    expect(relaunch).toHaveBeenCalledOnce();
    expect(getUpdateState().phase).toBe("idle");
  });

  it("does nothing unless a download is ready", async () => {
    const relaunch = vi.spyOn(updaterTransport, "relaunch").mockResolvedValue();
    await installAndRestart();
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe("simulateUpdate (dev visuals)", () => {
  it("walks the same machine to ready", async () => {
    vi.useFakeTimers();
    const { getUpdateState } = await import("@/lib/updater");
    const flow = simulateUpdate();
    // Let the timeouts run; the loop must reach ready at 100%.
    await vi.advanceTimersByTimeAsync(60 * 25);
    await flow;
    expect(getUpdateState()).toEqual({ phase: "ready", version: "9.9.9" });
    vi.useRealTimers();
  });
});

describe("updateClickAction (shared by the sidebar card and Settings)", () => {
  it("checks from idle, so the Settings button is not a dead end", async () => {
    // Regression: the Settings button used to call checkForUpdates directly and
    // then stop, leaving the only way to actually download an update in the
    // sidebar. Both controls now run this one action.
    const check = vi.spyOn(updaterTransport, "check").mockResolvedValue(null);
    updateClickAction();
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
  });

  it("downloads when an update is already available", async () => {
    const { handle } = fakeHandle();
    vi.spyOn(updaterTransport, "check").mockResolvedValue(
      handle as unknown as Awaited<ReturnType<typeof updaterTransport.check>>,
    );
    await checkForUpdates();
    expect(getUpdateState().phase).toBe("available");

    // Second press is Download, not another check.
    updateClickAction();
    await vi.waitFor(() => expect(handle.downloadAndInstall).toHaveBeenCalledOnce());
  });
});

describe("updateActionLabel", () => {
  it("names the next action at every phase", () => {
    expect(updateActionLabel("idle", 0)).toBe("Check for Updates");
    expect(updateActionLabel("up-to-date", 0)).toBe("Check for Updates");
    expect(updateActionLabel("available", 0)).toBe("Download now");
    expect(updateActionLabel("downloading", 42)).toBe("Downloading… 42%");
    expect(updateActionLabel("ready", 0)).toBe("Install and Restart now");
  });
});
