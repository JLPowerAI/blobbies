import { describe, expect, it } from "vitest";
import { estimateTokens } from "@/lib/tokens";

describe("estimateTokens", () => {
  it("counts nothing for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("approximates English at about four characters per token", () => {
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });

  it("counts CJK at roughly a token per character", () => {
    // The bug this whole change exists for: 100 Chinese characters cost ~100
    // tokens, not the 25 a character-based budget would assume.
    expect(estimateTokens("字".repeat(100))).toBe(100);
  });

  it("charges a CJK fact far more than a Latin one of equal length", () => {
    const latin = estimateTokens("a".repeat(60));
    const chinese = estimateTokens("字".repeat(60));
    expect(chinese).toBeGreaterThan(latin * 3);
  });

  it("handles mixed scripts additively", () => {
    // 8 Latin chars (2 tokens) + 4 CJK (4 tokens).
    expect(estimateTokens("hello!!!字字字字")).toBe(6);
  });

  it("never under-counts a short string", () => {
    // Rounds up: a budget that overshoots trims a fact, one that undershoots
    // overruns the context window.
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("ab")).toBe(1);
  });

  it("counts kana and hangul as dense too", () => {
    expect(estimateTokens("ひらがな")).toBe(4);
    expect(estimateTokens("한글자모")).toBe(4);
  });
});
