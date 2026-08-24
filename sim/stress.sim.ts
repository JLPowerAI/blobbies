import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it } from "vitest";
import { announcesIntent, streamBlobTurn } from "@/lib/ai";
import { memoryHome } from "@/lib/home";
import { blobSystemPrompt } from "@/lib/prompt";

/**
 * Stress: does a Blob keep answering under a burst of prompts?
 *
 * The bug this exists for, reported live on Tinfoil (2026-08-25): the Blob
 * announces work and stops. Verbatim, with a YouTube MCP tool connected:
 *
 *   "Let me check the search schema and the current time, then run parallel
 *    searches."   — end of turn, no searches, ever.
 *
 * Two things that first looked true and are not:
 *
 * - **"Only with thinking off."** Reported that way, then reproduced with
 *   reasoning ON in the same conversation. Both settings are exercised here;
 *   thinking off is merely the default because it is cheaper.
 * - **"Only when it called no tools."** The first fix stood the nudge down for
 *   any turn that used a tool. The reported stall had *fetched the tool
 *   schema* and then promised the searches, so the nudge never fired. What
 *   matters is what the reply ENDS on, not what happened earlier in it.
 *
 * Three failure modes, all scored:
 *
 * 1. **The announcement stall.** The reply's last paragraph promises work.
 *    `streamBlobTurn` sends it back once (see `announcesIntent`), so a reply
 *    that still ends on a promise is a real regression.
 * 2. **Confabulation.** No tool called and the reply reports file contents the
 *    file does not contain — worse than a stall, because it looks like an
 *    answer. Scored by `must` below.
 * 3. **The dropped follow-up.** A prompt typed while a turn is running rides
 *    in as a steering message. If the loop never drains it, the message sits
 *    in the transcript unanswered — indistinguishable, from outside, from a
 *    stall.
 *
 *   pnpm sim:stress
 *   SIM_MODEL=tinfoil:deepseek-v4-flash TINFOIL_API_KEY=... pnpm sim:stress
 *   SIM_THINKING=on pnpm sim:stress    # reproduced with reasoning on too
 */

const MODEL = process.env.SIM_MODEL ?? "qwen3.5:9b";
/** Off by default because it is cheaper — the stall shows up either way. */
const THINKING = process.env.SIM_THINKING === "on";
/** How many prompts the burst fires at one conversation. */
const BURST = Number(process.env.SIM_BURST ?? "6");
const TURN_TIMEOUT_MS = 180_000;

