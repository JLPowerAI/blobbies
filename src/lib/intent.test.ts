import { describe, expect, it, vi } from "vitest";
import type { BlobMemory } from "@/lib/blob-tools";
import { reconcileMemories, routeIntent } from "@/lib/intent";

const base = { model: "qwen3.5:0.8b", memories: [] };

/** Fake an Ollama structured-output reply. */
const reply = (payload: object) =>
  new Response(JSON.stringify({ message: { content: JSON.stringify(payload) } }));

describe("routeIntent", () => {
  it("sends a deterministic, capped request and maps the action", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return reply({ action: "save_fact", fact: "the user trains on Mondays", needs_web: false });
      }),
    );
    try {
      const intent = await routeIntent({
        ...base,
        messages: [{ role: "user", content: "Remember I train Mondays" }],
      });
      expect(intent).toEqual({
        action: "save_fact",
        fact: "the user trains on Mondays",
        needsWeb: false,
      });
      // A classifier must be reproducible and must not ramble.
      const options = body.options as Record<string, unknown>;
      expect(options.temperature).toBe(0);
      expect(options.num_predict).toBe(256);
      // Must match the chat turns' window: a differing num_ctx makes Ollama
      // reload the model (and dump its KV cache) twice per message.
      expect(options.num_ctx).toBe(16384);
      expect(body.keep_alive).toBe("30m");
      expect(body.format).toBeDefined();
      // Every field the intent mapping reads must be grammar-required: an
      // optional field is exactly what a small model omits (measured —
      // optional memory_number zeroed deletes; see CLAUDE.md).
      const format = body.format as { required?: string[] };
      expect([...(format.required ?? [])].sort()).toEqual([
        "action",
        "fact",
        "memory_number",
        "needs_web",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed to `none` when the router errors, so chat is never blocked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    try {
      const intent = await routeIntent({
        ...base,
        messages: [{ role: "user", content: "Forget my allergies" }],
      });
      // needsWeb fails open: a router failure must never remove a capability.
      expect(intent).toEqual({ action: "none", needsWeb: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("aborts when the caller aborts, and reports no action", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    try {
      const pending = routeIntent({
        ...base,
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).resolves.toEqual({ action: "none", needsWeb: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gives up on a stalled model rather than blocking the reply", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      // A model that never answers: the router's own deadline must fire.
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    try {
      const pending = routeIntent({
        ...base,
        messages: [{ role: "user", content: "hello" }],
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toEqual({ action: "none", needsWeb: true });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("rejects a malformed delete without a usable memory number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ action: "delete_fact", needs_web: false })),
    );
    try {
      const intent = await routeIntent({
        ...base,
        messages: [{ role: "user", content: "forget that" }],
      });
      expect(intent).toEqual({ action: "none", needsWeb: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never treats a message about memory as a job change", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ action: "change_job", needs_web: false })),
    );
    try {
      const intent = await routeIntent({
        ...base,
        messages: [{ role: "user", content: "Update what you remember about my training" }],
      });
      expect(intent).toEqual({ action: "none", needsWeb: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("reconcileMemories", () => {
  const existing: BlobMemory[] = [
    { id: "a", text: "Ken's girlfriend is called Sarah", createdAt: 1 },
    { id: "b", text: "Ken is allergic to peanuts", createdAt: 2 },
  ];

  it("returns the positions the model marks obsolete", async () => {
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body);
        return reply({ obsolete: [1] });
      }),
    );
    try {
      const stale = await reconcileMemories({
        model: "qwen3.5:2b",
        fact: "Ken and Sarah broke up",
        existing,
      });
      expect(stale).toEqual([1]);
      // Load-bearing prompt line: without it qwen3.5:9b treats 'the user' and
      // a name as two people and refuses to supersede stale facts (sim: 0/3).
      expect(body).toContain("SAME one person");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("discards positions outside the saved list, so nothing wrong is deleted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ obsolete: [0, 2, 99, -1] })),
    );
    try {
      const stale = await reconcileMemories({
        model: "qwen3.5:2b",
        fact: "something new",
        existing,
      });
      expect(stale).toEqual([2]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps memory untouched when the model stalls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    try {
      const pending = reconcileMemories({
        model: "qwen3.5:2b",
        fact: "Ken and Sarah broke up",
        existing,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("skips the call entirely when there is nothing saved yet", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await expect(
        reconcileMemories({ model: "qwen3.5:2b", fact: "anything", existing: [] }),
      ).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
