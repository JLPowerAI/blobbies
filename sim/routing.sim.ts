import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it } from "vitest";
import { blobSystemPrompt, streamBlobTurn } from "@/lib/ai";
import { memoryHome } from "@/lib/home";

/**
 * Routing: does a Blob use the app it is connected to, or fall back to search?
 *
 * Reported live (2026-08-25): a Blob configured as a YouTube agent, with
 * YouTube connected over Composio, asked for new videos — noticed it had the
 * tool, and ran `web_search` anyway. In the same conversation where it had
 * already used the app. Search is not wrong in general; it is wrong when the
 * user asked for the one thing the connected app owns.
 *
 * The cause was ranking, not naming. `blobSystemPrompt` listed the connected
 * apps and named `app_find_tool` as the route in, but nothing said the app
 * *outranks* `web_search` — and `web_search` heads the Tools catalog, reading
 * as the default for anything look-it-up shaped. "Find me videos" is exactly
 * that shape.
 *
 * Scored on the FIRST tool the turn reaches for, which is the routing decision
 * itself. What happens after does not matter here: Composio is not configured
 * in the sim, so `app_find_tool` fails — by then the choice is already made
 * and recorded, which is all this measures.
 *
 *   pnpm sim:routing
 *   SIM_MODEL=tinfoil:deepseek-v4-flash TINFOIL_API_KEY=... pnpm sim:routing
 *   SIM_THINKING=on pnpm sim:routing
 */

const MODEL = process.env.SIM_MODEL ?? "qwen3.5:9b";
const THINKING = process.env.SIM_THINKING === "on";
/** Repeats per prompt: a routing slip is intermittent, so once proves little. */
const RUNS = Number(process.env.SIM_RUNS ?? "3");
const TURN_TIMEOUT_MS = 180_000;

const USER = { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" };

/** Configured exactly as the reported Blob was: a YouTube agent, YouTube connected. */
const BLOB = {
  name: "YouTuber",
  title: "YouTube scout",
  description: "Finds Ken new videos worth watching on YouTube.",
};
const CONNECTED = ["YouTube"];

interface Routed {
  say: string;
  first: string;
  tools: string[];
  reply: string;
}

async function routeOf(prompt: string): Promise<Routed> {
  const tools: string[] = [];
  const history: Message[] = [{ role: "user", content: prompt }];
  const reply = await streamBlobTurn({
    model: MODEL,
    messages: [
      {
        role: "system",
        content: blobSystemPrompt(BLOB, USER, { connectedApps: CONNECTED, appsReachable: true }),
      },
      ...history,
    ],
    thinking: THINKING,
    home: memoryHome(),
    hasConnectedApps: true,
    // Pre-classified so the intent router does not fire a request of its own.
    intent: { action: "none" },
    memory: { list: () => [], save: () => {} },
    onSegment: () => {},
    onConfigure: () => {},
    onToolCall: (call) => tools.push(call.name),
  });
  return { say: prompt, first: tools[0] ?? "(none)", tools, reply };
}

describe(`routing (${MODEL}, thinking ${THINKING ? "on" : "off"})`, () => {
  it(
    "reaches for the connected app, not web_search, when asked for its content",
    async () => {
      // All three are the same shape as the reported message: a request for
      // content YouTube owns, phrased the way a person actually types it.
      const prompts = [
        "any new vids I should look into? check it out",
        "find me some videos on AI agents",
        "what's worth watching right now?",
      ];
      const results: Routed[] = [];
      for (const prompt of prompts) {
        for (let run = 0; run < RUNS; run += 1) {
          results.push(await routeOf(prompt));
        }
      }
      for (const result of results) {
        const mark = result.first.startsWith("app_") ? "  ok " : "SEARCH";
        console.log(
          `${mark} ${result.say.slice(0, 40).padEnd(42)} first=${result.first.padEnd(16)}` +
            `[${result.tools.join(", ")}]`,
        );
      }

      // web_search first IS the bug: the app was connected, named in the
      // prompt, and owns exactly what was asked for.
      const searched = results.filter((result) => result.first === "web_search");
      expect(
        searched.map((result) => result.say),
        "turns that searched the web for content the connected app owns",
      ).toEqual([]);
    },
    TURN_TIMEOUT_MS * 9,
  );

  it(
    "still uses web_search for what no connected app owns",
    async () => {
      // The guard against overcorrecting: a YouTube Blob asked a plain factual
      // question must not go hunting through YouTube for it.
      const result = await routeOf("what's the current version of Node's LTS release?");
      console.log(`  ..  ${result.say.slice(0, 40).padEnd(42)} first=${result.first}`);
      expect(result.first).not.toMatch(/^app_/);
    },
    TURN_TIMEOUT_MS,
  );
});
