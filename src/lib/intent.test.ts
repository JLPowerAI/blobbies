import { describe, expect, it, vi } from "vitest";
import { routeIntent } from "@/lib/intent";

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
        return reply({ action: "save_fact", fact: "the user trains on Mondays" });
      }),
    );
    try {
      const intent = await routeIntent({
        ...base,
        messages: [{ role: "user", content: "Remember I train Mondays" }],
      });
      expect(intent).toEqual({ action: "save_fact", fact: "the user trains on Mondays" });
      // A classifier must be reproducible and must not ramble.
      const options = body.options as Record<string, unknown>;
      expect(options.temperature).toBe(0);
      expect(options.num_predict).toBe(256);
      expect(body.format).toBeDefined();
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
      expect(intent).toEqual({ action: "none" });
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
      await expect(pending).resolves.toEqual({ action: "none" });
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
      await expect(pending).resolves.toEqual({ action: "none" });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("rejects a malformed delete without a usable memory number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ action: "delete_fact" })),
    );
    try {
      const intent = await routeIntent({
        ...base,
        messages: [{ role: "user", content: "forget that" }],
      });
      expect(intent).toEqual({ action: "none" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never treats a message about memory as a job change", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ action: "change_job" })),
    );
    try {
      const intent = await routeIntent({
        ...base,
        messages: [{ role: "user", content: "Update what you remember about my training" }],
      });
      expect(intent).toEqual({ action: "none" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
