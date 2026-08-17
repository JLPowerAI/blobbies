/**
 * The index behind the search palette.
 *
 * Everything searchable already lives in memory or in one cheap read per Blob
 * (transcripts, home folders, routines), so the palette builds one flat index
 * when it opens and filters that per keystroke — re-walking every transcript
 * on every character would be the expensive shape.
 *
 * Rows carry only what a row renders plus what activating one needs; nothing
 * here reaches back into the store.
 */

import type { Agent, Message, Routine } from "@/data/agents";
import type { HomeEntry } from "@/lib/home";
import { formatAgentTime } from "@/lib/time";

/** Tabs, in the order the palette shows them. */
const SEARCH_KINDS = ["message", "blob", "group", "file", "link", "routine", "action"] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

/** App-level jumps the palette can perform. Usage/billing is deliberately absent. */
export type SearchAction =
  | "chat-settings"
  | "settings-general"
  | "settings-model"
  | "settings-updates"
  | "plugins";

interface RowBase {
  /** Stable within one index build; also the React key. */
  id: string;
  title: string;
  subtitle: string;
  /**
   * Text to match instead of the title, when the title is a shortened view of
   * something longer (a message). Keeps a match deep in a long message findable
   * without putting the whole message in the DOM.
   */
  haystack?: string;
}

export type SearchResult =
  | (RowBase & { kind: "message"; blobId: string; at: number })
  | (RowBase & { kind: "blob"; blobId: string; at: number })
  | (RowBase & { kind: "group"; groupId: string; at: number })
  | (RowBase & { kind: "file"; blobId: string; fileName: string; at: number })
  | (RowBase & { kind: "link"; url: string; blobId: string; at: number })
  | (RowBase & { kind: "routine"; blobId: string; routineId: string; at: number })
  | (RowBase & { kind: "action"; action: SearchAction; at: number });

type SearchIndex = Record<SearchKind, SearchResult[]>;

/** The plain text of a message, whatever kind it is. */
function messageText(message: Message): string {
  if (message.kind === "text") {
    return message.segments.map((segment) => segment.text).join("");
  }
  return message.kind === "file" ? message.fileName : message.text;
}

/**
 * Markdown links first (their label is the only title we ever get), then every
 * bare URL. Only http(s): a palette row hands its URL to the system browser,
 * so no other scheme may enter the index.
 */
const MARKDOWN_LINK = /\[([^\]\n]{1,160})\]\((https?:\/\/[^\s)]{1,2000})\)/g;
const BARE_URL = /https?:\/\/[^\s<>()[\]"'`]{1,2000}/g;
/** Sentence punctuation that trails a URL in prose is not part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

/** Every http(s) URL in `text`, with its markdown label when it had one. */
export function extractLinks(text: string): { url: string; label?: string }[] {
  const labels = new Map<string, string>();
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const url = match[2]?.replace(TRAILING_PUNCTUATION, "") ?? "";
    const label = match[1]?.trim() ?? "";
    if (url !== "" && label !== "" && !labels.has(url)) {
      labels.set(url, label);
    }
  }
  const found: { url: string; label?: string }[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(BARE_URL)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (url === "" || seen.has(url)) {
      continue;
    }
    seen.add(url);
    const label = labels.get(url);
    found.push(label === undefined ? { url } : { url, label });
  }
  return found;
}

/** "theverge.com/column/980337" — the readable half of a URL. */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
    return `${parsed.host}${rest}`;
  } catch {
    return url;
  }
}

