import { describe, expect, it, vi } from "vitest";
import { type BlobMemory, makeBlobTools } from "@/lib/blob-tools";
import { applyGroupIntent, pickResponders, reconcileMemories, routeIntent } from "@/lib/intent";
import { tinfoilStructuredCall } from "@/lib/tinfoil";

// Only the structured call is faked: model-ref helpers stay real, so the
// Ollama-path tests below exercise the exact same branch they always did.
vi.mock("@/lib/tinfoil", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tinfoil")>()),
  tinfoilStructuredCall: vi.fn(async () => null),
}));

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
      expect(intent).toEqual({
        action: "save_fact",
        fact: "the user trains on Mondays",
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
      expect([...(format.required ?? [])].sort()).toEqual(["action", "fact", "memory_number"]);
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

  it("routes a tinfoil model through the verified structured call, never Ollama", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(tinfoilStructuredCall).mockResolvedValueOnce(
      JSON.stringify({
        action: "save_fact",
        fact: "the user trains on Mondays",
        memory_number: 0,
      }),
    );
    try {
      const intent = await routeIntent({
        model: "tinfoil:gpt-oss-120b",
        memories: [],
        messages: [{ role: "user", content: "Remember I train Mondays" }],
      });
      expect(intent).toEqual({
        action: "save_fact",
        fact: "the user trains on Mondays",
      });
      // User content must not touch the local Ollama endpoint on this path.
      expect(fetchSpy).not.toHaveBeenCalled();
      const call = vi.mocked(tinfoilStructuredCall).mock.calls[0]?.[0];
      expect(call?.temperature).toBe(0);
      // OpenAI strict structured outputs require a closed object schema.
      const schema = (call?.schema ?? {}) as { additionalProperties?: boolean };
      expect(schema.additionalProperties).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed to `none` when the tinfoil call fails", async () => {
    vi.mocked(tinfoilStructuredCall).mockResolvedValueOnce(null);
    const intent = await routeIntent({
      model: "tinfoil:gpt-oss-120b",
      memories: [],
      messages: [{ role: "user", content: "Remember this" }],
    });
    expect(intent).toEqual({ action: "none" });
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

describe("applyGroupIntent", () => {
  const memories: BlobMemory[] = [{ id: "m1", text: "the user trains on Mondays", createdAt: 1 }];

  it("saves a fact once, to the scope every Blob reads", async () => {
    // Reconcile is a second model call; nothing is obsolete here.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ obsolete: [] })),
    );
    try {
      const next = await applyGroupIntent(
        { action: "save_fact", fact: "the user lives in Lisbon" },
        { model: base.model, memories },
      );
      // One list, returned once — the caller writes it to the shared scope.
      // Six responders each saving their own copy is six drifting versions of
      // one thing the user said once.
      expect(next?.map((memory) => memory.text)).toEqual([
        "the user trains on Mondays",
        "the user lives in Lisbon",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops a fact the shared scope already holds", async () => {
    const fetchSpy = vi.fn(async () => reply({ obsolete: [] }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const next = await applyGroupIntent(
        { action: "save_fact", fact: "The user trains on Mondays" },
        { model: base.model, memories },
      );
      expect(next).toBeNull();
      // Not even reconciled: a duplicate is not worth a model call.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deletes by position, and ignores a position that is not there", async () => {
    expect(
      await applyGroupIntent(
        { action: "delete_fact", memoryNumber: 1 },
        { model: base.model, memories },
      ),
    ).toEqual([]);
    expect(
      await applyGroupIntent(
        { action: "delete_fact", memoryNumber: 9 },
        { model: base.model, memories },
      ),
    ).toBeNull();
  });

  it("never reconfigures a Blob from a group", async () => {
    // "Be my writing coach instead" has one subject in a 1-to-1 chat and none
    // in a room — rewriting whichever Blob answered would be a silent guess.
    expect(
      await applyGroupIntent({ action: "change_job" }, { model: base.model, memories }),
    ).toBeNull();
  });

  it("lands a fact exactly where the per-Blob `remember` tool would", async () => {
    // The point of the shared reducer. These two paths each used to hold
    // their own save logic and had drifted: one deduped case-sensitively,
    // one refused at the limit while the other evicted, one rewrote a
    // superseded fact in place while the other appended a new row. So the
    // same sentence produced different memory depending on whether the user
    // said it in a group or a 1-to-1 chat, which is how a contradiction gets
    // saved. Given the same judge verdict, the two must now agree exactly.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ obsolete: [1] })),
    );
    try {
      const fromGroup = await applyGroupIntent(
        { action: "save_fact", fact: "the user trains on Fridays" },
        { model: base.model, memories },
      );
      let fromBlob: BlobMemory[] = [];
      const tools = makeBlobTools({
        list: () => memories,
        save: (next) => {
          fromBlob = next;
        },
        // The same verdict the group path just got from the model.
        reconcile: async () => [1],
      });
      await tools
        .find((tool) => tool.name === "remember")
        ?.execute(
          { text: "the user trains on Fridays" },
          { signal: new AbortController().signal, toolCallId: "t1" },
        );
      const shape = (list: BlobMemory[]) =>
        list.map((memory) => ({ id: memory.id, text: memory.text, createdAt: memory.createdAt }));
      expect(shape(fromGroup ?? [])).toEqual(shape(fromBlob));
      // Rewritten in place: same row, same id, same createdAt as the fact it
      // replaced — not a new row beside the stale one.
      expect(shape(fromBlob)).toEqual([
        { id: "m1", text: "the user trains on Fridays", createdAt: 1 },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("pickResponders", () => {
  const members = [
    { name: "Scout", title: "Researcher", description: "Finds sources." },
    { name: "Quill", title: "Writer", description: "Writes drafts." },
    { name: "Ledger", title: "Bookkeeper", description: "Tracks spend." },
  ];

  it("constrains the answer to the members' own names, in roster order", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        // Reversed, and with a duplicate: the model's ordering is arbitrary.
        return reply({ responders: ["Quill", "Scout", "Quill"] });
      }),
    );
    try {
      const picked = await pickResponders({ model: base.model, text: "draft this", members });
      // Deduped and re-ordered by the roster, so a group always speaks in the
      // same order whatever the model emits.
      expect(picked).toEqual(["Scout", "Quill"]);
      // An unknown name must not be generatable, not merely filtered after.
      const format = body.format as {
        properties?: { responders?: { items?: { enum?: string[] } } };
      };
      expect(format.properties?.responders?.items?.enum).toEqual(["Scout", "Quill", "Ledger"]);
      // Same runner options as every other call, or Ollama reloads the model.
      expect((body.options as Record<string, unknown>).num_ctx).toBe(16384);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes recent lines so a bare follow-up is routable", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return reply({ responders: ["Ledger"] });
      }),
    );
    try {
      await pickResponders({
        model: base.model,
        text: "and what did that cost?",
        members,
        recent: ["Ken: book the venue", "Scout: booked for the 14th"],
      });
      const system = String(
        (body.messages as { role: string; content: string }[])[0]?.content ?? "",
      );
      // "that" is unresolvable without them.
      expect(system).toContain("booked for the 14th");
      // And the excerpt must not become the answer: naming someone in it is
      // not a reason to pick them.
      expect(system).toContain("Do not pick someone merely because they appear");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("honours a pick of nobody \u2014 silence is a real answer in a group", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ responders: [] })),
    );
    try {
      expect(await pickResponders({ model: base.model, text: "thanks all", members })).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails open to everyone, so a router outage never mutes a group", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    try {
      expect(await pickResponders({ model: base.model, text: "where are we", members })).toEqual([
        "Scout",
        "Quill",
        "Ledger",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks nothing when there is no choice to make", async () => {
    const fetchSpy = vi.fn(async () => reply({ responders: [] }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const one = [members[0] as { name: string }];
      expect(await pickResponders({ model: base.model, text: "hi", members: one })).toEqual([
        "Scout",
      ]);
      // A one-Blob group, or an empty message, is not worth a model call.
      expect(await pickResponders({ model: base.model, text: "  ", members })).toHaveLength(3);
      expect(fetchSpy).not.toHaveBeenCalled();
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

  it("reconciles through the verified structured call on a tinfoil model", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(tinfoilStructuredCall).mockResolvedValueOnce(JSON.stringify({ obsolete: [1] }));
    try {
      const stale = await reconcileMemories({
        model: "tinfoil:gpt-oss-120b",
        fact: "Ken and Sarah broke up",
        existing,
      });
      expect(stale).toEqual([1]);
      expect(fetchSpy).not.toHaveBeenCalled();
      // The load-bearing "SAME one person" prompt rides along unchanged.
      const call = vi.mocked(tinfoilStructuredCall).mock.calls.at(-1)?.[0];
      expect(JSON.stringify(call?.messages)).toContain("SAME one person");
    } finally {
      vi.unstubAllGlobals();
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
