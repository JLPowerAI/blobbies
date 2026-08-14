import type { BlobMemory } from "@/lib/blob-tools";

/** Mutable Blob state a scenario acts on, mirroring what App.tsx persists. */
export interface SimBlob {
  name: string;
  title?: string;
  description?: string;
  memories: BlobMemory[];
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
];
