import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it } from "vitest";
import { announcesIntent, blobSystemPrompt, streamBlobTurn } from "@/lib/ai";
import { memoryHome } from "@/lib/home";

/**
 * Recovery: after a tool rejects its arguments, does the Blob fix and retry —
 * or promise to, forever?
 *
 * The reported stall, verbatim (2026-08-25, YouTube Blob, thinking off):
 *
 *   "The tool wants q not query. Let me check the schema to get it exactly
 *    right this time."
 *   "I hit a real error — the tool wants q not query. Let me check the schema
 *    quickly, but I already know the fix: use q. Let me run it with the
 *    correct field."
 *
 * Three turns, the fix stated correctly every time, the call never made.
 *
 * Why it stops rather than continuing: agentLoop ends a turn on one rule —
 * the model produced text and called no tool. Nothing distinguishes "I will
 * run it" from a finished answer, so announcing the fix terminates the run as
 * cleanly as delivering it. The Blob is not sulking; from the loop's side it
 * replied.
 *
 * So this measures the thing that actually matters to a user: after a failed
 * call, does the correct call ever get made? Scored on the tool, not the
 * prose — a reply that talks about `q` while never sending it is the bug.
 *
 *   pnpm sim:recovery
 *   SIM_MODEL=tinfoil:deepseek-v4-flash TINFOIL_API_KEY=... pnpm sim:recovery
 *   SIM_THINKING=on pnpm sim:recovery
 */

const MODEL = process.env.SIM_MODEL ?? "qwen3.5:9b";
/** Off by default: the reported-broken configuration is the one under test. */
const THINKING = process.env.SIM_THINKING === "on";
/** Repeats: a stall is intermittent, so one clean run proves nothing. */
const RUNS = Number(process.env.SIM_RUNS ?? "3");
const TURN_TIMEOUT_MS = 240_000;

const USER = { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" };
const BLOB = {
  name: "YouTuber",
  title: "YouTube scout",
  description: "Finds Ken new videos worth watching on YouTube.",
};

interface Attempt {
  /** Every call made, in order, as `name(args)`. */
  calls: string[];
  reply: string;
  /** Did it ever send the corrected argument the error asked for? */
  recovered: boolean;
  /** Did it end by promising the fix instead of making it? */
  promised: boolean;
}

/**
 * A file whose name the Blob must get right on the second go.
 *
 * Reproduces the reported failure without needing a live Composio account: the
 * first call uses a path that does not exist, the tool says so, and recovery
 * means calling again with the corrected path. Same shape as the YouTube case
 * — a call rejected on its arguments, with the fix stated in the error.
 */
async function seededHome() {
  const home = memoryHome("4b8e2c91-3d7f-4a6b-9e1c-8f2a5d0b7c34");
  await home.write("notes/watchlist.md", "Tokyo drift retrospective. Ryokan tour part 3.");
  return home;
}

async function attempt(): Promise<Attempt> {
  const home = await seededHome();
  const calls: string[] = [];
  const history: Message[] = [
    {
      role: "user",
      // Names the wrong path on purpose, the way a model guesses a wrong field
      // name. The tool's error carries the correction.
      content:
        "Read notes/watch_list.md and tell me what's on it. If that exact path " +
        "is wrong, find the right file and read that instead.",
    },
  ];
  const reply = await streamBlobTurn({
    model: MODEL,
    messages: [{ role: "system", content: blobSystemPrompt(BLOB, USER) }, ...history],
    thinking: THINKING,
    home,
    // Pre-classified so the intent router does not fire a request of its own.
    intent: { action: "none" },
    memory: { list: () => [], save: () => {} },
    onSegment: () => {},
    onConfigure: () => {},
    onToolCall: (call) => calls.push(`${call.name}(${JSON.stringify(call.args)})`),
  });
  return {
    calls,
    reply,
    // The corrected call actually went out.
    recovered: calls.some((call) => call.includes("watchlist.md")),
    // Ended on a promise rather than a result: the stall. Uses the shipped
    // predicate, not a lookalike — a hand-rolled regex here missed a real
    // "Let me check the whole home folder." on its trailing full stop.
    promised: announcesIntent(reply),
  };
}

describe(`recovery (${MODEL}, thinking ${THINKING ? "on" : "off"})`, () => {
  it(
    "fixes and retries a rejected call instead of promising to",
    async () => {
      const results: Attempt[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        results.push(await attempt());
      }
      for (const result of results) {
        const mark = result.recovered ? "  ok " : result.promised ? "STALL" : " miss";
        console.log(
          `${mark} calls=${result.calls.length} ${result.calls.join(" ").slice(0, 100)}\n` +
            `      ${result.reply.replace(/\s+/g, " ").slice(0, 130)}`,
        );
      }

      // Promising the fix and stopping is the reported bug.
      const stalled = results.filter((result) => result.promised && !result.recovered);
      expect(
        stalled.map((result) => result.reply.slice(0, 140)),
        "runs that promised the retry and never made it",
      ).toEqual([]);
      // And the corrected call has to actually happen, every run.
      const missed = results.filter((result) => !result.recovered);
      expect(
        missed.map((result) => result.calls.join(" | ") || "(no calls at all)"),
        "runs that never made the corrected call",
      ).toEqual([]);
      // The content proves the retry returned real data rather than a guess.
      for (const result of results) {
        expect(result.reply).toMatch(/tokyo|ryokan|drift/i);
      }
    },
    TURN_TIMEOUT_MS * 6,
  );
});
