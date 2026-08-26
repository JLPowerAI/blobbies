/**
 * Domain types for Blobs, messages and routines, plus seed data. Blobs start
 * empty; the first-run creator makes the first one.
 */

// Type-only, so this never becomes a runtime cycle (attachments → blob-tools
// → this module).
import type { Attachment } from "@/lib/attachments";
import { configFieldEmpty } from "@/lib/prompt";

export type AvatarTone =
  | "purple"
  | "blue"
  | "green"
  | "teal"
  | "brown"
  | "orange"
  | "gold"
  | "red"
  | "pink"
  | "gray"
  | "cream";

export type AgentShape =
  | "sphere"
  | "droplet"
  | "cloud"
  | "egg"
  | "pebble"
  | "triangle"
  | "squircle"
  | "bean";

/** Every tone/shape the avatar renderer knows, in UI order. */
export const AVATAR_TONES: AvatarTone[] = [
  "purple",
  "blue",
  "green",
  "teal",
  "brown",
  "orange",
  "gold",
  "red",
  "pink",
  "gray",
  "cream",
];
export const AGENT_SHAPES: AgentShape[] = [
  "sphere",
  "droplet",
  "cloud",
  "egg",
  "pebble",
  "triangle",
  "squircle",
  "bean",
];

/**
 * A style for a newly born Blob that still has one nobody else wears.
 *
 * Unused-first, so a batch of spawns reads as a varied set rather than N gray
 * spheres; once the roster outgrows the palette it falls back to any member.
 */
export function freshBlobStyle(taken: { tone: AvatarTone; shape: AgentShape }[]): {
  tone: AvatarTone;
  shape: AgentShape;
} {
  const pick = <T>(options: T[]): T | undefined =>
    options[Math.floor(Math.random() * options.length)];
  const tones = AVATAR_TONES.filter((tone) => !taken.some((blob) => blob.tone === tone));
  const shapes = AGENT_SHAPES.filter((shape) => !taken.some((blob) => blob.shape === shape));
  // The literal fallbacks are unreachable (both palettes are non-empty), but
  // indexed access is `T | undefined` under noUncheckedIndexedAccess.
  return {
    tone: pick(tones) ?? pick(AVATAR_TONES) ?? "gray",
    shape: pick(shapes) ?? pick(AGENT_SHAPES) ?? "sphere",
  };
}

/**
 * A name the sidebar can display as words: "youtube-blob" → "YouTube Blob".
 *
 * Models love slugging names; people read Title Case. Dashes and underscores
 * become spaces, whitespace collapses, each word capitalises. Applied before
 * the duplicate check, so "youtube-blob" and "YouTube Blob" are the same
 * Blob and a retried spawn stays idempotent.
 */
export function formatBlobName(raw: string): string {
  return raw
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => (word === "" ? word : (word[0] ?? "").toUpperCase() + word.slice(1)))
    .join(" ");
}

export interface Agent {
  id: string;
  name: string;
  /** Legacy display string; superseded by lastActivityAt when present. */
  time: string;
  /** Epoch ms of the newest message, drives the sidebar timestamp. */
  lastActivityAt?: number;
  snippet: string;
  tone: AvatarTone;
  shape: AgentShape;
  unread?: boolean;
  /** Pinned Blobs leave the list for the tray of avatar tiles at the top. */
  pinned?: boolean;
  /**
   * Name of the group this Blob sits in — which is also its membership of
   * that group's chat. Anything that is not a current group name — absent,
   * empty, or a deleted group — reads as the ungrouped run above them, so
   * removing a group never strands its Blobs.
   */
  section?: string;
  /** Hidden Blobs stay in the roster but are not listed in the sidebar. */
  hidden?: boolean;
  /**
   * This Blob opened its conversation with the setup greeting — set once, at
   * creation, for a Blob born without a role.
   *
   * Recorded rather than re-derived from `title`/`description`, because those
   * change: the setup round fills them in on the first turn, and a greeting
   * derived from them would vanish out of a conversation the user is in the
   * middle of reading. Whether those words were said is a fact about the
   * past, so it is stored like one.
   */
  greeted?: boolean;
  /** Lasting facts the Blob saved via its remember tool. */
  memories?: import("@/lib/blob-tools").BlobMemory[];
  /** Short role line, e.g. "Handles my inbox". */
  title?: string;
  /** Longer free-form purpose notes. */
  description?: string;
  /**
   * Hand-written role, used verbatim in place of the generated title +
   * description section. Set from Settings; nothing writes it automatically.
   */
  instructions?: string;
  /**
   * Lifetime tokens through the agent loop, accumulated at each run's end.
   * Local inference has no bill — this exists to explain why replies slow
   * down as a conversation grows, not to price anything.
   */
  usage?: { inputTokens: number; outputTokens: number; runs: number };
  /** Notify when the agent finishes or needs input. Defaults on. */
  notifications?: boolean;
}

