import { describe, expect, it } from "vitest";
import {
  applyMemoryWrite,
  type BlobMemory,
  knownFact,
  MEMORY_LIMIT,
  MEMORY_TEXT_LIMIT,
  normaliseFact,
  renderMemories,
} from "@/lib/memory";

/**
 * The memory lifecycle, at the one place every writer goes through.
 *
 * Three callers used to own a copy of this logic — the `remember` tool, the
 * group intent router, and the details panel — and they had drifted apart on
 * duplicates, on what happens at the limit, and on where a corrected fact
 * lands in the list. The same sentence therefore produced different memory
 * depending on where the user said it. These tests pin the shared behaviour;
 * the per-caller suites (blob-tools, intent, App) check the wiring into it.
 */

let clock = 1_000;
/** Distinct, ordered timestamps: eviction and provenance both depend on them. */
const tick = () => {
  clock += 1_000;
  return clock;
};

const fact = (text: string, at = tick()): BlobMemory => ({
  id: crypto.randomUUID().slice(0, 8),
  text,
  createdAt: at,
});

const texts = (memories: BlobMemory[]) => memories.map((memory) => memory.text);

describe("normaliseFact", () => {
  it("collapses whitespace, trims, and caps at the stored length", () => {
    expect(normaliseFact("  Biscuit   is\na beagle ")).toBe("Biscuit is a beagle");
    expect(normaliseFact("x".repeat(MEMORY_TEXT_LIMIT + 50))).toHaveLength(MEMORY_TEXT_LIMIT);
    expect(normaliseFact("   ")).toBe("");
  });
});

describe("knownFact", () => {
  it("ignores case and spacing, so a restated fact costs no model call", () => {
    const memories = [fact("Biscuit is a beagle")];
    expect(knownFact(memories, "biscuit  IS a beagle")).toBe(true);
    expect(knownFact(memories, "Biscuit is a poodle")).toBe(false);
    expect(knownFact(memories, "  ")).toBe(false);
  });
});

describe("applyMemoryWrite: save", () => {
  it("appends a new fact and reports it as saved", () => {
    const before = [fact("Ken has a sister")];
    const result = applyMemoryWrite(before, { kind: "save", text: "Ken lives in Lisbon" });
    expect(result.outcome).toBe("saved");
    expect(result.changed).toBe(true);
    expect(texts(result.memories)).toEqual(["Ken has a sister", "Ken lives in Lisbon"]);
    // Pure: the caller's array is never mutated, so React state stays sound.
    expect(texts(before)).toEqual(["Ken has a sister"]);
  });

  it("refuses a blank fact without touching the list", () => {
    const before = [fact("Ken has a sister")];
    const result = applyMemoryWrite(before, { kind: "save", text: "   \n " });
    expect(result.outcome).toBe("empty");
    expect(result.changed).toBe(false);
    expect(result.memories).toBe(before);
  });

  it("treats a differently-spaced, differently-cased restatement as a duplicate", () => {
    // The per-Blob path used to compare case-sensitively and the group path
    // did not, so saying the same thing twice duplicated in a 1-on-1 chat but
    // not in a group.
    const before = [fact("Ken trains on Mondays")];
    const result = applyMemoryWrite(before, { kind: "save", text: "ken  Trains on mondays" });
    expect(result.outcome).toBe("duplicate");
    expect(result.changed).toBe(false);
    expect(result.memories).toBe(before);
  });

  it("rewrites the fact a model judge called stale, in place", () => {
    const before = [fact("Ken has a sister"), fact("Ken trains on Mondays"), fact("Ken likes tea")];
    const result = applyMemoryWrite(before, {
      kind: "save",
      text: "Ken trains on Fridays",
      stale: [2],
    });
    expect(result.outcome).toBe("replaced");
    expect(result.replaced.map((memory) => memory.text)).toEqual(["Ken trains on Mondays"]);
    // Position 2 keeps its slot: a corrected fact drifting to the end would
    // read to the prompt budget as the newest thing known about the user.
    expect(texts(result.memories)).toEqual([
      "Ken has a sister",
      "Ken trains on Fridays",
      "Ken likes tea",
    ]);
    expect(result.memories[1]?.id).toBe(before[1]?.id);
    expect(result.memories[1]?.createdAt).toBe(before[1]?.createdAt);
    expect(result.memories[1]?.updatedAt).toBeGreaterThan(0);
  });

  it("drops every fact the new one invalidated, keeping one slot", () => {
    const before = [
      fact("Ken dates Sarah"),
      fact("Ken and Sarah live together"),
      fact("Ken codes"),
    ];
    const result = applyMemoryWrite(before, {
      kind: "save",
      text: "Ken and Sarah broke up",
      stale: [1, 2],
    });
    expect(result.outcome).toBe("replaced");
    expect(texts(result.memories)).toEqual(["Ken and Sarah broke up", "Ken codes"]);
    expect(result.replaced).toHaveLength(2);
  });

  it("ignores out-of-range positions from the judge rather than trusting them", () => {
    // A 2B model asked for "[2]" against a 3-fact list will occasionally
    // answer "[7]"; acting on that would delete by accident.
    const before = [fact("Ken has a sister")];
    const result = applyMemoryWrite(before, { kind: "save", text: "Ken has a dog", stale: [7, 0] });
    expect(result.outcome).toBe("saved");
    expect(texts(result.memories)).toEqual(["Ken has a sister", "Ken has a dog"]);
  });

  it("falls back to word overlap when no judge answered", () => {
    // No `stale` key at all: the offline path, which catches a restatement
    // and a replaced schedule but not a semantic contradiction.
    const before = [fact("Ken trains on Mondays")];
    const result = applyMemoryWrite(before, { kind: "save", text: "Ken trains on Fridays" });
    expect(result.outcome).toBe("replaced");
    expect(texts(result.memories)).toEqual(["Ken trains on Fridays"]);
  });

  it("keeps facts that can both be true", () => {
    const before = [fact("Ken is allergic to peanuts")];
    const result = applyMemoryWrite(before, {
      kind: "save",
      text: "Ken is allergic to shellfish",
      stale: [],
    });
    expect(result.outcome).toBe("saved");
    expect(result.memories).toHaveLength(2);
  });

  it("an empty judge verdict overrules the overlap fallback", () => {
    // `stale: []` is a real answer ("nothing is obsolete"), not a missing one.
    // Falling back to overlap here would silently merge two true facts.
    const before = [fact("Ken trains on Mondays")];
    const result = applyMemoryWrite(before, {
      kind: "save",
      text: "Ken trains on Fridays too",
      stale: [],
    });
    expect(result.outcome).toBe("saved");
    expect(result.memories).toHaveLength(2);
  });
});

