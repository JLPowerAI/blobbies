import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetModelCapabilities,
  modelSeesImages,
  rememberTinfoilVision,
} from "@/lib/model-vision";

/**
 * The rule this encodes: OCR an image only for a model that cannot see it.
 *
 * Both directions cost something real. Saying "text only" about a vision model
 * degrades a chart to an OCR dump; saying "vision" about a text-only one makes
 * the provider reject the entire request, losing the turn rather than the
 * picture. So the unknown cases below are pinned deliberately to the first.
 */

afterEach(() => {
  forgetModelCapabilities();
  vi.unstubAllGlobals();
});

/** One `/api/show` reply, or a thrown fetch when `body` is an Error. */
function stubOllama(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    if (body instanceof Error) {
      throw body;
    }
    return { ok, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("modelSeesImages, on a local model", () => {
  it("believes Ollama when it reports vision", async () => {
    stubOllama({ capabilities: ["completion", "vision", "tools"] });
    expect(await modelSeesImages("qwen3.5:9b")).toBe(true);
  });

  it("is false for a model without the capability", async () => {
    stubOllama({ capabilities: ["completion", "tools"] });
    expect(await modelSeesImages("ministral-3:3b")).toBe(false);
  });

  it("asks once per model, then reuses the answer", async () => {
    // Every turn builds a prompt; probing localhost each time would add a
    // round trip to a question whose answer cannot change under a running app.
    const fetchMock = stubOllama({ capabilities: ["vision"] });
    await modelSeesImages("qwen3.5:9b");
    await modelSeesImages("qwen3.5:9b");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says text-only when Ollama is unreachable, errors, or answers oddly", async () => {
    // Each of these used to be a way to send an image to a model that cannot
    // take one. They all have to land on today's behaviour instead.
    stubOllama(new Error("connection refused"));
    expect(await modelSeesImages("a")).toBe(false);

    stubOllama({ capabilities: ["vision"] }, false);
    expect(await modelSeesImages("b")).toBe(false);

    stubOllama({ capabilities: "vision" });
    expect(await modelSeesImages("c")).toBe(false);

    stubOllama(null);
    expect(await modelSeesImages("d")).toBe(false);
  });
});

describe("modelSeesImages, on a Tinfoil model", () => {
  it("reads the catalog flag, per model", async () => {
    rememberTinfoilVision([
      { id: "kimi-k3", multimodal: true },
      { id: "deepseek-v4-flash", multimodal: false },
    ]);
    expect(await modelSeesImages("tinfoil:kimi-k3")).toBe(true);
    expect(await modelSeesImages("tinfoil:deepseek-v4-flash")).toBe(false);
  });

  it("never probes localhost for a hosted model", async () => {
    const fetchMock = stubOllama({ capabilities: ["vision"] });
    rememberTinfoilVision([{ id: "kimi-k3", multimodal: true }]);
    await modelSeesImages("tinfoil:kimi-k3");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is false before the catalog has loaded, then corrects itself", async () => {
    // A scheduled routine can fire before any UI fetches the catalog. That
    // miss must not be remembered: caching it would send OCR text to a vision
    // model for the rest of the session, long after the flags arrived.
    expect(await modelSeesImages("tinfoil:kimi-k3")).toBe(false);
    rememberTinfoilVision([{ id: "kimi-k3", multimodal: true }]);
    expect(await modelSeesImages("tinfoil:kimi-k3")).toBe(true);
  });

  it("still answers once per model once the catalog is known", async () => {
    // The re-check above must not become a lookup on every turn when there
    // is a real answer to keep.
    rememberTinfoilVision([{ id: "kimi-k3", multimodal: true }]);
    expect(await modelSeesImages("tinfoil:kimi-k3")).toBe(true);
    rememberTinfoilVision([{ id: "kimi-k3", multimodal: false }]);
    expect(await modelSeesImages("tinfoil:kimi-k3")).toBe(true);
  });

  it("ignores a non-boolean flag rather than trusting it", async () => {
    rememberTinfoilVision([{ id: "kimi-k3", multimodal: "yes" as unknown as boolean }]);
    expect(await modelSeesImages("tinfoil:kimi-k3")).toBe(false);
  });
});