export interface TextSegment {
  text: string;
  /** Rendered as an inline link-colored reference (e.g. a Slack channel). */
  accent?: boolean;
}

/**
 * One tool call a Blob made, kept so a later turn can see what it already
 * tried. Deliberately small — this is replayed into every subsequent turn's
 * history, so it has to stay a line, not a transcript.
 */
export interface ToolTraceEntry {
  name: string;
  /** Arguments as sent, clipped. The wrong-argument case is the whole point. */
  args?: string;
  /** Result or error, clipped. Absent when the call returned nothing useful. */
  result?: string;
  /** Whether the call failed — a failed attempt is still an attempt. */
  failed?: boolean;
}

export type Message =
  | {
      id: string;
      kind: "text";
      author: "user" | "agent";
      segments: TextSegment[];
      /**
       * Which Blob said it, in a group chat where several do. Absent in a
       * one-to-one conversation, where the Blob is the one in the header.
       */
      authorId?: string;
      /** Preview of the message this one replies to, shown quoted in the bubble. */
      replyTo?: string;
      /** Id of the message this one replies to; routes a group reply to its author. */
      replyToId?: string;
      /** Epoch ms when the message was created. Absent on legacy entries. */
      timestampMs?: number;
      /**
       * Set when this agent message is a mid-run question: "question" renders
       * a blue-tinted card, "action" a violet "needs you" card with a Done
       * button. The next user message answers it.
       */
      ask?: "question" | "action";
      /**
       * Files the user attached to this message. Metadata only: the text
       * lives in the Blob's home folder and is read back per turn, so a
       * transcript never carries a copy of the file (see lib/attachments).
       */
      attachments?: Attachment[];
      /**
       * What this Blob actually did while producing the message: every tool
       * it called, with its arguments and a clipped result. Not shown in the
       * UI — it is replayed into the next turn's history so a past answer
       * carries the evidence behind it.
       *
       * Measured twice. First (2026-08-25, sim/grounding.sim.ts) history was
       * rebuilt from text alone, so a turn that read a note and reported it
       * came back as "assistant stated a file's contents having called
       * nothing"; asked about a second note the model completed that pattern
       * instead of reading, inventing contents in 3 of 6 turns. Replaying the
       * reads fixed it.
       *
       * That fix only covered `read_file`, and the same hole was reported
       * again the same day with a YouTube app tool: a call failed on a wrong
       * argument name, and with no trace of the attempt in history the Blob
       * re-promised the same fix on every following turn — it could not tell
       * it had already tried. Hence every tool, its arguments, and whether it
       * failed, not just the reads.
       *
       * Replayed into the next turn's history, never rendered: the
       * transcript shows what a Blob said, not the machinery behind it.
       */
      toolTrace?: ToolTraceEntry[];
      /**
       * The turn did not finish: the model was unreachable, or it stopped
       * mid-reply. The text is an explanation rather than an answer, so the
       * message carries Retry and Dismiss instead of standing as something
       * the Blob had to say.
       *
       * On the message rather than in component state because the failure
       * has to survive a reload — a transcript that comes back holding an
       * apology and no way to retry is exactly what this replaces.
       */
      failed?: true;
    }
  | {
      id: string;
      kind: "file";
      author: "agent";
      fileName: string;
      meta: string;
      timestampMs?: number;
    }
  | {
      /** System status line in the transcript, e.g. a routine firing. */
      id: string;
      kind: "event";
      text: string;
      /**
       * A thing the line is ABOUT, shown after the text with its icon — the
       * same clock-and-name pairing the Routines list uses, so a routine is
       * recognisable in the transcript at a glance.
       *
       * Split from `text` rather than baked into it because the two are styled
       * differently: the text is a dim caption, the subject is the name you
       * actually read. Absent on plain status lines.
       */
      subject?: { icon: "routine"; label: string };
      timestampMs?: number;
    };

