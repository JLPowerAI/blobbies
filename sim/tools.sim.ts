import { describe, expect, it } from "vitest";
import { makeBlobTools } from "@/lib/blob-tools";

/**
 * Live tool probe: every tool a Blob can call, exercised against the real
 * internet and a real memory store.
 *
 * The behaviour scorecard (agent.sim.ts) only proves the model *chooses* a
 * tool. This proves the tools themselves work end to end — a search that
 * returns nothing, or a fetch that silently fails, looks identical to a model
 * that decided not to bother.
 *
 *   pnpm sim:tools
 *
 * Requires network access. Skipped automatically when offline.
 */

const TIMEOUT_MS = 60_000;
const context = { signal: new AbortController().signal, toolCallId: "t1" };

/** Tools bound to an in-memory store, as a Blob would have them. */
function toolset() {
  let stored: Parameters<Parameters<typeof makeBlobTools>[0]["save"]>[0] = [];
  const tools = makeBlobTools({
    list: () => stored,
    save: (next) => {
      stored = next;
    },
  });
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        throw new Error(`no such tool: ${name}`);
      }
      return String(await tool.execute(args, context));
    },
    stored: () => stored,
  };
}

describe("live tools", () => {
  it(
    "web_search returns real results with titles and URLs",
    async () => {
      const result = await toolset().call("web_search", { query: "ollama local llm" });
      console.log(`   web_search -> ${result.replace(/\s+/g, " ").slice(0, 200)}`);
      expect(result).not.toMatch(/^Search failed/);
      expect(result).not.toBe("No results found.");
      // Shape: "- title\n  https://...\n  snippet"
      expect(result).toMatch(/https?:\/\/\S+/);
    },
    TIMEOUT_MS,
  );

  it(
    "web_fetch reads a real page as text",
    async () => {
      const result = await toolset().call("web_fetch", { url: "https://example.com/" });
      console.log(`   web_fetch -> ${result.replace(/\s+/g, " ").slice(0, 160)}`);
      expect(result).toContain("EXTERNAL_UNTRUSTED_CONTENT");
      expect(result.toLowerCase()).toContain("example domain");
    },
    TIMEOUT_MS,
  );

  it(
    "web_fetch refuses a host that is not on the public internet",
    async () => {
      // Blobbies' own Ollama endpoint: reachable, but must never be fetchable.
      const result = await toolset().call("web_fetch", { url: "https://127.0.0.1:11434/" });
      console.log(`   web_fetch(local) -> ${result.slice(0, 90)}`);
      expect(result).toContain("not on the public internet");
    },
    TIMEOUT_MS,
  );

  it(
    "search then fetch: the pipeline a Blob actually runs",
    async () => {
      const tools = toolset();
      const search = await tools.call("web_search", { query: "example domain iana" });
      const url = /https?:\/\/\S+/.exec(search)?.[0];
      expect(url, "search returned no URL to follow").toBeDefined();
      const page = await tools.call("web_fetch", { url: url ?? "" });
      console.log(`   pipeline -> followed ${url} -> ${page.length} chars`);
      expect(page.length).toBeGreaterThan(40);
    },
    TIMEOUT_MS * 2,
  );

  it(
    "memory tools round-trip: remember, update, forget",
    async () => {
      const tools = toolset();
      await tools.call("remember", { text: "the user trains on Mondays" });
      await tools.call("remember", { text: "the user has a sister called Mia" });
      expect(tools.stored()).toHaveLength(2);

      await tools.call("update_memory", { id: "1", text: "the user trains on Fridays" });
      expect(tools.stored()[0]?.text).toBe("the user trains on Fridays");

      await tools.call("forget", { id: "2" });
      expect(tools.stored()).toHaveLength(1);
      console.log(`   memory -> ${JSON.stringify(tools.stored().map((m) => m.text))}`);
    },
    TIMEOUT_MS,
  );
});