describe("applyMemoryWrite: the size limit", () => {
  const full = () =>
    Array.from({ length: MEMORY_LIMIT }, (_, index) => fact(`fact number ${index}`));

  it("evicts the least recently touched fact to make room", () => {
    // The old per-Blob path refused the write instead ("Memory is full"),
    // which meant memory silently stopped working at 40 facts.
    const before = full();
    const result = applyMemoryWrite(before, { kind: "save", text: "a brand new thing" });
    expect(result.outcome).toBe("saved");
    expect(result.memories).toHaveLength(MEMORY_LIMIT);
    expect(result.evicted.map((memory) => memory.text)).toEqual(["fact number 0"]);
    expect(texts(result.memories)).toContain("a brand new thing");
    expect(texts(result.memories)).not.toContain("fact number 0");
  });

  it("keeps an old fact that was recently reinforced, dropping an untouched newer one", () => {
    const before = full();
    // The oldest row, confirmed this morning: load-bearing, not stale.
    const revived = { ...(before[0] as BlobMemory), updatedAt: tick() };
    const result = applyMemoryWrite([revived, ...before.slice(1)], {
      kind: "save",
      text: "a brand new thing",
    });
    expect(result.evicted.map((memory) => memory.text)).toEqual(["fact number 1"]);
    expect(texts(result.memories)).toContain("fact number 0");
  });

  it("replaces without evicting, so a correction at the limit costs nothing", () => {
    const before = full();
    const result = applyMemoryWrite(before, {
      kind: "save",
      text: "fact number 0, corrected",
      stale: [1],
    });
    expect(result.outcome).toBe("replaced");
    expect(result.evicted).toEqual([]);
    expect(result.memories).toHaveLength(MEMORY_LIMIT);
  });
});

