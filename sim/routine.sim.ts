import { describe, expect, it } from "vitest";
import { streamBlobTurn } from "@/lib/ai";
import { memoryHome } from "@/lib/home";
import { blobSystemPrompt } from "@/lib/prompt";

/**
 * Do routines actually finish the work, on a real model?
 *
 * The bug this exists for, seen live: a scheduled Discord check replied "Let
 * me start by finding what Discord tools are available to me." and stopped.
 * Nothing was broken in an obvious way — the run reported success — but the
 * check never happened, and no human was watching to say "go on".
 *
 * That is a *behaviour* question, so a mocked stream cannot answer it: the
 * unit tests pin the mechanism (the nudge fires, the reply is carried), while
 * this pins the thing that actually matters — after a routine turn, did the
 * tools get called and does the reply report real findings?
 *
 *   pnpm sim:routine
 *   SIM_MODEL=qwen3.5:2b pnpm sim:routine   # the weak model this protects
 */

const MODEL = process.env.SIM_MODEL ?? "qwen3.5:9b";
/** Non-deterministic model: one run cannot tell a regression from noise. */
const RUNS = Number(process.env.SIM_RUNS ?? "3");
const TURN_TIMEOUT_MS = 180_000;

const USER = { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" };

const BLOB = {
  name: "Filer",
  title: "Inbox keeper",
  description: "Watches Ken's notes folder and reports what changed.",
};

/** One routine turn, wired the way App.tsx wires a scheduled run. */
async function runRoutine(instruction: string): Promise<{ reply: string; tools: string[] }> {
  const home = memoryHome("61ec34f1-9ba5-4eff-b8e1-7acefb214777");
  // Something real to find, so "did it do the work" has a checkable answer.
  await home.write("notes/standup.md", "Shipped the recap feature. Blocked on the Linux build.");
  await home.write("notes/groceries.md", "milk, eggs");

  const tools: string[] = [];
  const reply = await streamBlobTurn({
    model: MODEL,
    messages: [
      { role: "system", content: blobSystemPrompt(BLOB, USER) },
      // Exactly App.tsx's shape for a routine: no user message in the
      // transcript, the instruction riding as the trailing prompt.
      { role: "user", content: instruction },
    ],
    // The whole point: an autonomous turn, with no human to nudge it.
    scope: "routine",
    home,
    memory: { list: () => [], save: () => {} },
    onSegment: () => {},
    onConfigure: () => {},
    onToolCall: (call) => tools.push(call.name),
  });
  return { reply, tools };
}

describe("a routine turn", () => {
  it(
    "reads the folder and reports what it found, rather than announcing it",
    async () => {
      const results: { ok: boolean; reply: string; tools: string[] }[] = [];
      for (let run = 0; run < RUNS; run++) {
        const { reply, tools } = await runRoutine(
          "Check Ken's notes folder and tell him what is in the standup note.",
        );
        // Did the work: touched the folder AND said something from inside the
        // file. A reply that only promises fails both halves.
        const ok =
          tools.length > 0 && /recap|linux|blocked|shipped/i.test(reply) && reply.trim() !== "";
        results.push({ ok, reply, tools });
        console.log(
          `\n--- run ${run + 1}: tools=[${tools.join(", ")}] ok=${ok} ---\n${reply.slice(0, 400)}\n`,
        );
      }
      // Majority, like the other sims: a single sample of a sampling model is
      // noise, and a suite that reddens on noise stops being read.
      const passed = results.filter((result) => result.ok).length;
      expect(passed * 2).toBeGreaterThan(RUNS);
    },
    TURN_TIMEOUT_MS * RUNS,
  );
});
