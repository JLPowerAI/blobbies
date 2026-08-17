/**
 * Domain types for Blobs, messages and routines, plus seed data. Blobs start
 * empty; the first-run creator makes the first one.
 */

// Type-only, so this never becomes a runtime cycle (attachments → blob-tools
// → this module).
import type { Attachment } from "@/lib/attachments";

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
  | "gray";

export type AgentShape =
  | "sphere"
  | "droplet"
  | "cloud"
  | "egg"
  | "pebble"
  | "triangle"
  | "squircle";

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
   * Name of the sidebar section this Blob sits under. Anything that is not a
   * current section name — absent, empty, or a deleted section — reads as the
   * ungrouped run above them, so removing a section never strands its Blobs.
   */
  section?: string;
  /** Hidden Blobs stay in the roster but are not listed in the sidebar. */
  hidden?: boolean;
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

export type Message =
  | {
      id: string;
      kind: "text";
      author: "user" | "agent";
      segments: TextSegment[];
      /** Preview of the message this one replies to, shown quoted in the bubble. */
      replyTo?: string;
      /** Epoch ms when the message was created. Absent on legacy entries. */
      timestampMs?: number;
      /**
       * Set when this agent message is a mid-run question: "question" renders
       * a highlighted card, "action" an amber "needs you" card with a Done
       * button. The next user message answers it.
       */
      ask?: "question" | "action";
      /**
       * Files the user attached to this message. Metadata only: the text
       * lives in the Blob's home folder and is read back per turn, so a
       * transcript never carries a copy of the file (see lib/attachments).
       */
      attachments?: Attachment[];
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
  /** When to fire automatically; absent = manual-only routine. */
  schedule?: import("@/lib/schedule").RoutineSchedule;
  /** Epoch ms of the next scheduled fire; the scheduler claims it via CAS. */
  nextRunAt?: number;
  /** Epoch ms of the last completed fire. */
  lastRunAt?: number;
  lastRunStatus?: "done" | "failed" | "cancelled";
}

/** Hard cap for Blob names so sidebar rows and headers never truncate oddly. */
export const MAX_BLOB_NAME_LENGTH = 24;

/** Blobs start empty; the first-run creator makes the first one. */
export const agents: Agent[] = [];

export const transcripts: Record<string, Message[]> = {};

/** Greeting shown in a fresh conversation (and as the initial snippet). */
export const GREETING = "What do you need me to do?";

/** Fallback transcript for agents without a seeded conversation. */
export function transcriptFor(agent: Agent): Message[] {
  const seeded = transcripts[agent.id];
  if (seeded !== undefined) {
    return seeded;
  }
  // Fixed text, not agent.snippet: the snippet follows the latest activity,
  // and the greeting must not echo it.
  return [
    {
      id: `${agent.id}-status`,
      kind: "text",
      author: "agent",
      segments: [{ text: GREETING }],
    },
  ];
}