export interface Routine {
  id: string;
  name: string;
  /** What the Blob should do each time the routine runs. */
  instruction: string;
  /** Trigger labels, e.g. "Every hour" or "Slack message". */
  triggers: string[];
  active: boolean;
  /**
   * When to fire on the clock; absent = no schedule. This is the `cron`
   * member of the trigger family the listeners below complete.
   */
  schedule?: import("@/lib/schedule").RoutineSchedule;
  /**
   * Event listeners — a Slack channel, a GitHub repo — that also fire it. A
   * routine may hold several, and may hold both a schedule and listeners.
   */
  listeners?: import("@/lib/trigger").EventListener[];
  /**
   * Per-listener poll cursors, keyed by `listenerIdentity`. Absent for a
   * listener means "never polled", which arms without firing.
   */
  cursors?: Record<string, import("@/lib/trigger-poll").PollCursor>;
  /** Epoch ms of the next scheduled fire; the scheduler claims it via CAS. */
  nextRunAt?: number;
  /**
   * Fires remaining on a counted interval; absent = unbounded. The scheduler
   * decrements it as its claim and zeroes it when the burst retires itself.
   */
  runsLeft?: number;
  /** Epoch ms of the last completed fire. */
  lastRunAt?: number;
  lastRunStatus?: "done" | "failed" | "cancelled";
}

/** Hard cap for Blob names so sidebar rows and headers never truncate oddly. */
export const MAX_BLOB_NAME_LENGTH = 24;

/**
 * Ceiling on the roster, enforced on every creation path (+ button, Duplicate,
 * `spawn_blob`).
 *
 * Not a storage limit — a blast radius. A routine that loops on spawn_blob
 * would otherwise fill the sidebar with junk Blobs the user has to delete one
 * by one, and every Blob is a scheduler participant.
 *
 * Lives here, not in lib/blob-tools: the sidebar and creator must not
 * statically import that module (startup-bundle budget).
 */
export const MAX_BLOBS = 25;

/**
 * Ceiling on one Blob's routines, enforced on the tool path (create_routine).
 *
 * Same blast-radius reasoning as MAX_BLOBS, with a sharper edge: a routine
 * turn can itself call create_routine, so an uncapped Blob can amplify its
 * own future workload — every routine is a scheduler participant whose fires
 * are model turns against one local model.
 */
export const MAX_ROUTINES = 20;

/**
 * Names a Blob may not take, because `@`-addressing already means something
 * else with them. `@everyone` addresses the room, so a Blob called that could
 * never be reached on its own.
 */
const RESERVED_BLOB_NAMES = ["everyone"];

/**
 * A Blob name nothing else is using, suffixed if need be ("Scout 2").
 *
 * Names are the addressing key: `@Scout` resolves by name, so two Blobs
 * sharing one leaves the second permanently unmentionable — the first match
 * wins and the user has no way to say which they meant. Uniqueness is
 * case-insensitive because the matcher is.
 *
 * `taken` is every OTHER Blob's name; a rename that keeps its own name must
 * not have to fight itself for it.
 *
 * An empty name is returned untouched rather than given a default: the rename
 * field passes through "" on its way to a new name, and inventing one there
 * would type over the user.
 */
