/**
 * Domain types for Blobs, messages and routines, plus seed data. Blobs start
 * empty; the first-run creator makes the first one.
 */

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
  /** Pinned Blobs sort to the top of the sidebar. */
  pinned?: boolean;
  /** Hidden Blobs stay in the roster but are not listed in the sidebar. */
  hidden?: boolean;
  /** Lasting facts the Blob saved via its remember tool. */
  memories?: import("@/lib/blob-tools").BlobMemory[];
  /** Short role line, e.g. "Handles my inbox". */
  title?: string;
  /** Longer free-form purpose notes. */
  description?: string;
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
    }
  | {
      id: string;
      kind: "file";
      author: "agent";
      fileName: string;
      meta: string;
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
