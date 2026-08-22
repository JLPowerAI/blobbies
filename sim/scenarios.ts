import type { Routine } from "@/data/agents";
import type { BlobMemory } from "@/lib/blob-tools";
import type { RoutineSchedule } from "@/lib/schedule";

/** Mutable Blob state a scenario acts on, mirroring what App.tsx persists. */
export interface SimBlob {
  name: string;
  title?: string;
  description?: string;
  memories: BlobMemory[];
  /** This Blob's routines, mirroring App's per-Blob routine store. */
  routines?: Routine[];
}

/** What one turn produced: the reply plus every tool the model actually ran. */
export interface TurnOutcome {
  reply: string;
  tools: { name: string; args: Record<string, unknown> }[];
  blob: SimBlob;
  /** Wall time for the turn, to catch prompts that make a model ramble. */
  ms: number;
}

/** A single assertion about a turn. Returns null when satisfied. */
export type Check = (outcome: TurnOutcome) => string | null;

export interface SimTurn {
  say: string;
  /** Every check must pass for the turn to count as a pass. */
  expect: Check[];
}

export interface Scenario {
  name: string;
  /** Starting state; omit title/description to simulate a brand-new Blob. */
  start: SimBlob;
  turns: SimTurn[];
}

// --- check builders -------------------------------------------------------

/** The named tool ran at least once this turn. */
export const calledTool =
  (name: string): Check =>
  (outcome) =>
    outcome.tools.some((call) => call.name === name)
      ? null
      : `expected tool ${name}, got [${outcome.tools.map((c) => c.name).join(", ") || "none"}]`;

/** No tool ran: the turn should have been plain conversation. */
export const calledNoTools: Check = (outcome) =>
  outcome.tools.length === 0
    ? null
    : `expected no tools, got [${outcome.tools.map((c) => c.name).join(", ")}]`;

/** Blob ended the turn configured (title and description both non-empty). */
export const isConfigured: Check = (outcome) =>
  (outcome.blob.title ?? "") !== "" && (outcome.blob.description ?? "") !== ""
    ? null
    : `blob not configured: title=${JSON.stringify(outcome.blob.title)} description=${JSON.stringify(
        outcome.blob.description,
      )}`;

/** The Blob's config mentions one of these words — did it grasp the role? */
export const configMentions =
  (...words: string[]): Check =>
  (outcome) => {
    const haystack = `${outcome.blob.title ?? ""} ${outcome.blob.description ?? ""}`.toLowerCase();
    return words.some((word) => haystack.includes(word.toLowerCase()))
      ? null
      : `config mentions none of [${words.join(", ")}]: ${JSON.stringify(haystack.slice(0, 120))}`;
  };

/** Exactly `count` memories are stored. */
export const memoryCount =
  (count: number): Check =>
  (outcome) =>
    outcome.blob.memories.length === count
      ? null
      : `expected ${count} memories, got ${outcome.blob.memories.length}: ${JSON.stringify(
          outcome.blob.memories.map((memory) => memory.text),
        )}`;

/** Some stored memory contains this substring. */
export const memoryMentions =
  (word: string): Check =>
  (outcome) =>
    outcome.blob.memories.some((memory) => memory.text.toLowerCase().includes(word.toLowerCase()))
      ? null
      : `no memory mentions "${word}": ${JSON.stringify(
          outcome.blob.memories.map((memory) => memory.text),
        )}`;

/** No stored memory contains this substring (e.g. a fact that was corrected). */
export const memoryOmits =
  (word: string): Check =>
  (outcome) =>
    outcome.blob.memories.some((memory) => memory.text.toLowerCase().includes(word.toLowerCase()))
      ? `a memory still mentions "${word}": ${JSON.stringify(
          outcome.blob.memories.map((memory) => memory.text),
        )}`
      : null;