export function uniqueBlobName(wanted: string, taken: readonly string[]): string {
  const base = wanted.trim().slice(0, MAX_BLOB_NAME_LENGTH);
  if (base === "") {
    return base;
  }
  const used = new Set([...taken.map((name) => name.trim().toLowerCase()), ...RESERVED_BLOB_NAMES]);
  if (!used.has(base.toLowerCase())) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    // Trimmed to fit the cap WITH its suffix, so a long name does not get
    // sliced back onto the very name it is trying to avoid.
    const tail = ` ${suffix}`;
    const candidate = `${base.slice(0, MAX_BLOB_NAME_LENGTH - tail.length).trim()}${tail}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

/** Blobs start empty; the first-run creator makes the first one. */
export const agents: Agent[] = [];

/**
 * Sample facts for looking at the Memories dialog during development.
 *
 * Deliberately varied in length — some short enough to sit on one line, some
 * long enough to wrap — because a table of uniform strings hides exactly the
 * layout problems worth catching.
 *
 * Applied to a newly created Blob on the dev server only, so a production
 * build never invents things it "remembers" about a real user. Vitest also
 * runs with DEV set, so `createBlob` excludes test mode too — otherwise this
 * fixture would quietly define what the tests think a fresh Blob knows.
 *
 * These are saved with the Blob, so a Blob created in dev carries them on disk
 * and the model is told them on every turn. Delete them from the Memories
 * dialog once the display has been eyeballed, or the Blob will happily talk
 * about a beagle that does not exist.
 */
export const SAMPLE_MEMORIES: import("@/lib/blob-tools").BlobMemory[] = [
  { id: "sample01", text: "Prefers short replies with no preamble", createdAt: 1 },
  { id: "sample02", text: "Has a beagle called Biscuit", createdAt: 2 },
  {
    id: "sample03",
    text: "Trains on Tuesday and Friday evenings, so calls after 6pm on those days never work",
    createdAt: 3,
  },
  { id: "sample04", text: "Sister's birthday is 14 March", createdAt: 4 },
  {
    id: "sample05",
    text: "Is building a desktop app called Blobbies and asks about Rust and React most days",
    createdAt: 5,
  },
];

/**
 * Shared sample facts, so the dialog has both scopes to show.
 *
 * Seeded on hydrate rather than on creation like `SAMPLE_MEMORIES`: a Blob
 * made before that seed existed still has none of its own, and the shared
 * scope is the one place a fact shows up for every Blob including old ones.
 */
export const SAMPLE_USER_MEMORIES: import("@/lib/blob-tools").BlobMemory[] = [
  { id: "shared01", text: "Lives in Kuala Lumpur", createdAt: 1 },
  {
    id: "shared02",
    text: "Works from a cafe on Wednesdays, so mornings are unreliable for calls",
    createdAt: 2,
  },
  { id: "shared03", text: "Goes by Ken, never Kenneth", createdAt: 3 },
];

export const transcripts: Record<string, Message[]> = {};

/** Greeting shown in a fresh conversation (and as the initial snippet). */
export const GREETING = "What do you need me to do?";

/**
 * Setup hint under the greeting, as its own bubble. The question alone leaves
 * the user guessing what they may say first, so the hint names the two things
 * that configure the Blob (what to handle, how they like it) with one
 * concrete example — and says a plain greeting also works, because the
 * configure round then asks instead of guessing a role for them.
 */
export const GREETING_HINT =
  "To set me up, tell me what to handle and how you like it done \u2014 e.g. \u201csummarise my inbox every morning, keep it short\u201d. Or just say hi and I\u2019ll ask a few questions.";

/** Fallback transcript for agents without a seeded conversation. */
export function transcriptFor(agent: Agent): Message[] {
  const seeded = transcripts[agent.id];
  if (seeded !== undefined) {
    return seeded;
  }
  // Only a Blob that greeted keeps the greeting. A Blob born configured —
  // spawner-set title/description (spawn_blob requires both) — never said
  // these words: it would otherwise open with "tell me what to handle" over a
  // role it already has, and this history is fed to the model too, where the
  // canned lines read as its own prior words and quietly argue against the
  // configuration it was born with.
  //
  // `greeted` is the record of what was actually said, written once at
  // creation. The config check is only a fallback for Blobs saved before that
  // flag existed: config changes the moment the setup round runs, so a
  // greeting derived from it disappears out of a conversation mid-read.
  const greeted =
    agent.greeted ?? (configFieldEmpty(agent.title) && configFieldEmpty(agent.description));
  if (!greeted) {
    return [];
  }
  // Fixed text, not agent.snippet: the snippet follows the latest activity,
  // and the greeting must not echo it. Two entries, matching how a real
  // two-paragraph reply is stored (one bubble per segment).
  return [
    {
      id: `${agent.id}-status`,
      kind: "text",
      author: "agent",
      segments: [{ text: GREETING }],
    },
    {
      id: `${agent.id}-hint`,
      kind: "text",
      author: "agent",
      segments: [{ text: GREETING_HINT }],
    },
  ];
}
