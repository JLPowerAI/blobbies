import { describe, expect, it } from "vitest";
import { contextWindow, rememberTinfoilWindows } from "@/lib/context-window";
import { OLLAMA_NUM_CTX } from "@/lib/ollama-native";

/**
 * Which window each model choice reports.
 *
 * The numbers here are the live ones from Tinfoil's public catalog at the time
 * of writing, so a change in their catalog shape shows up as a failing
 * expectation rather than as history quietly vanishing.
 */
describe("contextWindow", () => {
  it("reports what we actually allocate for a local model, not its trained window", () => {
    // Ollama advertises qwen3.5:9b as 262144, but we pass `num_ctx` ourselves
    // and the server allocates exactly that. Trusting the advertised number
    // would overflow at 16k, which is the failure this function exists to
    // avoid.
    expect(contextWindow("qwen3.5:9b")).toBe(OLLAMA_NUM_CTX);
    expect(contextWindow("")).toBe(OLLAMA_NUM_CTX);
  });

  it("falls back conservatively for a Tinfoil model it has never seen", () => {
    // The catalog is fetched over the network and degrades to [] on failure.
    // The fallback is the floor across their tool-capable chat models, so it
    // can only ever be too cautious — never an overflow we cannot recover
    // from.
    expect(contextWindow("tinfoil:never-fetched")).toBe(131_072);
  });

  it("uses each model's own window once the catalog has been read", () => {
    rememberTinfoilWindows([
      { id: "deepseek-v4-flash", contextWindow: 1_048_576 },
      { id: "gpt-oss-120b", contextWindow: 131_072 },
      // A catalog entry with no window keeps the fallback rather than a zero
      // that would make every conversation look over budget.
      { id: "mystery-model" },
    ]);
    expect(contextWindow("tinfoil:deepseek-v4-flash")).toBe(1_048_576);
    expect(contextWindow("tinfoil:gpt-oss-120b")).toBe(131_072);
    expect(contextWindow("tinfoil:mystery-model")).toBe(131_072);
  });

  it("ignores an unusable window rather than starving or disabling the budget", () => {
    // Zero would make every conversation look over budget; NaN, which `typeof`
    // calls a number, would make every comparison false and stop trimming
    // altogether. Both come from a network payload, so both are possible.
    rememberTinfoilWindows([
      { id: "zero-model", contextWindow: 0 },
      { id: "nan-model", contextWindow: Number.NaN },
      { id: "negative-model", contextWindow: -1 },
    ]);
    expect(contextWindow("tinfoil:zero-model")).toBe(131_072);
    expect(contextWindow("tinfoil:nan-model")).toBe(131_072);
    expect(contextWindow("tinfoil:negative-model")).toBe(131_072);
  });
});
