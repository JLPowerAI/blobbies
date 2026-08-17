import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";

const kinds = (text: string) => splitMarkdownBlocks(text).map((block) => block.kind);

const TABLE = ["| Date | Model |", "| --- | --- |", "| Aug 14 | GLM-5.3 |"].join("\n");

describe("splitMarkdownBlocks", () => {
  it("leaves a reply without a table as one block", () => {
    const blocks = splitMarkdownBlocks("Just some prose.\n\nAnd more.");
    expect(blocks).toEqual([{ kind: "text", text: "Just some prose.\n\nAnd more.", line: 0 }]);
  });

  it("lifts a table out of the prose around it", () => {
    expect(kinds(`Here you go:\n\n${TABLE}\n\nAnything else?`)).toEqual(["text", "table", "text"]);
  });

  it("keeps the table's own rows together", () => {
    const table = splitMarkdownBlocks(`Intro\n\n${TABLE}`).find((block) => block.kind === "table");
    expect(table?.text).toBe(TABLE);
  });

  it("handles a reply that is nothing but a table", () => {
    expect(kinds(TABLE)).toEqual(["table"]);
  });

  it("splits two tables into two blocks", () => {
    expect(kinds(`${TABLE}\n\nBetween.\n\n${TABLE}`)).toEqual(["table", "text", "table"]);
  });

  it("ignores a table inside a code fence", () => {
    // Sample markdown in a code block is text the user asked to see, not a
    // table to render.
    expect(kinds(`Like this:\n\n\`\`\`md\n${TABLE}\n\`\`\`\n\nSee?`)).toEqual(["text"]);
  });

  it("needs the delimiter row, not just pipes", () => {
    // A sentence with a pipe in it is prose.
    expect(kinds("Run `a | b` and check.")).toEqual(["text"]);
    expect(kinds("| not | a table |\n| still not |")).toEqual(["text"]);
    // A horizontal rule matches the delimiter shape on its own, so the row
    // above it must not become a header just for containing a pipe.
    expect(kinds("Pipes | here\n---\nMore.")).toEqual(["text"]);
  });

  it("gives each block a start line that survives more text arriving", () => {
    // Blocks are keyed by this while a reply streams, so an earlier block's
    // identity must not shift when the model appends.
    const partial = splitMarkdownBlocks(`Intro\n\n${TABLE}`);
    const full = splitMarkdownBlocks(`Intro\n\n${TABLE}\n\nOutro`);
    expect(full.slice(0, 2).map((block) => block.line)).toEqual(partial.map((block) => block.line));
  });
});
