import type { Message } from "@kenkaiiii/gg-ai";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "@/data/agents";
import { blobSystemPrompt, streamBlobTurn } from "@/lib/ai";
import {
  addressedResponders,
  handoffTarget,
  isPass,
  namedResponders,
  owesAnswer,
  stripSelfMention,
} from "@/lib/groups";
import { applyGroupIntent, pickResponders, routeIntent } from "@/lib/intent";
import type { BlobMemory } from "@/lib/memory";

/**
 * Group-chat simulation: does a room of Blobs behave like a team rather than
 * a chorus?
 *
 * Each scenario is a measurement rather than an assertion about wiring
 * (App.turns.test.tsx already pins the wiring against a scripted model):
 *
 *   1. Selection  — only the Blobs whose job it is answer. The failure this
 *      exists to catch is every member replying to every message: on one
 *      local model that is N serial turns and N near-identical answers.
 *   2. Cross-talk — a Blob pulls in the teammate it actually needs, and the
 *      two do not merely agree; they answer from their own job.
 *   3. Awareness  — a Blob that stayed quiet still knows what was said. This
 *      is the one people assume is broken: not answering is not the same as
 *      not listening, and the shared transcript is what makes it true.
 *   4. No chorus, by either route — members that all answer must not
 *      paraphrase each other, and a Blob merely *naming* a teammate must not
 *      wake them. The second one is not hypothetical: it is what this harness
 *      caught on its first run, and why `handoffTarget` exists.
 *
 * A tuning harness, not a test: needs Ollama, is slow, never runs in CI.
 *
 *   pnpm sim:group
 *   SIM_MODEL=llama3.1:8b pnpm sim:group
 *   SIM_RUNS=3 pnpm sim:group        # same scenarios, see the flakiness
 *
 * The exchange loop below mirrors `sendToGroup` in App.tsx the way
 * agent.sim.ts mirrors its turn assembly: the pieces that decide behaviour —
 * `pickResponders`, `addressedResponders`, `blobSystemPrompt`'s group section,
 * the `[Name]:` labelling — are the production ones, so a prompt change lands
 * here without being copied.
 */

