import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it } from "vitest";
import { blobSystemPrompt, streamBlobTurn } from "@/lib/ai";
import type { RosterAccess } from "@/lib/blob-tools";
import { memoryHome } from "@/lib/home";

/**
 * Fleet awareness: does a Blob know what it is part of, and who else is here?
 *
 * Two failures this measures, both from the same gap — the word "Blobbies"
 * appeared in no system prompt, and no turn ever showed the roster, though
 * `update_blob` refuses an unknown name with "check the name against the
 * roster you were shown".
 *
 * 1. Naming: asked to hand work over or reconfigure a colleague, the model had
 *    to guess a name. A guess is a refusal — both roster tools resolve names
 *    exactly, so "Writer Blob" for `Writer` costs the turn.
 * 2. Identity: asked what it is, a Blob answered from its role only, with no
 *    idea it is one of a team the user keeps, or that its memories and files
 *    outlive the conversation.
 *
 * Scored on the tool ARGUMENTS, not the prose: what matters is whether the
 * name it addressed exists. The roster tools here are stubs — recording the
 * call is the whole measurement.
 *
 *   pnpm sim:fleet
 *   SIM_MODEL=tinfoil:deepseek-v4-flash TINFOIL_API_KEY=... pnpm sim:fleet
 */

const MODEL = process.env.SIM_MODEL ?? "qwen3.5:9b";
const THINKING = process.env.SIM_THINKING === "on";
/** Repeats per prompt: a naming slip is intermittent, so once proves little. */
const RUNS = Number(process.env.SIM_RUNS ?? "2");
const TURN_TIMEOUT_MS = 180_000;

const USER = { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" };

const BLOB = {
  name: "Researcher",
  title: "Research assistant",
  description: "Digs up sources and background for Ken.",
};

/** The rest of the user's team, exactly as App.tsx passes it on a 1:1 turn. */
const SIBLINGS = [
  { name: "Quill", title: "Writes and edits Ken's posts" },
  { name: "Ledger", title: "Tracks invoices and expenses" },
];

interface Turn {
  say: string;
  calls: { name: string; args: Record<string, unknown> }[];
  reply: string;
}

async function turnOf(prompt: string, siblings = SIBLINGS): Promise<Turn> {
  const calls: Turn["calls"] = [];
  const history: Message[] = [{ role: "user", content: prompt }];
  // Stub roster: the calls are the measurement, so nothing needs to happen.
  const roster: RosterAccess = {
    list: () => siblings.map((blob, index) => ({ id: `blob-${index}`, name: blob.name })),
    create: () => {},
    update: () => true,
    delete: () => {},
    message: () => "Sent.",
  };
  const reply = await streamBlobTurn({
    model: MODEL,
    messages: [{ role: "system", content: blobSystemPrompt(BLOB, USER, { siblings }) }, ...history],
    thinking: THINKING,
    home: memoryHome(),
    roster: { access: roster, selfName: BLOB.name },
    // Pre-classified so the intent router does not fire a request of its own.
    intent: { action: "none" },
    memory: { list: () => [], save: () => {} },
    onSegment: () => {},
    onConfigure: () => {},
    onToolCall: (call) => calls.push({ name: call.name, args: call.args }),
  });
  return { say: prompt, calls, reply };
}

/** The `name` argument of the first roster call that carries one. */
function addressed(turn: Turn): string {
  const call = turn.calls.find(
    (candidate) => candidate.name === "message_blob" || candidate.name === "update_blob",
  );
  return typeof call?.args.name === "string" ? call.args.name : "(none)";
}

describe(`fleet (${MODEL}, thinking ${THINKING ? "on" : "off"})`, () => {
  it(
    "addresses a colleague by the exact roster name",
    async () => {
      // Each names the sibling loosely, the way a person types it — the Blob
      // has to resolve that to the roster's exact spelling.
      const prompts = [
        "ask the writer blob to turn my notes into a post",
        "get whoever handles invoices to check last month's expenses",
        "the writing one should stop using bullet points — update its instructions",
      ];
      const results: Turn[] = [];
      for (const prompt of prompts) {
        for (let run = 0; run < RUNS; run += 1) {
          results.push(await turnOf(prompt));
        }
      }
      const known = new Set(SIBLINGS.map((blob) => blob.name));
      for (const result of results) {
        const name = addressed(result);
        const mark = known.has(name) ? "  ok " : "MISS ";
        console.log(
          `${mark} ${result.say.slice(0, 46).padEnd(48)} name=${name.padEnd(14)}` +
            `[${result.calls.map((call) => call.name).join(", ")}]`,
        );
      }

      // An invented name is the bug: both roster tools refuse anything that is
      // not on the list, so the hand-off simply does not happen.
      const wrong = results.filter(
        (result) => addressed(result) !== "(none)" && !known.has(addressed(result)),
      );
      expect(
        wrong.map((result) => `${result.say} -> ${addressed(result)}`),
        "turns that addressed a Blob that does not exist",
      ).toEqual([]);
    },
    TURN_TIMEOUT_MS * 9,
  );

  it(
    "knows it is a Blob in Blobbies, with storage of its own",
    async () => {
      const result = await turnOf("what are you, exactly? and do you remember me between chats?");
      console.log(`  ..  ${result.reply.replace(/\s+/g, " ").slice(0, 240)}`);
      // Both halves of the identity section, in whatever words it chose.
      expect(result.reply.toLowerCase()).toContain("blob");
      expect(result.reply.toLowerCase()).toMatch(/remember|memor|persist/);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    "does not invent a colleague when it is the only Blob",
    async () => {
      // The empty-roster case: nobody to hand to, so the honest answer is to
      // say so (or offer to spawn one) — never to message a Blob it made up.
      const result = await turnOf("pass this to whoever writes my posts", []);
      console.log(
        `  ..  only-blob name=${addressed(result)} [${result.calls
          .map((call) => call.name)
          .join(", ")}]`,
      );
      expect(addressed(result)).toBe("(none)");
    },
    TURN_TIMEOUT_MS,
  );
});
