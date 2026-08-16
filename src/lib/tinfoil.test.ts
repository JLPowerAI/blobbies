import {
  providerRegistry,
  type StreamEvent,
  type StreamOptions,
  type StreamResponse,
  StreamResult,
  type ThinkingLevel,
} from "@kenkaiiii/gg-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureTinfoil,
  isTinfoilModel,
  listTinfoilModels,
  registerTinfoilProvider,
  TINFOIL_MODEL_PREFIX,
  tinfoilModelId,
  tinfoilStructuredCall,
} from "@/lib/tinfoil";

// No test in this file may touch the network: the SecureClient (attestation +
// encrypted transport) is replaced with a controllable fake.
let secureFetchHandler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
vi.mock("tinfoil", () => {
  class FakeSecureClient {
    ready = async () => {};
    // Real SecureClient returns the attested base *with* /v1 and a trailing
    // slash (verified live); the provider must not append another /v1.
    getBaseURL = () => "https://enclave.example.com/v1/";
    fetch = (input: RequestInfo | URL, init?: RequestInit) => secureFetchHandler(input, init);
  }
  return { SecureClient: FakeSecureClient };
});

afterEach(() => {
  configureTinfoil({ apiKey: null });
  vi.unstubAllGlobals();
});

describe("model refs", () => {
  it("namespaces Tinfoil ids and leaves Ollama tags alone", () => {
    expect(isTinfoilModel("tinfoil:gpt-oss-120b")).toBe(true);
    expect(isTinfoilModel("llama3.2:latest")).toBe(false);
    // No Ollama model is literally named "tinfoil", so the prefix can't collide.
    expect(tinfoilModelId("tinfoil:gpt-oss-120b")).toBe("gpt-oss-120b");
    expect(tinfoilModelId("llama3.2:latest")).toBe("llama3.2:latest");
    expect(`${TINFOIL_MODEL_PREFIX}x`).toBe("tinfoil:x");
  });
});

describe("tinfoil provider", () => {
  const fakeResponse = {
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    stopReason: "end_turn",
  } as unknown as StreamResponse;

  /** Install a fake "openai" registry entry and capture what it receives. */
  const captureOpenAI = () => {
    const captured: StreamOptions[] = [];
    providerRegistry.register("openai", {
      stream: (options: StreamOptions) => {
        captured.push(options);
        return new StreamResult(
          (async function* () {
            yield { type: "text", text: "hi" } as unknown as StreamEvent;
            return fakeResponse;
          })(),
          options.signal,
        );
      },
    });
    return captured;
  };

  const baseOptions = {
    model: "tinfoil:gpt-oss-120b",
    messages: [{ role: "user" as const, content: "hi" }],
  };

  it("delegates with the bare id, the attested base URL, and the verified fetch", async () => {
    const captured = captureOpenAI();
    configureTinfoil({ apiKey: "test-key" });
    registerTinfoilProvider();
    const entry = providerRegistry.get("tinfoil");
    const response = await entry?.stream({
      ...baseOptions,
      thinking: "none" as ThinkingLevel,
    } as StreamOptions);
    expect(response).toBe(fakeResponse);
    const delegated = captured[0];
    expect(delegated?.model).toBe("gpt-oss-120b");
    // The SDK must target the enclave origin SecureClient attested, not a
    // hardcoded host — any other origin is rejected by the transport.
    expect(delegated?.baseUrl).toBe("https://enclave.example.com/v1");
    expect(delegated?.apiKey).toBe("test-key");
    expect(typeof delegated?.fetch).toBe("function");
    // "none" is the app's thinking-off sentinel, not a legal reasoning_effort.
    expect("thinking" in (delegated ?? {})).toBe(false);
  });

  it("passes a real thinking level through", async () => {
    const captured = captureOpenAI();
    configureTinfoil({ apiKey: "test-key" });
    registerTinfoilProvider();
    await providerRegistry.get("tinfoil")?.stream({
      ...baseOptions,
      thinking: "low",
    } as StreamOptions);
    expect(captured[0]?.thinking).toBe("low");
  });

  it("fails fast with a clear error when no key is configured", async () => {
    captureOpenAI();
    registerTinfoilProvider();
    await expect(
      providerRegistry.get("tinfoil")?.stream(baseOptions as StreamOptions),
    ).rejects.toThrow(/not configured/);
  });
});

describe("tinfoilStructuredCall", () => {
  const callOptions = {
    model: "tinfoil:gpt-oss-120b",
    messages: [{ role: "user", content: "remember this" }],
    schema: { type: "object", additionalProperties: false },
    schemaName: "route_intent",
    temperature: 0,
    maxTokens: 256,
  };

  it("sends a strict json_schema body with auth, over the verified transport", async () => {
    configureTinfoil({ apiKey: "test-key" });
    let seenUrl = "";
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> = {};
    secureFetchHandler = async (input, init) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get("Authorization");
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"action":"none"}' } }] }),
      );
    };
    const content = await tinfoilStructuredCall(callOptions);
    expect(content).toBe('{"action":"none"}');
    // Relative path: the transport resolves it against the attested origin.
    expect(seenUrl).toBe("/v1/chat/completions");
    expect(seenAuth).toBe("Bearer test-key");
    expect(seenBody.model).toBe("gpt-oss-120b");
    expect(seenBody.stream).toBe(false);
    expect(seenBody.temperature).toBe(0);
    expect(seenBody.max_tokens).toBe(256);
    expect(seenBody.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "route_intent",
        strict: true,
        schema: { type: "object", additionalProperties: false },
      },
    });
  });

  it("fails closed to null on HTTP errors, bad JSON, and thrown transport errors", async () => {
    configureTinfoil({ apiKey: "test-key" });
    secureFetchHandler = async () => new Response("nope", { status: 500 });
    expect(await tinfoilStructuredCall(callOptions)).toBeNull();
    secureFetchHandler = async () => new Response("not json");
    expect(await tinfoilStructuredCall(callOptions)).toBeNull();
    secureFetchHandler = async () => {
      throw new Error("attestation failed");
    };
    expect(await tinfoilStructuredCall(callOptions)).toBeNull();
  });

  it("returns null (never throws) when no key is configured", async () => {
    expect(await tinfoilStructuredCall(callOptions)).toBeNull();
  });
});

describe("listTinfoilModels", () => {
  it("returns chat models only, from the public catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: "gpt-oss-120b", name: "GPT OSS 120B", type: "chat" },
                { id: "nomic-embed-text", name: "Nomic Embed", type: "embedding" },
                { id: "unnamed-chat", type: "chat" },
              ],
            }),
          ),
      ),
    );
    expect(await listTinfoilModels()).toEqual([
      { id: "gpt-oss-120b", name: "GPT OSS 120B" },
      { id: "unnamed-chat", name: "unnamed-chat" },
    ]);
  });

  it("degrades to an empty list on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    expect(await listTinfoilModels()).toEqual([]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await listTinfoilModels()).toEqual([]);
  });
});
