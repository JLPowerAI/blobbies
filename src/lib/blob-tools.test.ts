import { describe, expect, it, vi } from "vitest";
import {
  type BlobMemory,
  htmlToText,
  MEMORY_LIMIT,
  MEMORY_PROMPT_CHARS,
  MEMORY_TEXT_LIMIT,
  makeBlobTools,
  parseDdgLite,
  renderMemories,
  resolveMemory,
} from "@/lib/blob-tools";

const context = { signal: new AbortController().signal, toolCallId: "t1" };

describe("blob tools", () => {
  it("remember and forget mutate the blob's memory store", async () => {
    let stored: BlobMemory[] = [];
    const tools = makeBlobTools({
      list: () => stored,
      save: (next) => {
        stored = next;
      },
    });
    const remember = tools.find((tool) => tool.name === "remember");
    const forget = tools.find((tool) => tool.name === "forget");

    await remember?.execute({ text: "Ken prefers short replies" }, context);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe("Ken prefers short replies");

    // Exact duplicates are refused.
    const duplicate = await remember?.execute({ text: "Ken prefers short replies" }, context);
    expect(duplicate).toBe("Already remembered.");
    expect(stored).toHaveLength(1);

    const id = stored[0]?.id ?? "";
    await forget?.execute({ id }, context);
    expect(stored).toHaveLength(0);
  });

  it("update_memory revises a fact in place instead of adding a contradiction", async () => {
    let stored: BlobMemory[] = [];
    const tools = makeBlobTools({
      list: () => stored,
      save: (next) => {
        stored = next;
      },
    });
    const remember = tools.find((tool) => tool.name === "remember");
    const update = tools.find((tool) => tool.name === "update_memory");

    await remember?.execute({ text: "Ken prefers short replies" }, context);
    const id = stored[0]?.id ?? "";
    const createdAt = stored[0]?.createdAt ?? 0;

    await update?.execute({ id, text: "Ken prefers long replies" }, context);
    // One memory, not two contradicting ones.
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe("Ken prefers long replies");
    expect(stored[0]?.createdAt).toBe(createdAt);
    expect(stored[0]?.updatedAt).toBeGreaterThanOrEqual(createdAt);

    const missing = await update?.execute({ id: "nope", text: "x" }, context);
    expect(missing).toContain("No memory nope");
  });

  it("renders memories by position, which small models can actually cite", () => {
    const block = renderMemories([
      { id: "abc123", text: "Likes pigeons", createdAt: 1 },
      { id: "def456", text: "Dislikes mornings", createdAt: 2 },
    ]);
    expect(block).toContain("[1] Likes pigeons");
    expect(block).toContain("[2] Dislikes mornings");
    // The opaque id is never shown: the sim caught models inventing them.
    expect(block).not.toContain("abc123");
    expect(renderMemories([])).toBe("");
  });

  it("resolves a memory by position, id, or quoted text", () => {
    const memories: BlobMemory[] = [
      { id: "abc123", text: "Likes pigeons", createdAt: 1 },
      { id: "def456", text: "Dislikes mornings", createdAt: 2 },
    ];
    expect(resolveMemory(memories, "2")?.id).toBe("def456");
    expect(resolveMemory(memories, "[2]")?.id).toBe("def456");
    expect(resolveMemory(memories, "abc123")?.id).toBe("abc123");
    expect(resolveMemory(memories, "pigeons")?.id).toBe("abc123");
    expect(resolveMemory(memories, "9")).toBeUndefined();
    expect(resolveMemory(memories, "")).toBeUndefined();
  });

  it("supersedes a restated fact instead of storing both", async () => {
    let stored: BlobMemory[] = [
      { id: "aaa11111", text: "Ken trains on Mondays and Thursdays", createdAt: 1 },
    ];
    const tools = makeBlobTools({
      list: () => stored,
      save: (next) => {
        stored = next;
      },
    });
    const remember = tools.find((tool) => tool.name === "remember");

    // Small models reach for `remember` when correcting; the outcome must
    // still be one coherent fact, not two contradicting ones.
    await remember?.execute({ text: "Ken trains on Tuesdays and Fridays" }, context);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe("Ken trains on Tuesdays and Fridays");

    // A correction still merges when the model rewords the subject, which the
    // sim caught it doing ("Ken" -> "the user").
    await remember?.execute({ text: "the user trains on Saturdays" }, context);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe("the user trains on Saturdays");

    // An unrelated fact is still added alongside.
    await remember?.execute({ text: "Ken has a sister called Mia" }, context);
    expect(stored).toHaveLength(2);
  });

  it("budgets the memory block so it cannot overrun a local context window", () => {
    // Worst case the store allows: every slot filled to the text cap.
    const full: BlobMemory[] = Array.from({ length: MEMORY_LIMIT }, (_, index) => ({
      id: `id${index}`,
      text: "x".repeat(MEMORY_TEXT_LIMIT),
      createdAt: index,
    }));
    const block = renderMemories(full);
    expect(block.length).toBeLessThanOrEqual(MEMORY_PROMPT_CHARS + 200);
    // Newest survive the budget, oldest are dropped.
    expect(block).toContain(`[${MEMORY_LIMIT}]`);
    expect(block).not.toContain("[1]");
  });

  it("web_fetch refuses non-https and malformed URLs", async () => {
    const tools = makeBlobTools({ list: () => [], save: () => {} });
    const webFetch = tools.find((tool) => tool.name === "web_fetch");
    const insecure = await webFetch?.execute({ url: "http://169.254.169.254/latest" }, context);
    expect(insecure).toBe("Only valid https:// URLs can be fetched.");
    // Malformed model output must return an error string, not throw.
    const malformed = await webFetch?.execute({ url: "not a url at all" }, context);
    expect(malformed).toBe("Only valid https:// URLs can be fetched.");
  });

  it("web_fetch refuses a host that is not verified public, without requesting it", async () => {
    // The resolved-address check fails closed when it cannot run (here: no
    // Tauri IPC), so no request may leave even for a well-formed https URL.
    const fetchSpy = vi.fn(async () => new Response("<p>secret</p>"));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const tools = makeBlobTools({ list: () => [], save: () => {} });
      const webFetch = tools.find((tool) => tool.name === "web_fetch");
      const result = await webFetch?.execute({ url: "https://internal.example.com/" }, context);
      expect(result).toBe("That host is not on the public internet, so it cannot be fetched.");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("strips markup and parses DDG Lite results", () => {
    expect(htmlToText("<p>Hello <script>evil()</script><b>world</b></p>")).toBe("Hello world");
    const html = `<table><tr><td><a class="result-link" href="https://example.com">Example</a></td></tr>
      <tr><td class="result-snippet">A snippet.</td></tr></table>`;
    const hits = parseDdgLite(html);
    expect(hits).toEqual([{ title: "Example", url: "https://example.com", snippet: "A snippet." }]);
  });
});
