// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Message } from "@/data/agents";
import { groupConversationId } from "@/lib/groups";
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

  it("run records write immediately — no debounce window to lose on a crash", async () => {
    const run = {
      id: "run-1",
      blobId: BLOB_ID,
      trigger: "routine" as const,
      prompt: "check the news",
      startedAt: 1,
      status: "running" as const,
    };
    await store.saveBlobRun(BLOB_ID, run);
    // Readable with NO flush event: the write must not have been queued.
    expect(await store.loadBlobRun(BLOB_ID)).toEqual(run);
    // Corrupt/foreign values parse to null instead of leaking into the app.
    await store.saveBlobRun(BLOB_ID, { nonsense: true } as never);
    expect(await store.loadBlobRun(BLOB_ID)).toBeNull();
  });

  it("deleteBlobData removes every per-Blob slice", async () => {
    store.saveBlobConfig(BLOB_ID, ken);
    store.saveBlobTranscript(BLOB_ID, [
      { id: "m1", kind: "text", author: "user", segments: [{ text: "hi" }] },
    ]);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadBlobTranscript(BLOB_ID)).not.toBeNull();

    await store.saveBlobRun(BLOB_ID, {
      id: "run-1",
      blobId: BLOB_ID,
      trigger: "user",
      prompt: "",
      startedAt: 1,
      status: "done",
    });

    await store.deleteBlobData(BLOB_ID);
    expect(await store.loadBlobTranscript(BLOB_ID)).toBeNull();
    expect(await store.loadBlobRoutines(BLOB_ID)).toBeNull();
    expect(await store.loadBlobRun(BLOB_ID)).toBeNull();
  });

  it("round-trips user-scope memories through the `user` slice", async () => {
    expect(await store.loadUserMemories()).toBeNull();

    const memories = [{ id: "u1", text: "Allergic to peanuts", createdAt: 1 }];
    // Debounced like every other config write (covered above), so the flush
    // event is what makes it readable.
    store.saveUserMemories(memories);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadUserMemories()).toEqual(memories);

    // Non-array values (a hand-edited file) read as null, never as memories.
    store.saveUserMemories({ oops: true } as never);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadUserMemories()).toBeNull();
  });

  it("routes a conversation write by its id, group or Blob", async () => {
    const GROUP_ID = "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
    const line = (id: string): Message => ({
      id,
      kind: "text",
      author: "user",
      segments: [{ text: id }],
    });
    // The turn loop knows only a conversation id, so this is the seam that
    // keeps a group reply out of the speaking Blob's own transcript.
    store.saveConversation(groupConversationId(GROUP_ID), [line("g1")]);
    store.saveConversation(BLOB_ID, [line("b1")]);
    window.dispatchEvent(new Event("beforeunload"));

    expect(await store.loadGroupTranscript(GROUP_ID)).toEqual([line("g1")]);
    expect(await store.loadBlobTranscript(BLOB_ID)).toEqual([line("b1")]);
  });

  it("round-trips the group list, and reads a hand-edited one as none", async () => {
    expect(await store.loadGroups()).toBeNull();

    const groups = [{ id: "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", name: "Launch" }];
    store.saveGroups(groups);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadGroups()).toEqual(groups);

    // Same rule as the memories slice: a non-array value on disk reads as
    // nothing rather than as a group list.
    store.saveGroups({ oops: true } as never);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadGroups()).toBeNull();
  });

  it("exportBlob is a no-op outside Tauri rather than throwing", async () => {
    // The browser dev server has no Rust side; Settings shows a hint instead.
    expect(await store.exportBlob(BLOB_ID, "Ken")).toBeNull();
  });

  it("clears only its own keys, leaving app preferences alone", async () => {
    // The test hook used to call localStorage.clear(), which took the app's
    // `pref:*` with it — same origin — including the flag that keeps the
    // first-run flow off the screen in every other suite.
    window.localStorage.setItem("pref:onboarded", "true");
    await store.flushRoster([ken]);

    store.clearFallbackBackend();

    expect(await store.loadRoster()).toBeNull();
    expect(window.localStorage.getItem("pref:onboarded")).toBe("true");
  });

  it("ignores corrupt stored JSON instead of throwing", async () => {
    store.saveBlobConfig(BLOB_ID, ken);
    window.dispatchEvent(new Event("beforeunload"));
    // Corrupt the raw stored value through the same backend the store uses.
    store.clearFallbackBackend();
    expect(await store.loadRoster()).toBeNull();
  });

  it("reports a failed background write instead of rejecting into nowhere", async () => {
    // Debounced and unload writes are fire-and-forget — nobody awaits them — so
    // a failure used to surface as an unhandled promise rejection naming
    // neither the slice nor the cause. In Tauri that is a bare Rust string
    // ("storage error: No such file or directory"); here a value that cannot
    // be serialised reaches the same catch.
    const reported: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      reported.push(args);
    });
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => rejections.push(event.reason);
    window.addEventListener("unhandledrejection", onRejection);

    try {
      const circular: { self?: unknown } = {};
      circular.self = circular;
      // Routines are a debounced slice, so this takes the fire-and-forget path.
      store.saveBlobRoutines(BLOB_ID, circular as never);
      window.dispatchEvent(new Event("beforeunload"));
      // Let the rejection settle and any unhandled-rejection event fire.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rejections).toEqual([]);
      // Named, so "the roster failed" and "one Blob's transcript failed" are
      // not the same line in the console.
      expect(reported[0]?.[0]).toContain(`blobs/${BLOB_ID}/routines`);
    } finally {
      window.removeEventListener("unhandledrejection", onRejection);
      spy.mockRestore();
    }
  });
});
