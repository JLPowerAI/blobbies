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
  time: string;
  snippet: string;
  tone: AvatarTone;
  shape: AgentShape;
  unread?: boolean;
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
    }
  | {
      id: string;
      kind: "file";
      author: "agent";
      fileName: string;
      meta: string;
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

/** Fallback transcript for agents without a seeded conversation. */
export function transcriptFor(agent: Agent): Message[] {
  const seeded = transcripts[agent.id];
  if (seeded !== undefined) {
    return seeded;
  }
  return [
    {
      id: `${agent.id}-status`,
      kind: "text",
      author: "agent",
      segments: [{ text: agent.snippet }],
    },
  ];
}
