import { describe, expect, it } from "vitest";
import { clipRecap, pendingMessages, type RecapEntry, renderBlock } from "@/lib/recap";

/**
 * The pure half of compaction. `summarizeHistory` is a single model call and
 * is left to the sim, exactly as `routeIntent`'s call is; what has to be right
 * here is *which* messages a pass reads, since getting that wrong either
 * re-summarises settled material (drift) or silently loses a block forever.
 */

const entry = (id: string, text: string, role: "user" | "assistant" = "user"): RecapEntry => ({
  id,
  message: { role, content: text },
});

describe("pendingMessages", () => {
  const dropped = [entry("a", "one"), entry("b", "two"), entry("c", "three")];

  it("takes the whole block when there is no recap yet", () => {
    expect(pendingMessages(dropped)).toEqual(dropped);
  });

  it("takes only what came after the covered id", () => {
    const pending = pendingMessages(dropped, { text: "so far", coveredId: "a" });
    expect(pending.map((item) => item.id)).toEqual(["b", "c"]);
  });

  it("is empty when the newest dropped message is already covered", () => {
    // The common case in a group: the second member's turn drops the same
    // block the first one already folded in, and must not summarise it twice.
    expect(pendingMessages(dropped, { text: "so far", coveredId: "c" })).toEqual([]);
  });

  it("falls back to the whole block when the covered message is gone", () => {
    // A deleted (or rolled-over) message must not freeze compaction forever:
    // re-reading a little is recoverable, never compacting again is not.
    expect(pendingMessages(dropped, { text: "so far", coveredId: "deleted" })).toEqual(dropped);
  });
});

describe("renderBlock", () => {
  it("labels each side and skips empty messages", () => {
    const block = renderBlock(
      [entry("a", "ship it"), entry("b", "  "), entry("c", "on it", "assistant")],
      "Ken",
    );
    expect(block?.text).toBe("User: ship it\nKen: on it");
    // An empty message contributes nothing, so it cannot be the high-water mark.
    expect(block?.coveredId).toBe("c");
  });

  it("keeps the oldest messages that fit, so one pass stays bounded", () => {
    // The newest are the ones the NEXT pass will still have; dropping the
    // oldest here would lose them outright.
    const long = Array.from({ length: 40 }, (_, index) =>
      entry(`m${index}`, `${index}:${"x".repeat(1_000)}`),
    );
    const block = renderBlock(long, "Ken");
    expect(block?.text.length).toBeLessThanOrEqual(24_000);
    expect(block?.text).toContain("User: 0:");
    expect(block?.text).not.toContain("User: 39:");
  });

  it("reports only what it actually read as covered", () => {
    // The bug this guards: marking the whole block covered when the cap let
    // only part of it through drops the remainder from the prompt AND the
    // recap. On a 131k-token window that would be most of every compaction.
    const long = Array.from({ length: 40 }, (_, index) =>
      entry(`m${index}`, `${index}:${"x".repeat(1_000)}`),
    );
    const block = renderBlock(long, "Ken");
    expect(block?.coveredId).not.toBe("m39");
    // What it did read is contiguous from the start, so the next pass resumes
    // exactly where this one stopped.
    const resumed = pendingMessages(long, { text: "so far", coveredId: block?.coveredId ?? "" });
    expect(resumed[0]?.id).toBe(`m${Number((block?.coveredId ?? "m0").slice(1)) + 1}`);
    expect(resumed.at(-1)?.id).toBe("m39");
  });

  it("caps a single oversized message rather than sending the window at it", () => {
    // It can never fit, so it is clipped and still counted as read — offering
    // it again every turn would wedge compaction on it forever.
    const block = renderBlock([entry("a", "x".repeat(50_000))], "Ken");
    expect(block?.text.length).toBe(24_000);
    expect(block?.coveredId).toBe("a");
  });

  it("is null when there is nothing to read", () => {
    expect(renderBlock([], "Ken")).toBeNull();
    expect(renderBlock([entry("a", "   ")], "Ken")).toBeNull();
  });
});

describe("clipRecap", () => {
  it("leaves a short summary alone, trimmed", () => {
    expect(clipRecap("  We are fixing the invoice script.  ")).toBe(
      "We are fixing the invoice script.",
    );
  });

  it("caps a long one at the sentence boundary before the limit", () => {
    const text = `${"Sentence. ".repeat(200)}TAIL`;
    const clipped = clipRecap(text);
    expect(clipped.length).toBeLessThanOrEqual(1_200);
    expect(clipped.endsWith(".")).toBe(true);
    expect(clipped).not.toContain("TAIL");
  });

  it("still caps when there is no sentence end to cut at", () => {
    // A model that answers in one unpunctuated run must not be able to blow
    // the budget the history split subtracts.
    expect(clipRecap("x".repeat(5_000)).length).toBe(1_200);
  });
});
