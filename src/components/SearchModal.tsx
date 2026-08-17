import {
  Clock,
  Command,
  FileText,
  Image as ImageIcon,
  Link2,
  MessageSquareText,
  Plug,
  Search,
  Settings,
  Users,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { BlobAvatar } from "@/components/BlobAvatar";
import type { Agent, Message, Routine } from "@/data/agents";
import { fileBadge, fileKind } from "@/lib/file-kind";
import { type HomeEntry, homeFor } from "@/lib/home";
import { buildIndex, filterRows, type SearchKind, type SearchResult } from "@/lib/search";
import * as store from "@/lib/store";
import { useExitAnimation } from "@/lib/useExitAnimation";

/** Rows rendered per page; scrolling near the end reveals the next page. */
const PAGE_SIZE = 25;
/** Distance from the bottom that counts as "near the end". */
const LOAD_MORE_SLACK = 160;
/** Rows per group on the All tab — it is a summary, the tabs are the depth. */
const ALL_GROUP_CAP = 5;

type TabId = "all" | SearchKind;

interface Tab {
  id: TabId;
  label: string;
  icon: typeof Search;
  /** Nothing of this kind exists at all. */
  empty: string;
  /** Things exist, but none match the query. */
  none: string;
}

const ALL_TAB: Tab = {
  id: "all",
  label: "All",
  icon: Search,
  empty: "Nothing to search yet",
  none: "No results",
};

const TABS: Tab[] = [
  ALL_TAB,
  {
    id: "message",
    label: "Messages",
    icon: MessageSquareText,
    empty: "No messages yet",
    none: "No messages found",
  },
  { id: "blob", label: "Blobs", icon: Search, empty: "No Blobs yet", none: "No Blobs found" },
  {
    id: "group",
    label: "Groups",
    icon: Users,
    empty: "No group chats yet",
    none: "No groups found",
  },
  { id: "file", label: "Files", icon: FileText, empty: "No files yet", none: "No files found" },
  { id: "link", label: "Links", icon: Link2, empty: "No links yet", none: "No links found" },
  {
    id: "routine",
    label: "Routines",
    icon: Clock,
    empty: "No routines yet",
    none: "No routines found",
  },
  {
    id: "action",
    label: "Actions",
    icon: Command,
    empty: "No actions available",
    none: "No actions found",
  },
];

/** Kinds the All tab concatenates, in order. */
const ALL_ORDER: SearchKind[] = ["blob", "group", "message", "file", "link", "routine", "action"];

/** Kinds whose rows need the per-Blob reads (transcripts, routines, files). */
const DEEP_TABS: TabId[] = ["message", "file", "link", "routine"];

interface SearchModalProps {
  agents: Agent[];
  /** Transcripts the app already holds; the rest are read on demand. */
  transcripts: Record<string, Message[]>;
  routines: Record<string, Routine[]>;
  /** Group chats, listed on the Groups tab and switchable from here. */
  groups: { id: string; name: string; memberNames: string[] }[];
  /** False when no conversation is open, which hides the Chat Settings action. */
  hasChat: boolean;
  onSelect: (result: SearchResult) => void;
  onClose: () => void;
}

/** The tile in front of a row: the Blob's avatar, or a kind glyph. */
function RowIcon({ result, agent }: { result: SearchResult; agent: Agent | undefined }) {
  if ((result.kind === "message" || result.kind === "blob") && agent !== undefined) {
    return <BlobAvatar tone={agent.tone} shape={agent.shape} size={26} />;
  }
  if (result.kind === "file") {
    const kind = fileKind(result.title);
    return (
      <span
        className={`attachment-card-icon attachment-card-icon-sm attachment-kind-${kind}`}
        aria-hidden="true"
      >
        {kind === "image" ? (
          <ImageIcon size={12} strokeWidth={1.8} />
        ) : (
          <FileText size={12} strokeWidth={1.8} />
        )}
        <span className="attachment-card-badge">{fileBadge(result.title)}</span>
      </span>
    );
  }
  // Actions wear the icon of where they lead, matching the sidebar footer.
  const action = result.kind === "action" ? result.action : undefined;
  const Glyph =
    result.kind === "group"
      ? Users
      : result.kind === "link"
        ? Link2
        : result.kind === "routine"
          ? Clock
          : action === "plugins"
            ? Plug
            : action === undefined
              ? Command
              : Settings;
  return (
    <span className="search-row-glyph" aria-hidden="true">
      <Glyph size={15} strokeWidth={1.8} />
    </span>
  );
}

/**
 * The search palette: one query across Blobs, their messages, files, links,
 * routines and the app's own actions.
 *
 * Mounted only while open, so mounting is opening. The app hydrates a Blob's
 * transcript and routines only when that Blob is opened, so the palette reads
 * the rest itself — once, and only when a query or one of the deep tabs
 * actually asks. Opening the palette to jump to a Blob costs no disk at all.
 */
export function SearchModal({
  agents,
  groups,
  transcripts,
  routines,
  hasChat,
  onSelect,
  onClose,
}: SearchModalProps) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<TabId>("all");
  const [highlight, setHighlight] = useState(0);
  const [shown, setShown] = useState(PAGE_SIZE);
  /**
   * What the app did not already have in memory. Null until the one read pass
   * has finished, which is also the palette's "still searching" signal.
   */
  const [loaded, setLoaded] = useState<{
    transcripts: Record<string, Message[]>;
    routines: Record<string, Routine[]>;
    files: Record<string, HomeEntry[]>;
  } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { closing, requestClose, finishClose } = useExitAnimation(onClose);

  const trimmed = query.trim();
  const deep = trimmed !== "" || DEEP_TABS.includes(tab);

  // One pass of per-Blob reads, the first time a tab or query needs them.
  useEffect(() => {
    if (!deep || loaded !== null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      /** Read one slice per Blob, keyed by Blob id, failures counting as empty. */
      const perBlob = async <T,>(read: (id: string) => Promise<T | null>, blobs: Agent[]) =>
        Object.fromEntries(
          await Promise.all(
            blobs.map(
              async (agent) => [agent.id, (await read(agent.id).catch(() => null)) ?? []] as const,
            ),
          ),
        );
      const next = {
        transcripts: await perBlob(
          store.loadBlobTranscript,
          agents.filter((agent) => transcripts[agent.id] === undefined),
        ),
        routines: await perBlob(
          store.loadBlobRoutines,
          agents.filter((agent) => routines[agent.id] === undefined),
        ),
        files: await perBlob((id) => homeFor(id).list(), agents),
      };
      if (!cancelled) {
        setLoaded(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deep, loaded, agents, transcripts, routines]);

  const index = useMemo(
    () =>
      buildIndex({
        agents,
        // Until a tab or query needs them, the read halves stay empty: Blobs
        // and actions cost no disk read at all.
        transcripts: { ...loaded?.transcripts, ...transcripts },
        routines: { ...loaded?.routines, ...routines },
        groups,
        files: loaded?.files ?? {},
        hasChat,
      }),
    [agents, groups, transcripts, loaded, routines, hasChat],
  );

  const rows = useMemo(() => {
    if (tab !== "all") {
      return filterRows(index[tab], trimmed);
    }
    // With no query the All tab is a launcher, not a search: only the rows
    // that mean something without one.
    const kinds = trimmed === "" ? (["blob", "action"] as SearchKind[]) : ALL_ORDER;
    return kinds.flatMap((kind) => filterRows(index[kind], trimmed).slice(0, ALL_GROUP_CAP));
  }, [index, tab, trimmed]);

  const visible = tab === "all" ? rows : rows.slice(0, shown);
  const loading = deep && loaded === null;
  /** Whether this tab has anything at all, ignoring the query. */
  const populated =
    tab === "all" ? ALL_ORDER.some((kind) => index[kind].length > 0) : index[tab].length > 0;
  const active = Math.min(highlight, Math.max(visible.length - 1, 0));
  const activeRow = visible[active];
  const currentTab = TABS.find((entry) => entry.id === tab) ?? ALL_TAB;
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  // A new tab or query is a new list: start at the top, one page deep.
  // biome-ignore lint/correctness/useExhaustiveDependencies(tab): resetting IS the effect
  // biome-ignore lint/correctness/useExhaustiveDependencies(trimmed): same
  useEffect(() => {
    setHighlight(0);
    setShown(PAGE_SIZE);
    listRef.current?.scrollTo({ top: 0 });
  }, [tab, trimmed]);

  // Keep the highlighted row in view when the keyboard moves it.
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const activate = (result: SearchResult | undefined) => {
    if (result !== undefined) {
      onSelect(result);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate(activeRow);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (visible.length === 0) {
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = (active + step + visible.length) % visible.length;
      setHighlight(next);
      // Arrowing to the end is the other way to ask for the next page.
      if (next >= visible.length - 1) {
        setShown((count) => count + PAGE_SIZE);
      }
      return;
    }
    // ⌘1–9 jumps straight to one of the first nine rows.
    if (event.metaKey && event.key >= "1" && event.key <= "9") {
      const target = visible[Number(event.key) - 1];
      if (target !== undefined) {
        event.preventDefault();
        activate(target);
      }
    }
  };

  const onScroll = () => {
    const list = listRef.current;
    if (list === null || tab === "all" || shown >= rows.length) {
      return;
    }
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - LOAD_MORE_SLACK) {
      setShown((count) => count + PAGE_SIZE);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss mirrors the Escape path
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the dialog itself
    <div
      className={
        closing
          ? "modal-backdrop search-backdrop modal-backdrop-closing"
          : "modal-backdrop search-backdrop"
      }
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          requestClose();
        }
      }}
      onAnimationEnd={(event) => {
        if (closing && event.target === event.currentTarget) {
          finishClose();
        }
      }}
    >
      <div
        className={closing ? "search-modal search-modal-closing" : "search-modal"}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="search-field">
          <Search size={16} strokeWidth={2} aria-hidden="true" className="search-modal-glyph" />
          <input
            // The palette exists to be typed into; focusing it is the point.
            // biome-ignore lint/a11y/noAutofocus: single-purpose entry field
            autoFocus
            ref={inputRef}
            type="text"
            className="search-modal-input"
            placeholder="Search"
            aria-label="Search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>

        <div className="search-tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={tab === entry.id ? "plugins-tab plugins-tab-active" : "plugins-tab"}
              aria-pressed={tab === entry.id}
              onClick={() => {
                setTab(entry.id);
                // Focus goes back to the field so the next keystroke types
                // rather than re-triggering the tab under Enter.
                inputRef.current?.focus();
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <div className="search-empty">
            {loading ? (
              <p className="search-empty-text">Searching…</p>
            ) : (
              <>
                <currentTab.icon
                  size={22}
                  strokeWidth={1.6}
                  aria-hidden="true"
                  className="search-empty-glyph"
                />
                <p className="search-empty-text">
                  {populated ? currentTab.none : currentTab.empty}
                </p>
              </>
            )}
          </div>
        ) : (
          <ul
            ref={listRef}
            className="search-results"
            aria-label={`${currentTab.label} results`}
            onScroll={onScroll}
          >
            {visible.map((result, position) => (
              <li key={result.id}>
                {/* A real button, so Tab reaches every row and each one
                    announces itself; the arrow keys are the shortcut, not the
                    only way in. */}
                <button
                  type="button"
                  data-row={position}
                  aria-current={position === active}
                  className={position === active ? "search-row search-row-active" : "search-row"}
                  onClick={() => activate(result)}
                  // Move, not enter: arrowing scrolls the list under a still
                  // cursor, and enter would fight the keyboard for the highlight.
                  onMouseMove={() => setHighlight(position)}
                >
                  <RowIcon
                    result={result}
                    agent={"blobId" in result ? agentById.get(result.blobId) : undefined}
                  />
                  <span className="search-row-text">
                    <span className="search-row-title">{result.title}</span>
                    {result.subtitle === "" ? null : (
                      <span className="search-row-subtitle">{result.subtitle}</span>
                    )}
                  </span>
                  {position < 9 ? (
                    <span className="compose-kbd-group" aria-hidden="true">
                      <kbd className="compose-kbd">⌘</kbd>
                      <kbd className="compose-kbd">{position + 1}</kbd>
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
