import { describe, expect, it } from "vitest";
import { blobSystemPrompt, splitHistory, streamBlobTurn } from "@/lib/ai";
import { contextWindow } from "@/lib/context-window";
import { pendingMessages, RECAP_CHARS, type RecapEntry, summarizeHistory } from "@/lib/recap";

/**
 * Recap simulation: can a real local model actually fold a conversation's
 * dropped head into a usable summary?
 *
 * The unit tests cover which messages a pass reads and how the result is
 * clipped; none of that says whether a 9b model writes something a Blob can
 * work from. That is a *quality* question, so it lives here with the other
 * tuning harnesses: needs Ollama, slow, never part of `pnpm check`.
 *
 *   pnpm sim:recap
 *   SIM_MODEL=qwen3.5:2b pnpm sim:recap   # watch it degrade
 */

const MODEL = process.env.SIM_MODEL ?? "qwen3.5:9b";

const say = (id: string, role: "user" | "assistant", content: string): RecapEntry => ({
  id,
  message: { role, content },
});

/** A week of working together, in the shape compaction actually sees. */
const CONVERSATION: RecapEntry[] = [
  say("1", "user", "I need help migrating our invoice script from SQLite to Postgres."),
  say("1a", "assistant", "Happy to. What does the script do today?"),
  say("2", "user", "It bills 412 customers monthly. Run it on the 3rd. Never on weekends."),
  say("2a", "assistant", "Noted: 412 customers, monthly on the 3rd, skipping weekends."),
  say("3", "user", "Always show me the SQL before you run anything against production."),
  say("3a", "assistant", "Understood — I'll show every statement first."),
  say("4", "user", "We decided to keep the old SQLite file as a read-only backup."),
  say("4a", "assistant", "Good call. I'll leave it untouched and read-only."),
  say("5", "user", "Still open: whether the invoice numbering restarts at 1 after the move."),
  say("5a", "assistant", "I'll leave numbering alone until you decide."),
];

describe("summarizeHistory", () => {
  it("keeps the goal, the standing rules, the decision and the open thread", async () => {
    const recap = await summarizeHistory({
      model: MODEL,
      previous: undefined,
      entries: CONVERSATION,
      blobName: "Ken",
    });
    expect(recap).not.toBeNull();
    const text = recap?.text ?? "";
    console.log(`\n--- recap (${text.length} chars) ---\n${text}\n`);
    // Under the cap the history budget was reduced by, without being clipped
    // to get there: a model that ignores the word limit costs real history.
    expect(text.length).toBeLessThanOrEqual(1_200);
    // The four things the prompt asks for, in the model's own words: the
    // goal, a standing rule, an exact number, and what is still undecided.
    expect(text.toLowerCase()).toContain("postgres");
    expect(text.toLowerCase()).toMatch(/sql|statement/);
    expect(text).toContain("412");
    expect(text.toLowerCase()).toMatch(/number|numbering|open|undecided|pending/);
  });

  it("folds a new exchange into the previous recap instead of restarting it", async () => {
    // The incremental path, which is the one that runs on every compaction
    // after the first: old facts must survive a pass that never sees them
    // again, or a long conversation quietly loses its start.
    const recap = await summarizeHistory({
      model: MODEL,
      previous:
        "The user is migrating an invoice script from SQLite to Postgres. It bills 412 " +
        "customers monthly on the 3rd, never on weekends. Standing rule: show the SQL " +
        "before running anything against production. Open: whether invoice numbering restarts.",
      entries: [
        say("6", "user", "Numbering continues from 8801, don't restart it."),
        say("6a", "assistant", "Continuing from 8801."),
      ],
      blobName: "Ken",
    });
    const text = recap?.text ?? "";
    console.log(`\n--- updated recap (${text.length} chars) ---\n${text}\n`);
    // The new decision is in…
    expect(text).toContain("8801");
    // …and the old context it was never shown again did not fall out.
    expect(text.toLowerCase()).toContain("postgres");
    expect(text).toContain("412");
  });

  it("leaves the Blob able to answer 'what are we working on?' past the trim point", async () => {
    // The whole point, end to end and on a real model: a conversation long
    // enough that its opening no longer fits, driven through the same three
    // pieces App runs — splitHistory, summarizeHistory, blobSystemPrompt —
    // and then asked the one question a forgetful Blob cannot answer.
    const filler = (topic: string, index: number) =>
      `${topic} (part ${index}). ` +
      `We walked through the schema column by column, the indexes it needs, ` +
      `how the nightly job reads it, and what the reporting view expects. `.repeat(22);

    // The facts that matter are said EARLY, so they are what gets dropped.
    const conversation: RecapEntry[] = [
      ...CONVERSATION,
      ...Array.from({ length: 14 }, (_, index): RecapEntry[] => [
        say(`f${index}`, "user", filler("Next, the customers table", index)),
        say(`f${index}a`, "assistant", filler("Here is what I found", index)),
      ]).flat(),
      say("now", "user", "what are we working on?"),
    ];

    // 1. Exactly App's split: the model's own window, minus the recap's cost.
    const split = splitHistory(
      conversation.map((entry) => entry.message),
      contextWindow(MODEL),
      RECAP_CHARS,
    );
    console.log(
      `\n--- split: ${split.droppedCount} of ${conversation.length} messages dropped, ` +
        `${split.kept.length} kept ---`,
    );
    expect(split.droppedCount).toBeGreaterThan(0);

    // The opening really is gone from what the model will see — otherwise the
    // question below would be answerable without a recap and prove nothing.
    const kept = split.kept.map((message) => String(message.content)).join("\n");
    expect(kept).not.toContain("412");
    expect(kept.toLowerCase()).not.toContain("sqlite");

    // 2. Compaction, as the turn loop runs it.
    const dropped = conversation.slice(0, split.droppedCount);
    const recap = await summarizeHistory({
      model: MODEL,
      previous: undefined,
      entries: pendingMessages(dropped),
      blobName: "Ken",
    });
    expect(recap).not.toBeNull();
    console.log(`\n--- recap carried into the prompt ---\n${recap?.text}\n`);

    // 3. A real turn, with the recap in the system prompt where App puts it.
    const ask = async (withRecap: boolean): Promise<string> =>
      await streamBlobTurn({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: blobSystemPrompt(
              { name: "Ken", title: "Engineer", description: "Helps Ken Kai ship things." },
              { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" },
              withRecap ? { recap: recap?.text ?? "" } : {},
            ),
          },
          ...split.kept,
        ],
        memory: { list: () => [], save: () => {} },
        // Routine scope: no intent router in the way, so what comes back is
        // the model reading its own prompt and nothing else.
        scope: "routine",
        onSegment: () => {},
        onConfigure: () => {},
      });

    const answer = await ask(true);
    console.log(`\n--- answer WITH recap ---\n${answer}\n`);
    // It knows the goal and the number, neither of which is in the history it
    // was sent. That is the recap doing its job and nothing else.
    expect(answer.toLowerCase()).toContain("postgres");
    expect(answer).toContain("412");

    // The control, logged rather than asserted: what today's behaviour looks
    // like. A model is free to waffle convincingly, so this is evidence for a
    // human reading the run, not a gate that can redden on noise.
    console.log(`\n--- answer WITHOUT recap (before this change) ---\n${await ask(false)}\n`);
  });
});
