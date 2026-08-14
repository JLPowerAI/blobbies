import { describe, expect, it, vi } from "vitest";
import {
  type BlobMemory,
  htmlToText,
  makeBlobTools,
  parseDdgLite,
  renderMemories,
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

  it("renders memories into the prompt with their ids", () => {
    const block = renderMemories([{ id: "abc123", text: "Likes pigeons", createdAt: 1 }]);
    expect(block).toContain("[abc123] Likes pigeons");
    expect(renderMemories([])).toBe("");
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
