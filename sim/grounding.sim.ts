import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it } from "vitest";
import type { ToolTraceEntry } from "@/data/agents";
import { blobSystemPrompt, streamBlobTurn } from "@/lib/ai";
import { memoryHome } from "@/lib/home";
import { toolTraceMessages } from "@/lib/tool-trace";

/**
 * Grounding: does a Blob read the file, or make its contents up?
 *
 * Measured in sim/stress.sim.ts (2026-08-25, deepseek on Tinfoil): partway
 * through a burst, turns stopped calling `read_file` and answered anyway —
 * confidently, in detail, and wrong. A note reading "Tokyo, 12-19 March" was
 * reported as a Boston-to-SFO trip with a Marriott booking; "milk, eggs" came
 * back as "milk, eggs, bread, dry cleaning".
 *
 * Worse than the stall it was found next to. A stall is visible: the user sees
 * nothing happened and asks again. This looks exactly like an answer.
 *
 * The pattern is what makes it a real bug rather than model noise: it does not
 * happen on turn 1. It starts once earlier turns have put real file contents
 * in the transcript — from there the shape of "assistant reports what a file
 * says" is established, and the model completes the pattern instead of
 * fetching the data. So every case here asks about file B *after* file A has
 * been read, which is the state that triggers it.
 *
 *   pnpm sim:grounding
 *   SIM_MODEL=tinfoil:deepseek-v4-flash TINFOIL_API_KEY=... pnpm sim:grounding
 *   SIM_THINKING=on pnpm sim:grounding
 */

const MODEL = process.env.SIM_MODEL ?? "qwen3.5:9b";
const THINKING = process.env.SIM_THINKING === "on";
/** Repeats: confabulation is intermittent, so one clean run proves nothing. */
const RUNS = Number(process.env.SIM_RUNS ?? "3");
const TURN_TIMEOUT_MS = 180_000;

const USER = { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" };
const BLOB = {
  name: "Filer",
  title: "Inbox keeper",
  description: "Watches Ken's notes folder and reports what changed.",
};

/**
 * Contents chosen to be unguessable: a model inventing a plausible trip note
 * will not land on Tokyo in March by chance, and a grocery list is exactly the
 * kind of thing it will happily pad with bread and eggs.
 */
async function seededHome() {
  const home = memoryHome("9c4f1b22-77a0-4a1e-8d3b-51e0c9f4a7b6");
  await home.write("notes/standup.md", "Shipped the recap feature. Blocked on the Linux build.");
  await home.write("notes/groceries.md", "milk, eggs");
  await home.write("notes/trip.md", "Tokyo, 12-19 March. Book the ryokan.");
  return home;
}

interface Grounded {
  ask: string;
  reply: string;
  tools: string[];
  /** Did this turn actually go and look? */
  read: boolean;
  /** Reported contents without reading, and got them wrong. */
  invented: boolean;
}

/**
 * Reads one file to establish the pattern, then asks about a different one.
 * The second turn is what is scored.
 */
async function secondFileTurn(warmUp: string, ask: string, must: RegExp): Promise<Grounded> {
  const home = await seededHome();
  const system = { role: "system" as const, content: blobSystemPrompt(BLOB, USER) };
  const history: Message[] = [{ role: "user", content: warmUp }];
  const shared = {
    model: MODEL,
    thinking: THINKING,
    home,
    // Pre-classified so the intent router does not fire a request of its own.
    intent: { action: "none" as const },
    memory: { list: () => [], save: () => {} },
    onSegment: () => {},
    onConfigure: () => {},
  };

  // What the first turn actually did. Dropped from the stored transcript
  // originally (App.tsx rebuilt history from text messages only), which is the
  // hypothesis under test: with no trace of the call, turn 1 reads back as
  // "assistant stated a file's contents having called nothing", and turn 2
  // copies that.
  const firstCalls: ToolTraceEntry[] = [];
  const first = await streamBlobTurn({
    ...shared,
    messages: [system, ...history],
    onToolCall: (call) => {
      firstCalls.push({
        name: call.name,
        args: JSON.stringify(call.args),
        result: call.result,
        failed: call.isError,
      });
    },
  });
  // Exactly what App.tsx replays into history (see `Message.toolTrace`) — the
  // same builder, so this measures the shipped behaviour rather than an
  // approximation of it. SIM_TRACE=0 reproduces the old text-only history that
  // measured 3/6 invented.
  const trace = process.env.SIM_TRACE === "0" ? [] : toolTraceMessages(firstCalls, "sim");
  history.push(...trace, { role: "assistant", content: first }, { role: "user", content: ask });

  const tools: string[] = [];
  const reply = await streamBlobTurn({
    ...shared,
    messages: [system, ...history],
    onToolCall: (call) => tools.push(call.name),
  });
  const read = tools.includes("read_file");
  return {
    ask,
    reply,
    tools,
    read,
    // Only a reply that claims to report the file counts. "I could not find
    // it" is a legitimate answer; a confident wrong one is the bug.
    invented:
      !must.test(reply) &&
      !/(?:can(?:'|no)?t|couldn't|unable|no such|not find|doesn't exist|empty)/i.test(reply),
  };
}

describe(`grounding (${MODEL}, thinking ${THINKING ? "on" : "off"})`, () => {
  it(
    "reads the second file instead of completing the pattern from the first",
    async () => {
      const cases = [
        {
          warmUp: "What's in my standup note?",
          ask: "Now the trip note — what does it say?",
          must: /tokyo|ryokan|march/i,
        },
        {
          warmUp: "What's in my standup note?",
          ask: "And the groceries one?",
          // The exact list. Anything else is padding it invented.
          must: /milk.{0,10}eggs/i,
        },
      ];
      const results: Grounded[] = [];
      for (const item of cases) {
        for (let run = 0; run < RUNS; run += 1) {
          results.push(await secondFileTurn(item.warmUp, item.ask, item.must));
        }
      }
      for (const result of results) {
        const mark = result.invented ? "INVNT" : result.read ? "  ok " : " noio";
        console.log(
          `${mark} ${result.ask.slice(0, 38).padEnd(40)}[${result.tools.join(", ")}]\n` +
            `      ${result.reply.replace(/\s+/g, " ").slice(0, 120)}`,
        );
      }

      const invented = results.filter((result) => result.invented);
      expect(
        invented.map((result) => `${result.ask} -> ${result.reply.slice(0, 140)}`),
        "turns that reported file contents the file does not contain",
      ).toEqual([]);
      // Reading is the mechanism; scored separately so a pass that got lucky
      // on wording still fails if the Blob never actually looked.
      const blind = results.filter((result) => !result.read);
      expect(
        blind.map((result) => result.ask),
        "turns that answered about a file without reading it",
      ).toEqual([]);
    },
    TURN_TIMEOUT_MS * 12,
  );
});
