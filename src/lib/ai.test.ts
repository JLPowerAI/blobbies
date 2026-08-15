import { describe, expect, it, vi } from "vitest";
import { streamBlobTurn, streamLocalChat } from "@/lib/ai";

// Stub `fetch` once with a stable dispatcher and swap the handler per test,
// so nothing can capture a stale per-test mock across tests.
let fetchHandler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => fetchHandler(input, init));

/** Mirrors MAX_TOOL_ROUNDS in ai.ts: the budget a turn may spend on tools. */
const MAX_ROUNDS = 25;

/** Fake a native /api/chat NDJSON stream (one chunk per line). */
const ndjson = (chunks: object[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join("")),
        );
        controller.close();
      },
    }),
  );

const textChunks = (text: string) => [
  { message: { content: text } },
  { done: true, done_reason: "stop" },
];

const toolCallChunks = (name: string, args: object, preamble?: string) => [
  ...(preamble === undefined ? [] : [{ message: { content: preamble } }]),
  { message: { tool_calls: [{ function: { name, arguments: args } }] } },
  { done: true, done_reason: "stop" },
];

/**
 * End-to-end through the app's native Ollama provider (registered over gg-ai's
 * "local" entry) in a browser-like environment, exactly like the Tauri webview.
 */
describe("streamLocalChat", () => {
  it("streams a reply over native /api/chat with a real context window", async () => {
    fetchHandler = async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:11434/api/chat");
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // Chain-of-thought must stay off for local models: with it on, reasoning
      // models burn thousands of hidden tokens (~21s) before the first word.
      expect(request.think).toBe(false);
      const options = request.options as Record<string, unknown>;
      // The whole point of the native path: /v1 cannot set num_ctx, and
      // Ollama's 4096 default truncates conversations mid-reply.
      expect(options.num_ctx).toBe(16384);
      expect(options.num_predict).toBe(4096);
      return ndjson(textChunks("Hello"));
    };
    const response = await streamLocalChat({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.message.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(response.stopReason).toBe("end_turn");
  });
});

describe("blobSystemPrompt", () => {
  it("injects the user's name but never a clock (a clock breaks the KV-cache prefix)", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    const prompt = blobSystemPrompt(
      { name: "Ken", title: "Coach", description: "Helps." },
      { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" },
    );
    expect(prompt).toContain("The user's name is Ken Kai.");
    // Anything that changes each turn re-prefills the whole transcript.
    expect(prompt).not.toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("timeNote", () => {
  it("renders the user's local time, for the tail of the newest message", async () => {
    const { timeNote } = await import("@/lib/ai");
    const now = new Date(Date.UTC(2026, 7, 12, 7, 4)); // 15:04 in Kuala Lumpur
    const note = timeNote({ userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" }, now);
    expect(note).toContain("Asia/Kuala_Lumpur");
    expect(note).toContain("2026");
    expect(note).toMatch(/15:04|3:04/); // locale-dependent clock format
  });
});

describe("trimHistory", () => {
  it("returns a short conversation untouched", async () => {
    const { trimHistory } = await import("@/lib/ai");
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    expect(trimHistory(messages)).toEqual(messages);
  });

  it("drops the oldest turns in one block once over budget, keeping the newest", async () => {
    const { trimHistory } = await import("@/lib/ai");
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${index}:${"x".repeat(10_000)}`,
    }));
    const kept = trimHistory(messages);
    expect(kept.length).toBeLessThan(messages.length);
    // The newest message always survives, and order is preserved.
    expect(kept[kept.length - 1]).toEqual(messages[messages.length - 1]);
    expect(kept).toEqual(messages.slice(messages.length - kept.length));
  });
});

describe("streamBlobTurn", () => {
  it("self-configures via structured outputs when forced, then streams the reply", async () => {
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // Round 1: forced configure is the non-streaming structured call.
      if (request.format !== undefined) {
        // The schema must not carry maxLength: a grammar cap makes the model
        // truncate mid-word (the "…I'll A" bug) instead of writing shorter.
        expect(String(init?.body)).not.toContain("maxLength");
        return new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({ title: "Therapist", description: "Listens first." }),
            },
          }),
        );
      }
      // Round 2: the normal streamed turn confirms.
      return ndjson(textChunks("All set."));
    };
    const configured: unknown[] = [];
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "Just be my therapist" }],
      forceConfigure: true,
      memory: { list: () => [], save: () => {} },
      onText: () => {},
      onConfigure: (patch) => configured.push(patch),
    });
    expect(configured).toEqual([{ title: "Therapist", description: "Listens first." }]);
    expect(text).toBe("All set.");
  });

  it("never offers memory tools to the loop, so a freelance forget cannot delete", async () => {
    // The sim caught qwen3.5:2b deleting a memory while answering "What day
    // do I train?". Memory writes belong to the router alone: the loop's tool
    // catalog must be web-only, and a hallucinated forget call must bounce as
    // an unknown tool instead of executing.
    const memories = [{ id: "aaa11111", text: "Ken trains on Mondays", createdAt: 1 }];
    let saved: unknown = null;
    let offeredTools: string[] = [];
    let call = 0;
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.format !== undefined) {
        // The deterministic router: this message is plain conversation.
        return new Response(JSON.stringify({ message: { content: '{"action":"none"}' } }));
      }
      call++;
      if (call === 1) {
        offeredTools = ((request.tools ?? []) as { function: { name: string } }[]).map(
          (tool) => tool.function.name,
        );
        return ndjson(toolCallChunks("forget", { id: "1" }));
      }
      return ndjson(textChunks("You train on Mondays."));
    };
    const records: { name: string; result: string }[] = [];
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "What day do I train?" }],
      memory: {
        list: () => memories,
        save: (next) => {
          saved = next;
        },
      },
      onText: () => {},
      onConfigure: () => {},
      onToolCall: (record) => records.push({ name: record.name, result: record.result }),
    });
    // The catalog itself is the guarantee — no write tool for any model to misuse.
    expect([...offeredTools].sort()).toEqual(["web_fetch", "web_search"]);
    // Nothing persisted: the memory survived the misfire.
    expect(saved).toBeNull();
    expect(records[0]?.result).toContain("Unknown tool");
    expect(text).toBe("You train on Mondays.");
  });

  it("finishes a reply that was cut off by the tool-round budget", async () => {
    // Reproduces the real failure: the model starts answering, calls another
    // tool, and the loop hits maxTurns — leaving "From your search, here".
    let call = 0;
    fetchHandler = async () => {
      call++;
      // Every round but the last keeps requesting a tool, exhausting the
      // budget. The final tool-free round is the one that must produce text.
      return call <= MAX_ROUNDS
        ? ndjson(toolCallChunks("web_search", { query: "x" }, "From your search, here"))
        : ndjson(textChunks("Here are the three latest models, in full."));
    };
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "latest models?" }],
      memory: { list: () => [], save: () => {} },
      onText: () => {},
      onConfigure: () => {},
    });
    // The user must never be left with the fragment.
    expect(text).toBe("Here are the three latest models, in full.");
  });

  it("discards preamble said before a tool call, keeping only the answer", async () => {
    let call = 0;
    fetchHandler = async () => {
      call++;
      return call === 1
        ? // "Let me search for that." then a tool call: preamble, not an answer.
          ndjson(toolCallChunks("web_search", { query: "x" }, "Let me search for that."))
        : ndjson(textChunks("The answer is 42."));
    };
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "what is it?" }],
      memory: { list: () => [], save: () => {} },
      onText: () => {},
      onConfigure: () => {},
    });
    // Previously these concatenated into "Let me search for that.The answer..."
    expect(text).toBe("The answer is 42.");
  });

  it("clips an oversized description at a sentence boundary, never mid-word", async () => {
    const longDescription = `${"I help with drafts. ".repeat(80)}And this trailing sentence runs far past the display cap without a break`;
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.format !== undefined) {
        return new Response(
          JSON.stringify({
            message: { content: JSON.stringify({ title: "Writer", description: longDescription }) },
          }),
        );
      }
      return ndjson(textChunks("Done."));
    };
    const configured: { title?: string; description?: string }[] = [];
    await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "Be my writer" }],
      forceConfigure: true,
      memory: { list: () => [], save: () => {} },
      onText: () => {},
      onConfigure: (patch) => configured.push(patch),
    });
    const description = configured[0]?.description ?? "";
    expect(description.length).toBeLessThanOrEqual(1200);
    // Ends exactly at a sentence boundary — not mid-word like the disk bug.
    expect(description.endsWith("drafts.")).toBe(true);
  });
});