describe("applyMemoryWrite: update", () => {
  it("rewords in place, keeping id and createdAt", () => {
    const before = [fact("Ken has a sister"), fact("Ken trains on Mondays")];
    const result = applyMemoryWrite(before, { kind: "update", ref: "2", text: "Ken trains daily" });
    expect(result.outcome).toBe("updated");
    expect(texts(result.memories)).toEqual(["Ken has a sister", "Ken trains daily"]);
    expect(result.memories[1]?.id).toBe(before[1]?.id);
    expect(result.memories[1]?.createdAt).toBe(before[1]?.createdAt);
  });

  it("resolves a fact by position, by id, or by a quoted phrase", () => {
    const before = [fact("Ken has a sister"), fact("Ken trains on Mondays")];
    const targetId = before[1]?.id as string;
    for (const ref of ["2", "[2]", targetId, "trains on Mondays"]) {
      const result = applyMemoryWrite(before, { kind: "update", ref, text: "Ken trains daily" });
      expect(result.outcome, `ref ${ref}`).toBe("updated");
      expect(texts(result.memories)[1], `ref ${ref}`).toBe("Ken trains daily");
    }
  });

  it("reports a miss instead of writing when the reference matches nothing", () => {
    const before = [fact("Ken has a sister")];
    const result = applyMemoryWrite(before, { kind: "update", ref: "9", text: "anything" });
    expect(result.outcome).toBe("missing");
    expect(result.changed).toBe(false);
    expect(result.memories).toBe(before);
  });

  it("refuses to delete via an empty update", () => {
    // A mis-parsed tool call must not erase a fact the model meant to reword;
    // deleting is a separate, explicit write.
    const before = [fact("Ken has a sister")];
    const result = applyMemoryWrite(before, { kind: "update", ref: "1", text: "  " });
    expect(result.outcome).toBe("empty");
    expect(result.changed).toBe(false);
    expect(result.memories).toBe(before);
  });

  it("is a no-op when the text did not really change", () => {
    const before = [fact("Ken has a sister")];
    const result = applyMemoryWrite(before, {
      kind: "update",
      ref: "1",
      text: "ken has a  sister",
    });
    expect(result.outcome).toBe("duplicate");
    expect(result.changed).toBe(false);
  });

  it("absorbs a twin when an edit collides with another row", () => {
    const before = [fact("Ken trains on Mondays"), fact("Ken trains on Fridays")];
    const result = applyMemoryWrite(before, {
      kind: "update",
      ref: "1",
      text: "Ken trains on Fridays",
    });
    expect(result.outcome).toBe("updated");
    expect(texts(result.memories)).toEqual(["Ken trains on Fridays"]);
    expect(result.replaced.map((memory) => memory.text)).toEqual(["Ken trains on Fridays"]);
  });
});

describe("applyMemoryWrite: delete", () => {
  it("removes the referenced fact and leaves the rest in order", () => {
    const before = [fact("one thing"), fact("two thing"), fact("three thing")];
    const result = applyMemoryWrite(before, { kind: "delete", ref: "2" });
    expect(result.outcome).toBe("deleted");
    expect(texts(result.memories)).toEqual(["one thing", "three thing"]);
  });

  it("reports a miss for an out-of-range position rather than deleting blindly", () => {
    const before = [fact("one thing")];
    for (const ref of ["0", "4", "", "nonsense that matches nothing"]) {
      const result = applyMemoryWrite(before, { kind: "delete", ref });
      expect(result.outcome, `ref ${ref}`).toBe("missing");
      expect(result.memories, `ref ${ref}`).toBe(before);
    }
  });

  it("never resolves a number onto a fact that merely contains that digit", () => {
    // A number addresses a row. Letting it fall through to the phrase
    // fallback, which matches substrings, makes `forget("0")` delete the
    // first fact containing a zero — silent, wrong, and unrecoverable.
    const before = [fact("Ken runs 10k on Sundays"), fact("Ken has a sister")];
    for (const ref of ["0", "10", "99"]) {
      const result = applyMemoryWrite(before, { kind: "delete", ref });
      expect(result.outcome, `ref ${ref}`).toBe("missing");
    }
    // The phrase fallback still works for a model that quoted the fact.
    expect(applyMemoryWrite(before, { kind: "delete", ref: "runs 10k" }).outcome).toBe("deleted");
  });

  it("addresses an all-digit id as an id, not as a row number", () => {
    // Ids are the first 8 hex digits of a uuid, so about one in forty is all
    // digits. The details panel passes ids, not positions: read as a position,
    // "40712963" is out of range and the row cannot be edited or deleted at
    // all, while "00000001" resolves to whichever row happens to sit first.
    const digits: BlobMemory[] = [
      { id: "40712963", text: "Ken has a sister", createdAt: 1 },
      { id: "00000001", text: "Ken trains on Fridays", createdAt: 2 },
    ];

    const far = applyMemoryWrite(digits, { kind: "delete", ref: "40712963" });
    expect(far.outcome).toBe("deleted");
    expect(texts(far.memories)).toEqual(["Ken trains on Fridays"]);

    // Would be row 1 if read as a position; it is row 2's id.
    const low = applyMemoryWrite(digits, { kind: "delete", ref: "00000001" });
    expect(texts(low.memories)).toEqual(["Ken has a sister"]);

    // An id also wins for an edit, which is the same resolver.
    const edited = applyMemoryWrite(digits, {
      kind: "update",
      ref: "40712963",
      text: "Ken has two sisters",
    });
    expect(texts(edited.memories)).toEqual(["Ken has two sisters", "Ken trains on Fridays"]);

    // A bare position still addresses a row when it matches no id.
    expect(texts(applyMemoryWrite(digits, { kind: "delete", ref: "2" }).memories)).toEqual([
      "Ken has a sister",
    ]);
  });
});