/** The reply contains at least one of these words: proof it kept context. */
export const replyMentions =
  (...words: string[]): Check =>
  (outcome) =>
    words.some((word) => outcome.reply.toLowerCase().includes(word.toLowerCase()))
      ? null
      : `reply mentions none of [${words.join(", ")}]: ${JSON.stringify(
          outcome.reply.replace(/\s+/g, " ").slice(0, 140),
        )}`;

/** The reply is non-empty and not an internal error string. */
export const replied: Check = (outcome) => {
  const text = outcome.reply.trim();
  if (text === "") {
    return "empty reply";
  }
  if (/couldn't reach the local model|no response from the model/i.test(text)) {
    return `error reply: ${text.slice(0, 80)}`;
  }
  return null;
};

/** Guards against a prompt that makes a small model monologue. */
export const replyUnder =
  (chars: number): Check =>
  (outcome) =>
    outcome.reply.length <= chars
      ? null
      : `reply ${outcome.reply.length} chars > ${chars}: ${JSON.stringify(outcome.reply.slice(0, 100))}`;

/** The named tool did NOT run: for turns that must stay plain conversation. */
export const notCalledTool =
  (name: string): Check =>
  (outcome) =>
    outcome.tools.some((call) => call.name === name)
      ? `expected no ${name} call, got [${outcome.tools.map((c) => c.name).join(", ")}]`
      : null;

/** The reply avoids these phrases — scores away the failure-lore wording
 * ("No routine was created", "I can't schedule…") that live transcripts
 * showed once the catalog and the prompt disagreed. */
export const replyOmits =
  (...phrases: string[]): Check =>
  (outcome) => {
    const text = outcome.reply.toLowerCase();
    const hit = phrases.find((phrase) => text.includes(phrase.toLowerCase()));
    return hit === undefined
      ? null
      : `reply says "${hit}": ${JSON.stringify(outcome.reply.slice(0, 120))}`;
  };

/** A routine was created this scenario with the expected shape. `hour` for
 * daily, `minutes` as an inclusive range for once (the model may round). */
export const createdRoutine =
  (expected: { kind: RoutineSchedule["kind"]; hour?: number; minutes?: [number, number] }): Check =>
  (outcome) => {
    const created = (outcome.blob.routines ?? []).at(-1);
    if (created === undefined) {
      return `expected a routine to be created, got none (reply: ${JSON.stringify(outcome.reply.slice(0, 120))})`;
    }
    const schedule = created.schedule;
    if (schedule === undefined || schedule.kind !== expected.kind) {
      return `expected kind ${expected.kind}, got ${JSON.stringify(schedule)}`;
    }
    if (
      expected.hour !== undefined &&
      schedule.kind === "daily" &&
      schedule.hour !== expected.hour
    ) {
      return `expected hour ${expected.hour}, got ${schedule.hour}`;
    }
    if (expected.minutes !== undefined && schedule.kind === "once") {
      const [lo, hi] = expected.minutes;
      if (schedule.minutes < lo || schedule.minutes > hi) {
        return `once minutes ${schedule.minutes} outside [${lo}, ${hi}]`;
      }
    }
    return null;
  };

// --- scenarios ------------------------------------------------------------

const newBlob = (name: string): SimBlob => ({ name, memories: [] });

/**
 * The lifecycle a real user drives: set the Blob up, let it remember things,
 * correct one of them, drop another, then change the Blob's job entirely.
 */
