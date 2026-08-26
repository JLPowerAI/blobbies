import { describe, expect, it } from "vitest";
import {
  type Agent,
  GREETING,
  GREETING_HINT,
  MAX_BLOB_NAME_LENGTH,
  transcriptFor,
  transcripts,
  uniqueBlobName,
} from "@/data/agents";

describe("uniqueBlobName", () => {
  it("leaves a free name alone", () => {
    expect(uniqueBlobName("Scout", ["Quill", "Ledger"])).toBe("Scout");
  });

  it("suffixes a name another Blob already answers to", () => {
    // `@Scout` resolves to the first match, so a second Scout would be
    // permanently unmentionable and the user could not say which they meant.
    expect(uniqueBlobName("Scout", ["Scout"])).toBe("Scout 2");
    expect(uniqueBlobName("Scout", ["Scout", "Scout 2"])).toBe("Scout 3");
  });

  it("matches case-insensitively, because the mention matcher does", () => {
    expect(uniqueBlobName("scout", ["Scout"])).toBe("scout 2");
  });

  it("refuses names that @-addressing has already claimed", () => {
    // `@everyone` addresses the room, so a Blob called that could never be
    // reached on its own.
    expect(uniqueBlobName("Everyone", [])).toBe("Everyone 2");
  });

  it("keeps the suffix inside the length cap without re-colliding", () => {
    const long = "A".repeat(MAX_BLOB_NAME_LENGTH);
    const suffixed = uniqueBlobName(long, [long]);
    expect(suffixed.length).toBeLessThanOrEqual(MAX_BLOB_NAME_LENGTH);
    // Slicing a long name back to the cap could land it on the very name it
    // is avoiding; the suffix has to survive the trim.
    expect(suffixed).not.toBe(long);
    expect(suffixed.endsWith(" 2")).toBe(true);
  });

  it("returns an empty name untouched, so a rename can pass through it", () => {
    // The settings field is empty for a keystroke between two real names;
    // inventing one there would type over the user.
    expect(uniqueBlobName("  ", ["Scout"])).toBe("");
  });
});

describe("transcriptFor", () => {
  const blob = (): Agent => ({
    id: "test-blob",
    name: "Scout",
    time: "Now",
    snippet: GREETING,
    tone: "purple",
    shape: "sphere",
  });

  it("greets with the question, then the hint that says what to answer with", () => {
    // Two bubbles, one segment each — the shape a real streamed reply is
    // stored in. The hint is the greeting's own message, not a longer
    // greeting: the sidebar snippet and reply-quote still quote the question.
    const entries = transcriptFor(blob());
    expect(entries.map((entry) => entry.kind)).toEqual(["text", "text"]);
    const bubbles = entries.map((entry) =>
      entry.kind === "text" ? entry.segments.map((segment) => segment.text).join("") : "",
    );
    expect(bubbles).toEqual([GREETING, GREETING_HINT]);
    expect(entries[0]?.id).not.toBe(entries[1]?.id);
  });

  it("keeps greeting after the setup round fills in the Blob's own role", () => {
    // The greeting used to be inferred from title/description, so the first
    // turn — which sets both — deleted these bubbles out of a conversation the
    // user was in the middle of reading.
    const configured: Agent = {
      ...blob(),
      greeted: true,
      title: "Inbox summariser",
      description: "Summarises mail",
    };
    expect(transcriptFor(configured)).toHaveLength(2);
  });

  it("gives a Blob born with a role nothing to contradict it", () => {
    // spawn_blob requires both fields, so this Blob never asked what to do —
    // and this history reaches the model, where the canned lines would read
    // as its own words arguing against the role it was born with.
    const born: Agent = { ...blob(), title: "Files receipts", description: "Sorts receipts" };
    expect(transcriptFor(born)).toEqual([]);
  });

  it("still greets a Blob saved before the flag existed", () => {
    // Rosters already on disk carry no `greeted`, so the old inference stays
    // as the fallback rather than silently dropping their greeting.
    expect(transcriptFor(blob())).toHaveLength(2);
  });

  it("prefers the seeded conversation when one exists", () => {
    const agent = blob();
    transcripts[agent.id] = [
      { id: "seeded", kind: "text", author: "agent", segments: [{ text: "Old chat" }] },
    ];
    try {
      expect(transcriptFor(agent)).toHaveLength(1);
    } finally {
      delete transcripts[agent.id];
    }
  });
});