const USER = { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" };

const BLOB = {
  name: "Filer",
  title: "Inbox keeper",
  description: "Watches Ken's notes folder and reports what changed.",
};

/** A home with something real to find, so "did it do the work" is checkable. */
async function seededHome() {
  const home = memoryHome("2f3d9a10-6b71-4d4e-9a2f-0c1d4e8b7a33");
  await home.write("notes/standup.md", "Shipped the recap feature. Blocked on the Linux build.");
  await home.write("notes/groceries.md", "milk, eggs");
  await home.write("notes/trip.md", "Tokyo, 12-19 March. Book the ryokan.");
  return home;
}

interface TurnResult {
  say: string;
  reply: string;
  tools: string[];
  ms: number;
  /** A reply that only promised work and never did any. */
  stalled: boolean;
  /** A reply that reported file contents the file does not contain. */
  invented: boolean;
}

/** One turn on a running transcript, wired the way App.tsx wires a chat turn. */
async function say(
  history: Message[],
  home: Awaited<ReturnType<typeof seededHome>>,
  text: string,
  steering?: () => Message[] | null,
): Promise<TurnResult> {
  history.push({ role: "user", content: text });
  const tools: string[] = [];
  const started = Date.now();
  const reply = await streamBlobTurn({
    model: MODEL,
    messages: [{ role: "system", content: blobSystemPrompt(BLOB, USER) }, ...history],
    thinking: THINKING,
    home,
    memory: { list: () => [], save: () => {} },
    onSegment: () => {},
    onConfigure: () => {},
    onToolCall: (call) => tools.push(call.name),
    ...(steering === undefined ? {} : { getSteeringMessages: steering }),
  });
  history.push({ role: "assistant", content: reply });
  return {
    say: text,
    reply,
    tools,
    ms: Date.now() - started,
    // Promised and never delivered. Judged on both halves on purpose: a reply
    // that used tools and then said "I'll keep an eye on it" is fine.
    stalled: reply.trim() === "" || (tools.length === 0 && announcesIntent(reply)),
    // Set by the caller, which knows what the file actually says.
    invented: false,
  };
}

function report(results: TurnResult[]): string {
  return results
    .map((result, index) => {
      const mark = result.stalled ? "STALL" : result.invented ? "INVNT" : "  ok ";
      return (
        `${mark} ${String(index + 1).padStart(2)}. ${result.say.slice(0, 44).padEnd(46)}` +
        `${String(Math.round(result.ms / 1000)).padStart(3)}s  ` +
        `[${result.tools.join(", ")}]\n        ${result.reply.replace(/\s+/g, " ").slice(0, 140)}`
      );
    })
    .join("\n");
}

describe(`stress (${MODEL}, thinking ${THINKING ? "on" : "off"})`, () => {
  it(
    `answers ${BURST} prompts back to back without stalling on a promise`,
    async () => {
      const home = await seededHome();
      const history: Message[] = [];
      // Mixed on purpose: tool work, plain chat, and the short imperatives
      // ("do it", "and the other one") that a burst is actually made of —
      // those are the ones observed to come back as a bare announcement.
      //
      // `must` is the groundedness check: a phrase that can only come from
      // the seeded file. Measured on Tinfoil with thinking off (2026-08-25):
      // turns 2-4 of a burst called no tool at all and reported a confident,
      // wholly invented trip note ("BOS → SFO, Marriott Downtown") for a file
      // that says "Tokyo, 12-19 March". Stall-free and worse than a stall —
      // so the burst scores what the reply says, not just that it said
      // something.
      const prompts: { say: string; must?: RegExp }[] = [
        { say: "What's in my standup note?", must: /recap|linux|blocked|shipped/i },
        { say: "Now check the trip note too.", must: /tokyo|ryokan|march/i },
        { say: "Do it for the groceries one as well.", must: /milk|eggs/i },
        { say: "Which of those three is most urgent?" },
        { say: "Write a one-line summary of all three into notes/summary.md." },
        { say: "Read it back to me.", must: /tokyo|linux|recap|milk/i },
        { say: "Anything else in that folder?" },
        { say: "Thanks — what did we cover?", must: /tokyo|linux|recap|milk/i },
      ].slice(0, BURST);

      const results: TurnResult[] = [];
      for (const prompt of prompts) {
        const result = await say(history, home, prompt.say);
        // Only a reply that claims to report the file is judged: "I can't
        // find it" is a legitimate answer, an invented one is not.
        result.invented =
          prompt.must !== undefined &&
          !prompt.must.test(result.reply) &&
          !/(?:can(?:'|no)?t|couldn't|unable|no such|not find|doesn't exist)/i.test(result.reply);
        results.push(result);
      }
      console.log(`\n${report(results)}\n`);

      const stalls = results.filter((result) => result.stalled);
      const invented = results.filter((result) => result.invented);
      expect(
        stalls.map((result) => `${result.say} -> ${result.reply.slice(0, 120)}`),
        "turns that promised work and never did it",
      ).toEqual([]);
      expect(
        invented.map((result) => `${result.say} -> ${result.reply.slice(0, 160)}`),
        "turns that reported file contents the file does not contain",
      ).toEqual([]);
    },
    TURN_TIMEOUT_MS * BURST,
  );

  it(
    "finishes the work after a mid-turn tool call, instead of promising it",
    async () => {
      // The reported stall's exact shape: a turn where discovery comes first
      // (find the file, then read it) and the model is tempted to sign off
      // between the two — "let me now read it". The real one fetched an MCP
      // tool schema and then promised "parallel searches". Multi-step, and
      // scored on whether the final reply contains what the file says.
      const home = await seededHome();
      const history: Message[] = [];
      const result = await say(
        history,
        home,
        "Look through my notes folder, find whichever note mentions a trip, " +
          "and tell me the dates. Check it out properly.",
      );
      console.log(`\n${report([result])}\n`);
      expect(result.stalled, "the reply ended on a promise instead of the dates").toBe(false);
      expect(result.reply, "never reported what the trip note actually says").toMatch(
        /12\s*[-–]\s*19|march|tokyo/i,
      );
    },
    TURN_TIMEOUT_MS,
  );

  it(
    "picks up a prompt typed while it is still working",
    async () => {
      const home = await seededHome();
      const history: Message[] = [];
      // The App.tsx race, reproduced: the user types again mid-turn, so the
      // message reaches the loop as steering rather than as its own turn.
      // Handed over exactly once — a repeat would steer forever.
      let sent = false;
      const result = await say(history, home, "What's in my standup note?", () => {
        if (sent) {
          return null;
        }
        sent = true;
        return [{ role: "user", content: "Actually, also tell me what's in the trip note." }];
      });
      console.log(`\n${report([result])}\n`);

      expect(sent, "the loop never asked for steering messages").toBe(true);
      expect(result.stalled).toBe(false);
      // Both halves answered: the original prompt and the one that arrived
      // mid-turn. A dropped follow-up answers only the first.
      expect(result.reply, "the mid-turn follow-up went unanswered").toMatch(/tokyo|ryokan|march/i);
    },
    TURN_TIMEOUT_MS,
  );
});