export const scenarios: Scenario[] = [
  {
    name: "setup: configures itself from one sentence",
    start: newBlob("Ken"),
    turns: [
      {
        say: "Just be my therapist",
        expect: [replied, isConfigured, configMentions("therap", "listen", "support")],
      },
    ],
  },
  {
    name: "setup: a task-shaped request, not a persona",
    start: newBlob("Ken"),
    turns: [
      {
        say: "I need help keeping track of my gym workouts and what weights I lift",
        expect: [replied, isConfigured, configMentions("workout", "gym", "fitness", "train")],
      },
    ],
  },
  {
    name: "memory: saves a durable fact when told to remember",
    start: { ...newBlob("Ken"), title: "Coach", description: "Helps Ken train." },
    turns: [
      {
        say: "Remember that I train on Mondays and Thursdays.",
        expect: [replied, calledTool("remember"), memoryMentions("monday")],
      },
    ],
  },
  {
    name: "memory: corrects a fact instead of storing a contradiction",
    start: {
      ...newBlob("Ken"),
      title: "Coach",
      description: "Helps Ken train.",
      memories: [{ id: "aaa11111", text: "Ken trains on Mondays and Thursdays", createdAt: 1 }],
    },
    turns: [
      {
        say: "Actually I moved my training to Tuesdays and Fridays. Update what you remember.",
        expect: [replied, memoryCount(1), memoryMentions("tuesday"), memoryOmits("monday")],
      },
    ],
  },
  {
    name: "memory: catches a fact mentioned in passing, unprompted",
    start: { ...newBlob("Ken"), title: "Coach", description: "Helps Ken train." },
    turns: [
      {
        // Nobody says "remember this" in real conversation.
        say: "I'm knackered today, my new job at Acme has me starting at 6am every morning.",
        expect: [replied, memoryCount(1), memoryMentions("acme")],
      },
    ],
  },
  {
    name: "memory: a life change replaces the stale fact, not sits beside it",
    start: {
      ...newBlob("Ken"),
      title: "Companion",
      description: "Chats with Ken.",
      memories: [{ id: "ccc11111", text: "Ken's girlfriend is called Sarah", createdAt: 1 }],
    },
    turns: [
      {
        // The old fact is not corrected wording, it is no longer true.
        say: "Rough week. Sarah and I broke up on Tuesday.",
        expect: [replied, memoryCount(1), memoryOmits("girlfriend is called")],
      },
    ],
  },
  {
    name: "memory: a new job supersedes the old employer",
    start: {
      ...newBlob("Ken"),
      title: "Assistant",
      description: "Helps Ken with work.",
      memories: [{ id: "ddd11111", text: "Ken works at Acme as a designer", createdAt: 1 }],
    },
    turns: [
      {
        say: "I left Acme last month, I'm at Beta Corp now doing the same kind of work.",
        expect: [
          replied,
          memoryCount(1),
          memoryMentions("beta"),
          memoryOmits("acme as a designer"),
        ],
      },
    ],
  },
  {
    name: "memory: forgets on request",
    start: {
      ...newBlob("Ken"),
      title: "Coach",
      description: "Helps Ken train.",
      memories: [{ id: "bbb22222", text: "Ken is allergic to peanuts", createdAt: 1 }],
    },
    turns: [
      {
        say: "Forget what you know about my allergies.",
        expect: [replied, memoryCount(0)],
      },
    ],
  },
  {
    name: "reconfigure: changes role when the user's needs change",
    start: {
      ...newBlob("Ken"),
      title: "Gym Coach",
      description: "Tracks Ken's workouts and lifts.",
      memories: [],
    },
    turns: [
      {
        say: "Stop being my gym coach. I want you to help me write blog posts instead.",
        expect: [replied, configMentions("writ", "blog", "content")],
      },
    ],
  },
  {
    name: "conversation: recalls what was said one turn ago",
    start: { ...newBlob("Ken"), title: "Companion", description: "Chats with Ken." },
    turns: [
      { say: "I'm planning a trip to Lisbon in October.", expect: [replied] },
      {
        // "it" is the only reference to the trip: the reply must name the
        // place or the month, which appear nowhere in this turn. Generic
        // packing words (layers, jacket, rain) are deliberately NOT accepted —
        // any model answers that way with no memory of the conversation at
        // all, so they would make this scenario pass while proving nothing.
        say: "What should I pack for it?",
        expect: [replied, replyMentions("lisbon", "portugal", "october", "autumn", "fall")],
      },
    ],
  },
  {
    name: "conversation: holds a detail across several turns",
    start: { ...newBlob("Ken"), title: "Companion", description: "Chats with Ken." },
    turns: [
      { say: "My dog is called Biscuit and he's a beagle.", expect: [replied] },
      { say: "He's been limping since yesterday.", expect: [replied] },
      { say: "Do you think I should take him to the vet?", expect: [replied] },
      {
        // Four turns later, the name only ever appeared in turn one.
        say: "What's my dog's name again?",
        expect: [replied, replyMentions("biscuit")],
      },
    ],
  },
  {
    name: "conversation: follows a pronoun back to the earlier subject",
    start: { ...newBlob("Ken"), title: "Assistant", description: "Helps Ken." },
    turns: [
      { say: "I'm reading Dune at the moment.", expect: [replied] },
      { say: "Who wrote it?", expect: [replied, replyMentions("herbert")] },
    ],
  },
  {
    name: "restraint: plain chat does not trigger tools",
    start: {
      ...newBlob("Ken"),
      title: "Coach",
      description: "Helps Ken train.",
      memories: [{ id: "ccc33333", text: "Ken trains on Mondays", createdAt: 1 }],
    },
    turns: [
      {
        say: "What day do I train?",
        expect: [replied, replyUnder(600), calledNoTools, memoryCount(1)],
      },
    ],
  },
  {
    // The mirror of restraint: web tools are gated behind the router's
    // No verdict gates the catalog now, so this proves the tools are reachable
    // here would silently amputate search from every Blob.
    name: "web: an explicit search request still reaches the web",
    start: { ...newBlob("Ken"), title: "Assistant", description: "Helps Ken." },
    turns: [
      {
        say: "Search the web for the latest Ollama release and tell me what's new.",
        expect: [replied, calledTool("web_search")],
      },
    ],
  },
  {
    // Live transcripts (2026-08-19) drove these three: a chat request for a
    // routine must become a real create_routine call with the stated time,
    // not a refusal with failure-lore wording, and not a trip through
    // connected apps hunting for a scheduler.
    name: "routines: creates a daily check-in at the stated time",
    start: {
      ...newBlob("Timmy"),
      title: "Companion",
      description: "Checks in with Ken.",
      routines: [],
    },
    turns: [
      {
        say: "Check in on me every day at 3pm.",
        expect: [
          replied,
          calledTool("create_routine"),
          createdRoutine({ kind: "daily", hour: 15 }),
          replyOmits(
            "no routine was created",
            "can't schedule",
            "cannot schedule",
            "can't create a routine",
            "connected app",
          ),
        ],
      },
      {
        // Follow-up recall: confirm the schedule the tool result reported,
        // not one invented on the spot.
        say: "What did you just set up, and for when?",
        // "3:00 PM" is the phrasing a stronger model reaches for; the list
        // was written against a small local one and would fail a better
        // answer for being better written.
        expect: [replied, replyMentions("15:00", "3pm", "3 pm", "15.00", "3:00")],
      },
    ],
  },
  {
    name: "routines: a one-shot delay is a 'once' routine, not a refusal",
    start: {
      ...newBlob("Timmy"),
      title: "Companion",
      description: "Checks in with Ken.",
      routines: [],
    },
    turns: [
      {
        say: "Check in on me in 2 minutes.",
        expect: [
          replied,
          calledTool("create_routine"),
          // 1–5, not exactly 2: the model may round; a refusal reads as none.
          createdRoutine({ kind: "once", minutes: [1, 5] }),
          replyOmits(
            "no routine was created",
            "can't schedule",
            "cannot schedule",
            "one-time reminder",
          ),
        ],
      },
    ],
  },
  {
    name: "routines: no time of day given asks for it, creates nothing",
    start: {
      ...newBlob("Timmy"),
      title: "Companion",
      description: "Checks in with Ken.",
      routines: [],
    },
    turns: [
      {
        say: "Check in on me every day.",
        expect: [
          replied,
          // "Never invent a time" — the turn asks, the tool is not called.
          notCalledTool("create_routine"),
          replyMentions("?"),
        ],
      },
    ],
  },
];
