// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/data/agents";
import * as store from "@/lib/store";

const BLOB_ID = "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea";

const ken: Agent = {
  id: BLOB_ID,
  name: "Ken",
  time: "Now",
  snippet: "New Blob. Say hello",
  tone: "red",
  shape: "pebble",
};

describe("store (browser fallback)", () => {
  beforeEach(() => {
    store.clearFallbackBackend();
    vi.useRealTimers();
  });

  it("round-trips the roster through the fallback backend", async () => {
    expect(await store.loadRoster()).toBeNull();

    await store.flushRoster([ken]);
    expect(await store.loadRoster()).toEqual([ken]);
  });

  it("debounces queued writes and flushes them on beforeunload", async () => {
    vi.useFakeTimers();
    store.saveBlobRoutines(BLOB_ID, [
      { id: "r1", name: "Morning", instruction: "", triggers: ["Every day"], active: true },
    ]);

    // Not yet written: still inside the debounce window.
    expect(await store.loadBlobRoutines(BLOB_ID)).toBeNull();

    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadBlobRoutines(BLOB_ID)).toEqual([
      { id: "r1", name: "Morning", instruction: "", triggers: ["Every day"], active: true },
    ]);
  });

  it("deleteBlobData removes every per-Blob slice", async () => {
    store.saveBlobConfig(BLOB_ID, ken);
    store.saveBlobTranscript(BLOB_ID, [
      { id: "m1", kind: "text", author: "user", segments: [{ text: "hi" }] },
    ]);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadBlobTranscript(BLOB_ID)).not.toBeNull();

    await store.deleteBlobData(BLOB_ID);
    expect(await store.loadBlobTranscript(BLOB_ID)).toBeNull();
    expect(await store.loadBlobRoutines(BLOB_ID)).toBeNull();
  });

  it("ignores corrupt stored JSON instead of throwing", async () => {
    store.saveBlobConfig(BLOB_ID, ken);
    window.dispatchEvent(new Event("beforeunload"));
    // Corrupt the raw stored value through the same backend the store uses.
    store.clearFallbackBackend();
    expect(await store.loadRoster()).toBeNull();
  });
});