describe("applyMemoryWrite: adopt (promotion between scopes)", () => {
  it("carries the fact's id and createdAt into the new scope", () => {
    const promoted = fact("Biscuit is a beagle");
    const result = applyMemoryWrite([fact("Ken codes")], { kind: "adopt", memory: promoted });
    expect(result.outcome).toBe("saved");
    expect(result.memories[1]).toMatchObject({
      id: promoted.id,
      text: promoted.text,
      createdAt: promoted.createdAt,
    });
  });

  it("reconciles on arrival, so promotion cannot import a contradiction", () => {
    // The panel used to append blindly: promoting "trains on Fridays" into a
    // shared scope that still said "Mondays" left every Blob reading both.
    const shared = [fact("Ken trains on Mondays")];
    const result = applyMemoryWrite(shared, {
      kind: "adopt",
      memory: fact("Ken trains on Fridays"),
    });
    expect(result.outcome).toBe("replaced");
    expect(texts(result.memories)).toEqual(["Ken trains on Fridays"]);
  });

  it("rejects a promotion the destination already knows", () => {
    // `changed: false` is what stops the caller deleting it from the source
    // scope — a rejected promotion must not lose the fact.
    const shared = [fact("Biscuit is a beagle")];
    const result = applyMemoryWrite(shared, {
      kind: "adopt",
      memory: fact("biscuit is a beagle"),
    });
    expect(result.outcome).toBe("duplicate");
    expect(result.changed).toBe(false);
  });
});

describe("scope isolation", () => {
  it("reconciles each scope only against itself", () => {
    // A Blob's private list and the shared list are separate arrays with
    // separate limits: writing one must never read or edit the other.
    const shared = [fact("Ken trains on Mondays")];
    const own = [fact("Ken trains on Mondays")];
    const result = applyMemoryWrite(own, { kind: "save", text: "Ken trains on Fridays" });
    expect(texts(result.memories)).toEqual(["Ken trains on Fridays"]);
    expect(texts(shared)).toEqual(["Ken trains on Mondays"]);
  });
});

describe("renderMemories", () => {
  it("numbers the Blob's own facts so 'forget 2' means row 2", () => {
    const rendered = renderMemories([fact("one thing"), fact("two thing")], { scope: "blob" });
    expect(rendered).toContain("- [1] one thing");
    expect(rendered).toContain("- [2] two thing");
  });

  it("leaves shared facts unnumbered, so only one list owns positions", () => {
    const rendered = renderMemories([fact("one thing")], { scope: "user" });
    expect(rendered).toContain("- one thing");
    expect(rendered).not.toContain("[1]");
  });

  it("drops the oldest facts first when the budget is tight", () => {
    const rendered = renderMemories([fact("oldest fact here"), fact("newest fact here")], {
      scope: "user",
      budget: 20,
    });
    expect(rendered).toContain("newest fact here");
    expect(rendered).not.toContain("oldest fact here");
  });

  it("renders nothing for an empty list or a spent budget", () => {
    expect(renderMemories([], { scope: "blob" })).toBe("");
    expect(renderMemories([fact("a thing")], { scope: "blob", budget: 0 })).toBe("");
  });
});
