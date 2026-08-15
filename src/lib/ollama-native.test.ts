import { stream } from "@kenkaiiii/gg-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OLLAMA_NUM_CTX,
  registerNativeOllamaProvider,
  toNativeMessages,
} from "@/lib/ollama-native";

registerNativeOllamaProvider();

/** Fake a native /api/chat NDJSON stream from the given chunks. */
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native local provider", () => {
  it("streams text over /api/chat with num_ctx set", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        url = String(input);
        body = JSON.parse(String(init?.body));
        return ndjson([
          { message: { content: "Hel" } },
          { message: { content: "lo" } },
          { done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 2 },
        ]);
      }),
    );

    const result = stream({
      provider: "local",
      model: "test:1b",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 4096,
    });
    const deltas: string[] = [];
    for await (const event of result) {
      if (event.type === "text_delta") {
        deltas.push(event.text);
      }
    }
    const response = await result.response;

    expect(url).toContain("/api/chat");
    const options = body.options as Record<string, unknown>;
    expect(options.num_ctx).toBe(OLLAMA_NUM_CTX);
    expect(options.num_predict).toBe(4096);
    // Without keep_alive the model unloads after 5 idle minutes — the next
    // message then pays a cold reload and a from-scratch prefill.
    expect(body.keep_alive).toBe("30m");
    expect(deltas.join("")).toBe("Hello");
    expect(response.stopReason).toBe("end_turn");
    expect(response.message.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 2 });
  });

  it("surfaces tool calls with minted ids and stopReason tool_use", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjson([
          {
            message: { tool_calls: [{ function: { name: "remember", arguments: { fact: "x" } } }] },
          },
          { done: true, done_reason: "stop" },
        ]),
      ),
    );

    const response = await stream({
      provider: "local",
      model: "test:1b",
      messages: [{ role: "user", content: "remember x" }],
    });

    expect(response.stopReason).toBe("tool_use");
    expect(response.message.content).toEqual([
      { type: "tool_call", id: "ollama-call-1", name: "remember", args: { fact: "x" } },
    ]);
  });
});

describe("toNativeMessages", () => {
  it("flattens tool rounds into ordered tool messages with tool_name", () => {
    expect(
      toNativeMessages([
        { role: "system", content: "be brief" },
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "c1", name: "remember", args: { fact: "x" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "c1", content: "Saved." }],
        },
      ]),
    ).toEqual([
      { role: "system", content: "be brief" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "remember", arguments: { fact: "x" } } }],
      },
      { role: "tool", content: "Saved.", tool_name: "remember" },
    ]);
  });
});
