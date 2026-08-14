import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OLLAMA_URL } from "@/lib/ollama";

/**
 * Capability probe: does a candidate model actually do the things Blobbies
 * needs, before it is worth running the full behaviour scorecard on it?
 *
 * Ollama's library tags a model "vision" or "tools", but the tag says nothing
 * about whether the model is any good at either, and nothing at all about
 * whether it can fill a JSON grammar — which is what Blobbies' intent router
 * depends on. This measures all three against the running server.
 *
 *   SIM_MODEL=ministral-3:3b pnpm sim:caps
 */

const MODEL = process.env.SIM_MODEL ?? "qwen3.5:2b";
const PROBE_TIMEOUT_MS = 180_000;

/**
 * A real screenshot from the repo: text, UI chrome and colour, like anything
 * a user would actually share with a Blob.
 */
function testImageBase64(): string {
  // process.cwd(), not import.meta.url: under Vite the module URL is an http
  // URL, which fileURLToPath rejects.
  return readFileSync(`${process.cwd()}/.gg/screenshots/ctxmenu.png`).toString("base64");
}

interface ChatResult {
  content: string;
  toolCalls: { function?: { name?: string } }[];
  ms: number;
}

async function chat(body: Record<string, unknown>): Promise<ChatResult> {
  const started = Date.now();
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: false, think: false, ...body }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const payload = (await response.json()) as {
    message?: { content?: string; tool_calls?: { function?: { name?: string } }[] };
  };
  return {
    content: payload.message?.content ?? "",
    toolCalls: payload.message?.tool_calls ?? [],
    ms: Date.now() - started,
  };
}

describe(`capabilities (${MODEL})`, () => {
  it(
    "reads an image",
    async () => {
      const result = await chat({
        messages: [
          {
            role: "user",
            content:
              "This is a screenshot of an app. List the menu items you can read, exactly as written.",
            images: [testImageBase64()],
          },
        ],
      });
      console.log(
        `   vision (${result.ms}ms): ${result.content.replace(/\s+/g, " ").slice(0, 220)}`,
      );
      // The screenshot's context menu contains these entries; a model that
      // cannot read them is not usable for the image work Blobbies needs.
      const hits = ["pin", "duplicate", "delete", "unread"].filter((word) =>
        result.content.toLowerCase().includes(word),
      );
      expect(hits.length, `only matched ${JSON.stringify(hits)}`).toBeGreaterThanOrEqual(2);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "calls a tool when asked to",
    async () => {
      const result = await chat({
        messages: [
          { role: "system", content: "You are a personal assistant with a memory." },
          { role: "user", content: "Remember that I train on Mondays and Thursdays." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "remember",
              description: "Save a lasting fact about the user.",
              parameters: {
                type: "object",
                required: ["text"],
                properties: { text: { type: "string" } },
              },
            },
          },
        ],
      });
      console.log(
        `   tools (${result.ms}ms): ${JSON.stringify(result.toolCalls.map((c) => c.function?.name))}`,
      );
      expect(result.toolCalls.map((call) => call.function?.name)).toContain("remember");
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "fills a JSON grammar, which the intent router depends on",
    async () => {
      const result = await chat({
        // The real router prompt, trimmed: an unguided classifier tests the
        // prompt, not the model's ability to satisfy a grammar.
        messages: [
          {
            role: "system",
            content:
              "You classify the user's last message for a personal assistant.\n" +
              "save_fact -> the user states a lasting fact about themselves.\n" +
              "delete_fact -> the user asks you to forget or delete something you saved.\n" +
              "change_job -> the user wants you to be a different kind of assistant.\n" +
              "none -> questions, greetings, thanks.\n\n" +
              "Your saved memories:\n- [1] the user is allergic to peanuts",
          },
          { role: "user", content: "Forget what you know about my allergies." },
        ],
        format: {
          type: "object",
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["none", "save_fact", "delete_fact", "change_job"] },
          },
        },
      });
      const parsed = JSON.parse(result.content) as { action?: string };
      console.log(`   grammar (${result.ms}ms): ${result.content.slice(0, 80)}`);
      expect(parsed.action).toBe("delete_fact");
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "reads a file's contents handed to it as text",
    async () => {
      // File reading in Blobbies is a tool that pastes text into the prompt,
      // so the real question is whether the model answers from it faithfully.
      const fileText =
        "INVOICE 4417\nCustomer: Mia Chen\nDue: 2026-09-01\nAmount: 2,480.00 EUR\nStatus: unpaid";
      const result = await chat({
        messages: [
          {
            role: "user",
            content: `Here is a file:\n${fileText}\n\nWhat is the amount due and for whom? Answer in one line.`,
          },
        ],
      });
      console.log(`   file (${result.ms}ms): ${result.content.replace(/\s+/g, " ").slice(0, 140)}`);
      expect(result.content).toContain("2,480");
      expect(result.content.toLowerCase()).toContain("mia");
    },
    PROBE_TIMEOUT_MS,
  );
});
