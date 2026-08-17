/**
 * Splits an agent reply into the parts that should render as separate bubbles.
 *
 * A GFM table inside a chat bubble is the wrong shape: the bubble hugs its
 * text and caps at a fraction of the pane, so a five-column table gets
 * squeezed until headers wrap mid-word. Lifting each table into its own block
 * lets it size to its content and scroll on its own, and leaves the prose
 * around it in normal bubbles.
 */

export interface MarkdownBlock {
  kind: "text" | "table";
  text: string;
  /**
   * Line the block starts on. A stable identity while a reply streams: text
   * is appended at the end, so an earlier block's start never moves.
   */
  line: number;
}

/** A GFM delimiter row: `| --- | :--: |`, which is what makes a table a table. */
const DELIMITER_ROW = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** A row must contain a pipe that is not escaped. */
function looksLikeRow(line: string): boolean {
  return /(^|[^\\])\|/.test(line);
}

/** Opens or closes a fenced code block (``` or ~~~). */
function isFence(line: string): boolean {
  return /^\s{0,3}(`{3,}|~{3,})/.test(line);
}

/**
 * Prose and tables, in order, with empty parts dropped.
 *
 * Returns a single text block when there is no table, so the common reply
 * costs one array allocation and renders exactly as before.
 */
export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  if (!text.includes("|")) {
    return [{ kind: "text", text, line: 0 }];
  }
  const lines = text.split("\n");
  const blocks: MarkdownBlock[] = [];
  let buffer: string[] = [];
  let kind = "text" as MarkdownBlock["kind"];
  /** Inside a fenced code block a pipe table is sample text, not a table. */
  let fenced = false;

  let start = 0;
  const flush = (next: MarkdownBlock["kind"], at: number) => {
    const joined = buffer.join("\n").trim();
    if (joined !== "") {
      blocks.push({ kind, text: joined, line: start });
    }
    buffer = [];
    kind = next;
    start = at;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isFence(line)) {
      fenced = !fenced;
    }
    // A table starts at a header row whose next line is the delimiter.
    const startsTable =
      !fenced &&
      kind === "text" &&
      looksLikeRow(line) &&
      DELIMITER_ROW.test(lines[index + 1] ?? "") &&
      looksLikeRow(lines[index + 1] ?? "");
    if (startsTable) {
      flush("table", index);
    } else if (kind === "table" && (fenced || !looksLikeRow(line))) {
      // The table ends at the first line that is not a row.
      flush("text", index);
    }
    buffer.push(line);
  }
  flush("text", lines.length);
  return blocks.length === 0 ? [{ kind: "text", text, line: 0 }] : blocks;
}