/** Host without "www.", used as a link's title when nothing named it. */
function hostName(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The name the user recognises: an extracted attachment is stored as
 * `report.pdf.txt`, and the `.txt` is our storage detail, not their file.
 */
export function displayFileName(name: string): string {
  const parts = name.split(".");
  return parts.length > 2 && parts.at(-1)?.toLowerCase() === "txt"
    ? parts.slice(0, -1).join(".")
    : name;
}

function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/** Actions the palette offers; `chat-settings` needs an open conversation. */
const ACTIONS: { action: SearchAction; title: string; subtitle: string }[] = [
  { action: "chat-settings", title: "Chat Settings", subtitle: "Current chat" },
  { action: "settings-general", title: "Settings: General", subtitle: "Settings" },
  { action: "settings-model", title: "Settings: Model", subtitle: "Settings" },
  { action: "settings-updates", title: "Settings: Updates", subtitle: "Settings" },
  // No subtitle: the title already says everything the row does.
  { action: "plugins", title: "Plugins", subtitle: "" },
];

interface IndexInput {
  agents: Agent[];
  /** Transcript per Blob id; a missing entry just contributes nothing. */
  transcripts: Record<string, Message[]>;
  /** Home-folder listing per Blob id. */
  files: Record<string, HomeEntry[]>;
  routines: Record<string, Routine[]>;
  /**
   * Group chats, with the names of their members — which is what a group is
   * searchable by besides its own name. Group *messages* are not indexed:
   * unlike a Blob's transcript there is no per-Blob read that would find them.
   */
  groups?: { id: string; name: string; memberNames: string[] }[];
  /** False with no conversation open, which hides the Chat Settings action. */
  hasChat: boolean;
  /** Injectable clock, so message timestamps render deterministically in tests. */
  now?: number;
}

/** Longest row title kept; the row itself can never show more than one line. */
const ROW_TEXT_CHARS = 200;

/** Newest first, with a stable tiebreak so rows never shuffle between renders. */
function byNewest(a: SearchResult, b: SearchResult): number {
  return b.at - a.at || a.title.localeCompare(b.title);
}

/** Build every row the palette can show. Pure: same input, same rows. */
export function buildIndex({
  agents,
  transcripts,
  files,
  routines,
  groups = [],
  hasChat,
  now = Date.now(),
}: IndexInput): SearchIndex {
  const index: SearchIndex = {
    message: [],
    blob: [],
    group: [],
    file: [],
    link: [],
    routine: [],
    action: [],
  };
  /** Newest sighting of a URL wins its row; earlier ones only add a label. */
  const links = new Map<string, Extract<SearchResult, { kind: "link" }>>();

  for (const [position, group] of groups.entries()) {
    index.group.push({
      kind: "group",
      id: `group-${group.id}`,
      groupId: group.id,
      title: group.name,
      subtitle: group.memberNames.length === 0 ? "No Blobs yet" : group.memberNames.join(", "),
      // Members are part of what the user remembers a group by.
      haystack: `${group.name} ${group.memberNames.join(" ")}`,
      // Groups have no activity clock of their own yet, so sidebar order is
      // the ranking — negative, to keep byNewest's ordering stable.
      at: -position,
    });
  }

  for (const agent of agents) {
    index.blob.push({
      kind: "blob",
      id: `blob-${agent.id}`,
      blobId: agent.id,
      title: agent.name,
      subtitle: agent.title ?? agent.description ?? agent.snippet,
      at: agent.lastActivityAt ?? 0,
    });

    for (const routine of routines[agent.id] ?? []) {
      index.routine.push({
        kind: "routine",
        id: `routine-${agent.id}-${routine.id}`,
        blobId: agent.id,
        routineId: routine.id,
        title: routine.name,
        subtitle: `${routine.triggers[0] ?? "Manual"} \u00b7 ${agent.name}`,
        at: routine.lastRunAt ?? routine.nextRunAt ?? 0,
      });
    }

    for (const entry of files[agent.id] ?? []) {
      if (entry.isDir) {
        continue;
      }
      index.file.push({
        kind: "file",
        id: `file-${agent.id}-${entry.name}`,
        blobId: agent.id,
        fileName: entry.name,
        title: displayFileName(entry.name),
        subtitle: `${agent.name} \u00b7 ${fileSize(entry.size)}`,
        at: entry.modifiedMs,
      });
    }

    for (const message of transcripts[agent.id] ?? []) {
      const text = messageText(message).trim();
      const at = message.timestampMs ?? agent.lastActivityAt ?? 0;
      if (text !== "") {
        index.message.push({
          kind: "message",
          id: `message-${agent.id}-${message.id}`,
          blobId: agent.id,
          // One line, and only as much of it as a row can ever show.
          title: text.replace(/\s+/g, " ").slice(0, ROW_TEXT_CHARS),
          subtitle: `${agent.name} \u00b7 ${formatAgentTime(at, now)}`,
          haystack: text,
          at,
        });
      }
      for (const { url, label } of extractLinks(text)) {
        const existing = links.get(url);
        if (existing === undefined) {
          links.set(url, {
            kind: "link",
            id: `link-${url}`,
            url,
            blobId: agent.id,
            title: label ?? hostName(url),
            subtitle: shortUrl(url),
            at,
          });
        } else if (at >= existing.at) {
          links.set(url, { ...existing, blobId: agent.id, at, title: label ?? existing.title });
        }
      }
    }
  }

  index.link = [...links.values()];
  for (const [position, { action, title, subtitle }] of ACTIONS.entries()) {
    if (action === "chat-settings" && !hasChat) {
      continue;
    }
    // Actions are a fixed menu, so their "recency" is just the listed order.
    index.action.push({
      kind: "action",
      id: `action-${action}`,
      action,
      title,
      subtitle,
      at: -position,
    });
  }

  for (const kind of SEARCH_KINDS) {
    if (kind !== "action") {
      index[kind].sort(byNewest);
    }
  }
  return index;
}

/** Case-insensitive substring match over a row's own text. */
export function filterRows(rows: SearchResult[], query: string): SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return rows;
  }
  return rows.filter(
    (row) =>
      (row.haystack ?? row.title).toLowerCase().includes(needle) ||
      row.subtitle.toLowerCase().includes(needle),
  );
}
