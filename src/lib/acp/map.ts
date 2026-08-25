/**
 * Pure translation between Blobbies conversations and the Agent Client
 * Protocol's session vocabulary.
 *
 * Deliberately free of React, Tauri and the SDK's runtime: everything here is
 * a function of its arguments, so the parts that decide what an editor sees —
 * which Blob a session names, what a tool call is called, how a stored
 * transcript replays — are testable without an app, and the ACP host above it
 * stays a thin wiring layer.
 */

import type {
  AvailableCommand,
  ContentBlock,
  SessionUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { Agent, Message } from "@/data/agents";
import { type Group, groupConversationId, groupIdFromConversation } from "@/lib/groups";

/**
 * What an ACP session is bound to.
 *
 * A session id IS a conversation id — the Blob's id, or `group:<id>` — so an
 * editor that reconnects with a stored session id lands back in the same
 * transcript the app shows, with no second mapping to keep in sync.
 */
export type AcpTarget = { kind: "blob"; blob: Agent } | { kind: "group"; group: Group };

/** The conversation id (and therefore session id) a target speaks in. */
export function conversationIdFor(target: AcpTarget): string {
  return target.kind === "blob" ? target.blob.id : groupConversationId(target.group.id);
}

/**
 * Resolve a session id back to what it addresses, or null when the Blob or
 * group is gone — deleted between two editor sessions is the normal case, and
 * it has to read as "unknown session", never as a turn sent nowhere.
 */
export function targetForSession(
  sessionId: string,
  roster: readonly Agent[],
  groups: readonly Group[],
): AcpTarget | null {
  const groupId = groupIdFromConversation(sessionId);
  if (groupId !== null) {
    const group = groups.find((candidate) => candidate.id === groupId);
    return group === undefined ? null : { kind: "group", group };
  }
  const blob = roster.find((candidate) => candidate.id === sessionId);
  return blob === undefined ? null : { kind: "blob", blob };
}

/** Case- and space-insensitive name lookup: the editor's user typed this. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function findBlob(roster: readonly Agent[], name: string): Agent | undefined {
  return roster.find((candidate) => sameName(candidate.name, name));
}

export function findGroup(groups: readonly Group[], name: string): Group | undefined {
  return groups.find((candidate) => sameName(candidate.name, name));
}

/**
 * Slash commands offered to the editor.
 *
 * The portable way to reach the roster on ACP v1, which has no concept of
 * "which agent am I talking to": the client renders these in its command
 * palette, and the strings are what the user picks from.
 */
export const ACP_COMMANDS: AvailableCommand[] = [
  { name: "blobs", description: "List your Blobs" },
  { name: "groups", description: "List your groups" },
  {
    name: "blob",
    description: "Talk to a Blob by name",
    input: { hint: "Blob name" },
  },
  {
    name: "group",
    description: "Talk to a group by name",
    input: { hint: "Group name" },
  },
];

export interface AcpCommand {
  name: string;
  /** Everything typed after the command name, trimmed. */
  argument: string;
}

/**
 * Split a leading `/command` off a prompt.
 *
 * Only a first-line, first-character slash counts: a prompt that merely
 * mentions a path or quotes a command is a message for the Blob, not a
 * command for the bridge.
 */
export function parseCommand(text: string): AcpCommand | null {
  const match = /^\/([a-z][\w-]*)(?:[ \t]+([\s\S]*))?$/.exec(text.trim());
  if (match === null) {
    return null;
  }
  const [, name, argument] = match;
  return name === undefined ? null : { name, argument: argument?.trim() ?? "" };
}

/**
 * ACP's tool category for one of the Blob catalog's tools.
 *
 * Only what the protocol has a word for; everything else (memories, roster
 * edits, routines, MCP and Composio calls) is "other" rather than a category
 * that would render a misleading icon in the editor.
 */
const TOOL_KINDS: Record<string, ToolKind> = {
  read_file: "read",
  list_files: "read",
  write_file: "edit",
  delete_file: "delete",
  delete_blob: "delete",
  delete_routine: "delete",
  forget: "delete",
  run_command: "execute",
  app_run_tool: "execute",
  web_fetch: "fetch",
  web_search: "search",
  app_find_tool: "search",
  take_screenshot: "read",
};

export function toolKind(toolName: string): ToolKind {
  return TOOL_KINDS[toolName] ?? "other";
}

/** How a group member's line is labelled — v1 has no multi-speaker concept. */
export function speakerPrefix(name: string): string {
  return `**${name}:** `;
}

/** The words in an ACP prompt; non-text blocks are named, not dropped silently. */
export function promptText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "resource":
          return "text" in block.resource ? block.resource.text : `[${block.resource.uri}]`;
        case "resource_link":
          return `[${block.name}](${block.uri})`;
        default:
          return `[${block.type}]`;
      }
    })
    .filter((part) => part.trim() !== "")
    .join("\n\n");
}

/**
 * Replay a stored transcript as `session/load` updates.
 *
 * Text only: an editor showing history has no use for a run's event lines,
 * and attachments live in a Blob's home folder rather than in the protocol.
 * In a group each Blob's line carries its name, because the client renders
 * every agent chunk as one speaker.
 */
export function transcriptUpdates(
  messages: readonly Message[],
  options?: { nameOf?: (blobId: string) => string | undefined },
): SessionUpdate[] {
  const updates: SessionUpdate[] = [];
  for (const message of messages) {
    if (message.kind !== "text") {
      continue;
    }
    const body = message.segments.map((segment) => segment.text).join("");
    if (body.trim() === "") {
      continue;
    }
    const speaker =
      message.author === "agent" && message.authorId !== undefined
        ? options?.nameOf?.(message.authorId)
        : undefined;
    updates.push({
      sessionUpdate: message.author === "user" ? "user_message_chunk" : "agent_message_chunk",
      content: {
        type: "text",
        text: speaker === undefined ? body : `${speakerPrefix(speaker)}${body}`,
      },
    });
  }
  return updates;
}
