import { describe, expect, it, vi } from "vitest";
import { streamBlobTurn, streamLocalChat } from "@/lib/ai";

// gg-ai memoizes its OpenAI client, which captures `fetch` at construction —
// so per-test vi.stubGlobal leaks the first test's mock into later tests.
// Stub once with a stable dispatcher and swap the handler per test instead.
let fetchHandler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => fetchHandler(input, init));

const sseChunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    model: "llama3.2:latest",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

/**
 * End-to-end through gg-ai in a browser-like environment (jsdom has window +
 * document + navigator, exactly like the Tauri webview). This only passes when
 * the "openai" alias shim forces `dangerouslyAllowBrowser`; without it the
 * client constructor throws before any request is made.
 */
describe("streamLocalChat", () => {
  it("streams a reply from the local Ollama endpoint", async () => {
    fetchHandler = async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:11434/v1/chat/completions");
      // Chain-of-thought must stay off for local models: with it on, reasoning
      // models burn thousands of hidden tokens (~21s) before the first word.
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request.reasoning_effort).toBe("none");
      expect(request.max_completion_tokens).toBe(2048);
      const body = `${sseChunk({ role: "assistant", content: "Hello" })}${sseChunk({}, "stop")}data: [DONE]\n\n`;
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const response = await streamLocalChat({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.message.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(response.stopReason).toBe("stop_sequence");
  });
});

describe("blobSystemPrompt", () => {
  it("injects the user's name, timezone and current local time", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    const now = new Date(Date.UTC(2026, 7, 12, 7, 4)); // 15:04 in Kuala Lumpur
    const prompt = blobSystemPrompt(
      { name: "Ken", title: "Coach", description: "Helps." },
      { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" },
      now,
    );
    expect(prompt).toContain("The user's name is Ken Kai.");
    expect(prompt).toContain("Asia/Kuala_Lumpur");
    expect(prompt).toContain("2026");
    expect(prompt).toMatch(/15:04|3:04/); // locale-dependent clock format
  });
});

describe("streamBlobTurn", () => {
  it("self-configures via structured outputs when forced, then streams the reply", async () => {
    fetchHandler = async (input, init) => {
      const url = String(input);
      // Round 1: forced configure goes to the native endpoint with a schema.
      if (url.endsWith("/api/chat")) {
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
      const body = `${sseChunk({ role: "assistant", content: "All set." })}${sseChunk({}, "stop")}data: [DONE]\n\n`;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
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

  it("clips an oversized description at a sentence boundary, never mid-word", async () => {
    const longDescription = `${"I help with drafts. ".repeat(80)}And this trailing sentence runs far past the display cap without a break`;
    fetchHandler = async (input) => {
      if (String(input).endsWith("/api/chat")) {
        return new Response(
          JSON.stringify({
            message: { content: JSON.stringify({ title: "Writer", description: longDescription }) },
          }),
        );
      }
      const body = `${sseChunk({ role: "assistant", content: "Done." })}${sseChunk({}, "stop")}data: [DONE]\n\n`;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
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
