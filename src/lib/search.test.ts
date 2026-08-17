import { describe, expect, it } from "vitest";
import type { Agent, Message } from "@/data/agents";
import { buildIndex, displayFileName, extractLinks, filterRows } from "@/lib/search";

const ken: Agent = {
  id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
  name: "Ken",
  time: "Now",
  snippet: "New Blob. Say hello",
  tone: "blue",
  shape: "sphere",
  lastActivityAt: 1_000,
};

const say = (id: string, text: string, timestampMs?: number): Message => ({
  id,
  kind: "text",
  author: "agent",
  segments: [{ text }],
  ...(timestampMs === undefined ? {} : { timestampMs }),
});

/** Same shape every test starts from; each one overrides the part it exercises. */
const index = (over: Partial<Parameters<typeof buildIndex>[0]> = {}) =>
  buildIndex({
    agents: [ken],
    transcripts: {},
    files: {},
    routines: {},
    hasChat: true,
    now: 2_000,
    ...over,
  });

describe("extractLinks", () => {
  it("takes the markdown label as the link's title", () => {
    expect(extractLinks("see [The Verge](https://theverge.com/story) for more")).toEqual([
      { url: "https://theverge.com/story", label: "The Verge" },
    ]);
  });

  it("keeps bare URLs and drops the sentence punctuation after them", () => {
    expect(extractLinks("read https://example.com/a/b, then stop.")).toEqual([
      { url: "https://example.com/a/b" },
    ]);
  });

  it("ignores every scheme but http(s)", () => {
    // A palette row hands its URL to the OS browser: file:, javascript: and
    // custom schemes must never reach that hand-off.
    const text = "file:///etc/passwd javascript:alert(1) blobbies://open ftp://host/x";
    expect(extractLinks(text)).toEqual([]);
  });

  it("reports each URL once per message", () => {
    const found = extractLinks("https://a.test/x and again https://a.test/x");
    expect(found).toHaveLength(1);
  });
});

describe("displayFileName", () => {
  it("hides the .txt we append to an extracted attachment", () => {
    expect(displayFileName("report.pdf.txt")).toBe("report.pdf");
    expect(displayFileName("notes.txt")).toBe("notes.txt");
    expect(displayFileName("Makefile")).toBe("Makefile");
  });
});

describe("buildIndex", () => {
  it("indexes a Blob's messages under that Blob", () => {
    const rows = index({
      transcripts: { [ken.id]: [say("m1", "AMYERA sunscreen, SPF50")] },
    }).message;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("AMYERA sunscreen, SPF50");
    expect(rows[0]?.kind === "message" && rows[0].blobId).toBe(ken.id);
  });

  it("shortens a long message but still finds a match deep inside it", () => {
    const long = `${"x".repeat(400)} needle`;
    const rows = index({ transcripts: { [ken.id]: [say("m1", long)] } }).message;
    expect(rows[0]?.title.length).toBeLessThan(250);
    expect(filterRows(rows, "needle")).toHaveLength(1);
  });

  it("collapses one URL seen in several messages into one row", () => {
    const rows = index({
      transcripts: {
        [ken.id]: [
          say("m1", "https://theverge.com/story", 10),
          say("m2", "[Rogue AI](https://theverge.com/story)", 20),
        ],
      },
    }).link;
    expect(rows).toHaveLength(1);
    // The newest sighting names it; without a label it falls back to the host.
    expect(rows[0]?.title).toBe("Rogue AI");
    expect(rows[0]?.subtitle).toBe("theverge.com/story");
  });

  it("keeps rows newest first", () => {
    const rows = index({
      transcripts: { [ken.id]: [say("m1", "older", 10), say("m2", "newer", 20)] },
    }).message;
    expect(rows.map((row) => row.title)).toEqual(["newer", "older"]);
  });

  it("lists a Blob's files by their attached name, never the stored one", () => {
    const rows = index({
      files: {
        [ken.id]: [
          { name: "report.pdf.txt", isDir: false, size: 2048, modifiedMs: 5 },
          { name: "notes", isDir: true, size: 0, modifiedMs: 6 },
        ],
      },
    }).file;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("report.pdf");
    expect(rows[0]?.subtitle).toBe("Ken · 2 KB");
  });

  it("has no groups to offer until group chats exist", () => {
    expect(index().group).toEqual([]);
  });

  it("offers Chat Settings only while a conversation is open", () => {
    const titles = (hasChat: boolean) => index({ hasChat }).action.map((row) => row.title);
    expect(titles(true)).toContain("Chat Settings");
    expect(titles(false)).not.toContain("Chat Settings");
  });

  it("never offers usage or billing", () => {
    // Deliberate: local inference has no bill, so there is nothing to bill for.
    const titles = index().action.map((row) => row.title.toLowerCase());
    expect(titles.some((title) => title.includes("billing") || title.includes("usage"))).toBe(
      false,
    );
  });
});

describe("filterRows", () => {
  it("matches title or subtitle, ignoring case", () => {
    const rows = index().blob;
    expect(filterRows(rows, "KEN")).toHaveLength(1);
    expect(filterRows(rows, "nobody")).toHaveLength(0);
    expect(filterRows(rows, "  ")).toHaveLength(1);
  });
});