// 9b is the floor these scenarios are judged against. A 0.8b/2b model cannot
// hold a multi-party room: measured, it invents facts rather than hand work to
// the colleague whose job it is, so scenarios fail for reasons no prompt can
// fix and every run carries noise that hides real regressions. Point SIM_MODEL
// at something smaller to see how it degrades, not to gate on it.
const MODEL = process.env.SIM_MODEL ?? "qwen3.5:9b";
// Three by default, because one run cannot tell a regression from noise here:
// a 20s turn at temperature 0 still varies, and every scenario that has ever
// failed in this suite also passed on retry. Three runs with majority scoring
// (see `score`) is the cheapest thing that is actually decisive. SIM_RUNS=1
// for a quick look, and it reverts to failing on any single failure.
const RUNS = Number(process.env.SIM_RUNS ?? "3");
const TURN_TIMEOUT_MS = 120_000;
const USER = { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" };

/** A member of the simulated group: a real Agent shape, jobs kept distinct. */
function member(name: string, title: string, description: string): Agent {
  return {
    id: `sim-${name.toLowerCase()}`,
    name,
    title,
    description,
    time: "Now",
    snippet: "",
    tone: "blue",
    shape: "sphere",
    section: "Launch",
  };
}

/**
 * Deliberately non-overlapping jobs. Overlapping ones would make "who should
 * answer" a coin toss and the selection score meaningless — which is itself
 * the honest limit of this measurement, not a property of the router.
 */
const TEAM = [
  member(
    "Scout",
    "Researcher",
    "Finds sources and checks facts. Never writes copy and never touches money.",
  ),
  member("Quill", "Writer", "Turns findings into drafts and posts. Does no research of their own."),
  member(
    "Ledger",
    "Bookkeeper",
    "Tracks spend, invoices and budget. Has nothing to do with words or sources.",
  ),
];

/** One line of the shared transcript. `who` is undefined for the user. */
interface GroupLine {
  who?: string;
  text: string;
}

/**
 * The request one member sees: its own lines as assistant, everyone else's —
 * including the user's — as user, with other Blobs labelled. Identical to the
 * projection in App.tsx's `requestReply`, and the reason a quiet Blob is
 * still an informed one.
 */
/**
 * The trailing focus line App appends to every group turn.
 *
 * Not decoration: the newest message a later speaker sees is usually another
 * Blob's reply, and a model answers the newest thing. Measured at 50% on
 * qwen3.5:2b without it — Blobs greeting each other while the person who
 * spoke was left out.
 */
function focusLine(transcript: GroupLine[], mustAnswer: boolean): Message[] {
  const asked = [...transcript].reverse().find((line) => line.who === undefined);
  return asked === undefined
    ? []
    : [
        {
          role: "user",
          content:
            `[Answer ${USER.userName}, who said: \u201C${asked.text}\u201D. Anything after ` +
            "it is a colleague replying to that same message \u2014 never answer a " +
            "colleague." +
            (mustAnswer
              ? ` ${USER.userName} asked you by name, so answer \u2014 do not pass. If it ` +
                "asks for TWO different kinds of work and one is a colleague's, do " +
                'your part, then end with "@Name" to hand over the rest. Otherwise ' +
                "just answer.]"
              : " If one of them has already answered it, or you would only be " +
                "agreeing or greeting, reply with exactly PASS.]"),
        },
      ];
}

function requestFor(
  self: Agent,
  transcript: GroupLine[],
  group: string,
  mustAnswer: boolean,
): Message[] {
  const others = TEAM.filter((blob) => blob.id !== self.id).map((blob) => blob.name);
  return [
    {
      role: "system",
      content: blobSystemPrompt(self, USER, {
        group: { name: group, others },
        // Shared facts, exactly as the app renders them — so "who saved it"
        // and "who can see it" are both measured, not assumed.
        userMemories: shared,
      }),
    },
    ...transcript.map((line): Message => {
      if (line.who === self.name) {
        return { role: "assistant", content: line.text };
      }
      return {
        role: "user",
        content: line.who === undefined ? line.text : `[${line.who}]: ${line.text}`,
      };
    }),
    ...focusLine(transcript, mustAnswer),
  ];
}

/** What one user message produced: who spoke, and what they said. */
interface Exchange {
  said: string;
  picked: string[];
  replies: { who: string; text: string }[];
  /** Picked, ran, and chose to stay out — the employee behaviour. */
  passed: string[];
  ms: number;
}

/**
 * The group's shared memory. One list for the room, mutated by `send` — the
 * property under test is that it holds ONE copy of a fact however many Blobs
 * heard it.
 */
let shared: BlobMemory[] = [];

/**
 * Run one user message through the group, exactly as the app does: address it
 * if it names someone, otherwise ask the router, then let each speaker pull in
 * a teammate it @-mentions (once each, so the exchange ends).
 */
async function send(transcript: GroupLine[], text: string): Promise<Exchange> {
  const started = Date.now();
  transcript.push({ text });
  // Classified once for the room, before anyone answers — not once per
  // responder, which is what would give six Blobs six copies of one fact.
  const intent = await routeIntent({
    model: MODEL,
    messages: [{ role: "user", content: text }],
    memories: shared,
  });
  const next = await applyGroupIntent(intent, { model: MODEL, memories: shared });
  if (next !== null) {
    shared = next;
  }
  const addressed = addressedResponders(TEAM, { text });
  let queue: Agent[];
  if (addressed !== null) {
    queue = addressed;
  } else {
    const names = await pickResponders({
      model: MODEL,
      text,
      members: TEAM,
      recent: transcript.slice(-5, -1).map((line) => `${line.who ?? USER.userName}: ${line.text}`),
    });
    queue = TEAM.filter((blob) => names.includes(blob.name));
  }
  const pickedCount = queue.length;
  // Singled out by name: obliged to answer. Routed to, pulled in by a
  // colleague, or swept up by @everyone: invited, and free to stay out.
  const named = namedResponders(TEAM, { text });
  const picked = queue.map((blob) => blob.name);
  const spoken = new Set<string>();
  const passed: string[] = [];
  const replies: { who: string; text: string }[] = [];
  while (queue.length > 0) {
    const speaker = queue.shift();
    if (speaker === undefined || spoken.has(speaker.id)) {
      continue;
    }
    spoken.add(speaker.id);
    const spoke = await streamBlobTurn({
      model: MODEL,
      // `mustAnswer` for a named Blob *and* the sole picked one, as the app
      // decides it: with nobody to defer to, PASS is silence.
      messages: requestFor(
        speaker,
        transcript,
        "Launch",
        owesAnswer({ addressed: named.has(speaker.id), pickedCount }),
      ),
      // Pre-classified above, as the app does: a group turn must not route
      // (and must not write memories) on its own.
      intent,
      memory: { list: () => shared, save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
    });
    // Declining is a real outcome: it never reaches the transcript, so the
    // next speaker does not read a wall of "PASS" either. A Blob the user
    // named cannot opt out, exactly as the app decides it.
    // Mirrors the app: a Blob the user named owes an answer, and so does the
    // only Blob picked — PASS means "someone else has this", and there is
    // nobody else. Without the second half qwen3.5:2b answered a direct
    // question with silence in 3 of 5 runs.
    if (!owesAnswer({ addressed: named.has(speaker.id), pickedCount }) && isPass(spoke)) {
      passed.push(speaker.name);
      continue;
    }
    // Mirrors the app: a Blob signing its own name is dropped before the reply
    // is banked (App.tsx `appendSegment`). Without this the sim would measure
    // a pipeline the user never runs — and `handoffTarget` below reads a
    // sentence-opening mention as a hand-off, so a self-signature would wake
    // the speaker again.
    const reply = stripSelfMention(spoke, speaker.name);
    transcript.push({ who: speaker.name, text: reply });
    replies.push({ who: speaker.name, text: reply });
    const pulled = handoffTarget(reply, TEAM, new Set(spoken));
    if (pulled !== null) {
      queue.push(pulled);
    }
  }
  return { said: text, picked, replies, passed, ms: Date.now() - started };
}

function report(name: string, exchanges: Exchange[]): string {
  const lines = [`\n\u2500\u2500 ${name}`];
  for (const exchange of exchanges) {
    lines.push(`   user: ${exchange.said}`);
    lines.push(`   picked: ${exchange.picked.join(", ") || "\u2014 (nobody)"}  (${exchange.ms}ms)`);
    if (exchange.passed.length > 0) {
      lines.push(`   stayed out: ${exchange.passed.join(", ")}`);
    }
    for (const reply of exchange.replies) {
      lines.push(`   ${reply.who}: ${reply.text.replace(/\s+/g, " ").slice(0, 150)}`);
    }
  }
  return lines.join("\n");
}

const tally = new Map<string, { pass: number; fail: number; reasons: string[] }>();

afterAll(() => {
  const rows = [...tally.entries()];
  const lines = [
    `\n\u2550\u2550 group reliability (${MODEL}, ${RUNS} run${RUNS === 1 ? "" : "s"})`,
  ];
  for (const [name, count] of rows) {
    const total = count.pass + count.fail;
    const percent = Math.round((count.pass / total) * 100);
    lines.push(
      `   ${"\u2588".repeat(Math.round(percent / 10)).padEnd(10, "\u2591")} ${String(percent).padStart(3)}%  ${name}`,
    );
  }
  console.log(lines.join("\n"));

  // The verdict, taken across runs. A scenario that failed more often than it
  // passed is a real regression; one that failed once out of three is the model
  // being a model.
  if (RUNS > 1) {
    const broken = rows
      .filter(([, count]) => count.fail > count.pass)
      .map(
        ([name, count]) =>
          `${name}: failed ${count.fail}/${count.pass + count.fail} \u2014 ${count.reasons[0]}`,
      );
    expect(broken, broken.join("\n   ")).toEqual([]);
  }
});

/**
 * Record a scenario's outcome, and decide when to fail on it.
 *
 * With repeats, a single bad run is not a verdict: judged per-run this suite
 * goes red on noise, which trains everyone to ignore it. So the failure is
 * raised once, from `afterAll`, and only for a scenario that failed a majority
 * of its runs. One run keeps the strict behaviour — there is no majority to
 * take, and a single failure is all the signal there is.
 */
function score(name: string, failures: string[], printed: string) {
  console.log(printed);
  const count = tally.get(name) ?? { pass: 0, fail: 0, reasons: [] as string[] };
  if (failures.length === 0) {
    count.pass++;
  } else {
    count.fail++;
    count.reasons.push(failures.join("; "));
  }
  tally.set(name, count);
  if (RUNS === 1) {
    expect(failures, failures.join("\n   ")).toEqual([]);
  }
}

describe(`group simulation (${MODEL})`, () => {
  // Every scenario starts with an empty room memory, or the second run reads
  // the first one's facts and "saved once" stops meaning anything.
  beforeEach(() => {
    shared = [];
  });

  for (let run = 1; run <= RUNS; run++) {
    const suffix = RUNS > 1 ? ` [run ${run}]` : "";

    it(
      `only the relevant Blob answers${suffix}`,
      async () => {
        // Each message is squarely one member's job. A model that adds a
        // second name "to be safe" is the failure mode — it costs a whole
        // extra turn and produces an answer nobody asked for.
        const cases = [
          { say: "what did last month's hosting cost us?", want: "Ledger" },
          { say: "find me two sources on that claim", want: "Scout" },
          { say: "turn those notes into a launch post", want: "Quill" },
        ];
        const failures: string[] = [];
        const exchanges: Exchange[] = [];
        for (const probe of cases) {
          // Fresh transcript per probe: selection must follow the job, not
          // whoever happened to speak last.
          const exchange = await send([], probe.say);
          exchanges.push(exchange);
          if (!exchange.picked.includes(probe.want)) {
            failures.push(
              `"${probe.say}" -> ${exchange.picked.join(",") || "nobody"}, wanted ${probe.want}`,
            );
          } else if (exchange.picked.length > 1) {
            failures.push(
              `"${probe.say}" -> ${exchange.picked.join(",")}, wanted ${probe.want} alone`,
            );
          }
        }
        score("selection: one job, one answerer", failures, report("selection", exchanges));
      },
      TURN_TIMEOUT_MS * 6,
    );

    it(
      `a quiet Blob still knows what was said${suffix}`,
      async () => {
        // The property people assume is broken: Ledger never answers the
        // first two messages, then is asked about them directly.
        const transcript: GroupLine[] = [];
        const exchanges = [
          await send(transcript, "@Scout what did you find about the venue?"),
          await send(transcript, "@Quill the venue is booked for the 14th, note that down"),
          await send(transcript, "@Ledger what date is the venue booked for?"),
        ];
        const answer = exchanges[2]?.replies[0]?.text ?? "";
        const failures: string[] = [];
        if (!/14/.test(answer)) {
          failures.push(
            `Ledger did not recall the date from a message it never answered: ${answer}`,
          );
        }
        score("awareness: quiet Blob still listening", failures, report("awareness", exchanges));
      },
      TURN_TIMEOUT_MS * 4,
    );

    it(
      `a Blob hands work to the teammate whose job it is${suffix}`,
      async () => {
        // Two jobs in one request, both immediately actionable — a vague one
        // measures whether a Blob asks for clarification (it does, correctly)
        // rather than whether work crosses the room, which is the point here.
        const exchange = await send(
          [],
          "check the claim that our hosting is cheaper than Vercel's, then write " +
            "it up as a short launch post",
        );
        const spoke = exchange.replies.map((reply) => reply.who);
        const failures: string[] = [];
        if (!spoke.includes("Quill")) {
          failures.push(`no writer in the exchange: ${spoke.join(",") || "nobody"}`);
        }
        if (!spoke.includes("Scout")) {
          failures.push(`no researcher in the exchange: ${spoke.join(",") || "nobody"}`);
        }
        if (spoke.includes("Ledger")) {
          failures.push("the bookkeeper joined a job with no money in it");
        }
        score(
          "cross-talk: hand-off to the right teammate",
          failures,
          report("cross-talk", [exchange]),
        );
      },
      TURN_TIMEOUT_MS * 4,
    );

    it(
      `a Blob talking about a teammate does not wake them${suffix}`,
      async () => {
        // The chorus arriving through the side door: this exact shape was
        // measured before `handoffTarget` existed — a Blob answered a question,
        // referred to two teammates in passing, and woke both to say nothing.
        const transcript: GroupLine[] = [];
        const exchanges = [
          await send(transcript, "@Quill the venue is booked for the 14th, note that down"),
          await send(transcript, "@Ledger what date is the venue booked for?"),
        ];
        const spoke = exchanges[1]?.replies.map((reply) => reply.who) ?? [];
        const failures: string[] = [];
        if (spoke.length !== 1) {
          failures.push(`a direct question woke ${spoke.join(",")}, wanted Ledger alone`);
        }
        score(
          "no side-door chorus: mentions are not hand-offs",
          failures,
          report("mentions", exchanges),
        );
      },
      TURN_TIMEOUT_MS * 4,
    );

    it(
      `a fact told to the room is saved once, and everyone can use it${suffix}`,
      async () => {
        // The question this scenario exists for: when six Blobs hear one
        // sentence, who saves it? Answer: nobody — the room does, once, before
        // anyone speaks. Then a Blob that never heard it "live" can still use
        // it, because it reads the same shared list.
        const transcript: GroupLine[] = [];
        const exchanges = [
          await send(transcript, "remember the budget for this launch is 4000 euros"),
        ];
        const failures: string[] = [];
        if (shared.length !== 1) {
          failures.push(
            `room memory holds ${shared.length} facts, wanted exactly 1: ${JSON.stringify(
              shared.map((memory) => memory.text),
            )}`,
          );
        }
        if (!shared.some((memory) => /4000|4,000/.test(memory.text))) {
          failures.push(`the budget was not saved: ${JSON.stringify(shared)}`);
        }
        // A different Blob, a fresh question: the fact has to be usable by
        // whoever the router picks, not only by whoever was speaking.
        exchanges.push(await send(transcript, "@Ledger what is the launch budget?"));
        const answer = exchanges[1]?.replies[0]?.text ?? "";
        if (!/4000|4,000|4 000/.test(answer)) {
          failures.push(`the room's own fact did not reach the answer: ${answer}`);
        }
        score(
          "memory: one fact, saved once, readable by all",
          failures,
          report("memory", exchanges),
        );
      },
      TURN_TIMEOUT_MS * 4,
    );

    it(
      `a Blob answers the user, not the Blob before it${suffix}`,
      async () => {
        // Measured from a real transcript: the user said "Hi all", the first
        // Blob greeted the user, and the second replied to the FIRST BLOB —
        // two Blobs chatting while the person who spoke was left out.
        const exchange = await send([], "@everyone hi all");
        const failures: string[] = [];
        for (const reply of exchange.replies) {
          // Opening at a colleague is the tell, by @handle or plain name: the
          // person who said "hi all" is the one being answered, and a Blob
          // greeting its neighbours is how a group turns into two Blobs
          // chatting with the user left out.
          const opening = reply.text.slice(0, 60);
          const colleague = TEAM.find(
            (blob) =>
              blob.name !== reply.who && new RegExp(`@?\\b${blob.name}\\b`, "i").test(opening),
          );
          if (colleague !== undefined) {
            failures.push(`${reply.who} opened at ${colleague.name}, not the user: ${opening}`);
          }
        }
        score("addressing: replies go to the user", failures, report("addressing", [exchange]));
      },
      TURN_TIMEOUT_MS * 4,
    );

    it(
      `a Blob with nothing to add stays out${suffix}`,
      async () => {
        // The employee rule, on an ordinary message — no @everyone, which
        // obliges everyone by design. One member owns the question and the
        // others should keep quiet rather than each producing a "sounds
        // good!": the noise the router exists to prevent, arriving after the
        // routing decision.
        //
        // The fact is planted first so the question is genuinely answerable:
        // an unanswerable one measures "nobody knows", not who stayed out.
        const transcript: GroupLine[] = [];
        await send(transcript, "remember hosting cost 210 euros last month");
        const exchange = await send(transcript, "quick one: what did hosting cost last month?");
        const failures: string[] = [];
        const spoke = exchange.replies.map((reply) => reply.who);
        // One answer, not three. WHICH member answers is not asserted here:
        // the fact is shared knowledge, so whoever speaks first legitimately
        // owns it — job-based selection is the `selection` scenario's job.
        if (spoke.length !== 1) {
          failures.push(
            `${spoke.length || "no"} Blobs answered one question: ${spoke.join(",") || "nobody"}`,
          );
        }
        if (!/210/.test(exchange.replies[0]?.text ?? "")) {
          failures.push(`the answer lost the fact: ${exchange.replies[0]?.text}`);
        }
        score(
          "employees: silence when there is nothing to add",
          failures,
          report("passing", [exchange]),
        );
      },
      TURN_TIMEOUT_MS * 4,
    );

    it(
      `everyone answers @everyone, and nobody parrots the answer${suffix}`,
      async () => {
        // Addressing the room is an instruction, not a suggestion: every
        // member owes a reply and none may PASS. The risk that buys is a
        // chorus — measured on qwen3.5:9b, three members answered “210 euros”
        // in turn — so the prompt has to make each add its own angle, and
        // this is what says whether it does.
        const transcript: GroupLine[] = [];
        await send(transcript, "remember hosting cost 210 euros last month");
        const exchange = await send(
          transcript,
          "@everyone what did hosting cost last month, and what does that mean for your work?",
        );
        const failures: string[] = [];
        if (exchange.replies.length !== TEAM.length) {
          failures.push(
            `${exchange.replies.length}/${TEAM.length} answered a message to the whole room`,
          );
        }
        if (exchange.passed.length > 0) {
          failures.push(`${exchange.passed.join(",")} passed on a message addressed to them`);
        }
        // Same fact, different angles. Judged on the words each adds beyond
        // the number, since every reply legitimately contains “210”.
        const beyond = exchange.replies.map((reply) =>
          reply.text
            .toLowerCase()
            .replace(/[^a-z\s]/g, " ")
            .split(/\s+/)
            .filter((word) => word.length > 4),
        );
        for (let left = 0; left < beyond.length; left++) {
          for (let right = left + 1; right < beyond.length; right++) {
            const a = new Set(beyond[left]);
            const b = beyond[right] ?? [];
            const shared = b.filter((word) => a.has(word)).length;
            if (b.length > 0 && shared / b.length > 0.6) {
              failures.push(
                `${exchange.replies[right]?.who} restated ${exchange.replies[left]?.who}`,
              );
            }
          }
        }
        score("@everyone: all answer, none parrot", failures, report("everyone", [exchange]));
      },
      TURN_TIMEOUT_MS * 5,
    );

    it(
      `nobody repeats the Blob before them${suffix}`,
      async () => {
        // Everyone answers, so the prompt's "add only what is missing" rule
        // is the only thing between this and three paraphrases of one answer.
        const exchange = await send([], "@everyone one line each: what are you working on?");
        const failures: string[] = [];
        const texts = exchange.replies.map((reply) => reply.text.toLowerCase());
        for (let index = 1; index < texts.length; index++) {
          const previous = texts.slice(0, index);
          const words = new Set(
            (texts[index] ?? "").split(/\W+/).filter((word) => word.length > 4),
          );
          for (const earlier of previous) {
            const shared = [...words].filter((word) => earlier.includes(word));
            if (words.size > 0 && shared.length / words.size > 0.7) {
              failures.push(`${exchange.replies[index]?.who} echoed an earlier reply`);
              break;
            }
          }
        }
        score("no chorus: replies differ", failures, report("chorus", [exchange]));
      },
      TURN_TIMEOUT_MS * 4,
    );
  }
});
