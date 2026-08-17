import {
  Bell,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Link,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { BlobAvatar } from "@/components/BlobAvatar";
import { type Agent, MAX_BLOBS } from "@/data/agents";
import { type Group, MAX_GROUP_MEMBERS } from "@/lib/groups";
import { readPreference, writePreference } from "@/lib/preferences";
import { isTauri } from "@/lib/tauri";
import { formatAgentTime } from "@/lib/time";
import { useBlobDrag } from "@/lib/useBlobDrag";
import { useExitAnimation } from "@/lib/useExitAnimation";

/** Resize limits: the rail collapses below MIN, and can't grow past MAX. */
const MIN_WIDTH = 220;
const MAX_WIDTH = 420;
/* Wide enough that the native traffic lights (x=16 + 52px wide) keep a
   comfortable inset from the rail's right edge. */
const RAIL_WIDTH = 100;
/** Dragging narrower than this snaps into the icon-only rail... */
const COLLAPSE_AT = 150;
/** ...and must pass this on the way out, so the threshold never flaps. */
const EXPAND_AT = 176;
/** Below this window width the sidebar auto-collapses to the icon rail. */
const AUTO_COLLAPSE_QUERY = "(max-width: 860px)";

/** True while the window is too narrow for an expanded sidebar. */
function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(AUTO_COLLAPSE_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(AUTO_COLLAPSE_QUERY);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

interface SidebarProps {
  agents: Agent[];
  /** Null while composing: no conversation is highlighted. */
  selectedId: string | null;
  /** Group chats, in sidebar order. A Blob's `section` is its membership. */
  groups: Group[];
  selectedGroupId: string | null;
  onSelectGroup: (id: string) => void;
  onChangeGroups: (next: Group[]) => void;
  composing: boolean;
  userName: string;
  onSelect: (id: string) => void;
  onStartCompose: () => void;
  onOpenSettings: () => void;
  onOpenPlugins: () => void;
  onOpenSearch: () => void;
  onUpdateBlob: (id: string, patch: Partial<Agent>) => void;
  onEditProfile: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Right-click context menu target: which Blob, and where to render. */
interface MenuTarget {
  agentId: string;
  x: number;
  y: number;
}

/** Drop zone ids. Sections use `section:<name>`, so these cannot collide. */
const PIN_ZONE = "pin";
const UNGROUPED_ZONE = "ungrouped";
const SECTION_PREFIX = "section:";

/** The drop zone a group answers to; null is the ungrouped run. */
function zoneFor(section: string | null): string {
  return section === null ? UNGROUPED_ZONE : `${SECTION_PREFIX}${section}`;
}

/** A string-array preference; `[]` for anything a hand-edit made unreadable. */
// (Collapsed-group names still live here: which groups are shut is a view
// preference, unlike the groups themselves, which are conversations.)
function readNames(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readPreference(key, "[]"));
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

/** Keep the fixed-position menu inside the viewport. */
const MENU_WIDTH = 224;
const MENU_HEIGHT = 316;

function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);
  return letters.length > 0 ? letters : "?";
}

export function Sidebar({
  agents,
  selectedId,
  groups,
  selectedGroupId,
  onSelectGroup,
  onChangeGroups,
  composing,
  userName,
  onSelect,
  onStartCompose,
  onOpenSettings,
  onOpenPlugins,
  onOpenSearch,
  onUpdateBlob,
  onEditProfile,
  onDuplicate,
  onDelete,
}: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<MenuTarget | null>(null);
  /** Blob awaiting delete confirmation (window.confirm is a no-op in wry). */
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null);
  /** Hidden Blobs are collapsed behind a toggle — the only way back to one. */
  const [showHidden, setShowHidden] = useState(false);

  /** Collapsed group names. Order is the group list's, not this one's. */
  const [collapsedSections, setCollapsedSections] = useState<string[]>(() =>
    readNames("pref:sectionsCollapsed"),
  );

  /** Group names, in order — what the drag zones and membership are keyed by. */
  const sections = groups.map((group) => group.name);

  /** Reorder or drop groups by name, keeping each group's id (and chat). */
  const saveSections = (next: string[]) => {
    onChangeGroups(
      next
        .map((name) => groups.find((group) => group.name === name))
        .filter((group): group is Group => group !== undefined),
    );
  };

  const saveCollapsedSections = (next: string[]) => {
    setCollapsedSections(next);
    writePreference("pref:sectionsCollapsed", JSON.stringify(next));
  };

  const toggleSection = (name: string) => {
    saveCollapsedSections(
      collapsedSections.includes(name)
        ? collapsedSections.filter((candidate) => candidate !== name)
        : [...collapsedSections, name],
    );
  };

  /**
   * Drop a group, and its collapsed flag with it: `addSection` reuses "New
   * Group", so a leftover flag would make a later group of the same name
   * open up already shut. The group's transcript stays on disk — removing an
   * empty group tidies the sidebar, it does not delete a conversation.
   */
  const removeSection = (name: string) => {
    saveSections(sections.filter((candidate) => candidate !== name));
    if (collapsedSections.includes(name)) {
      saveCollapsedSections(collapsedSections.filter((candidate) => candidate !== name));
    }
  };

  /** Apply a drop: pin, unpin into the ungrouped run, or move to a section. */
  const {
    drag,
    start: startDrag,
    consumeClick,
  } = useBlobDrag((id, zone) => {
    if (zone === PIN_ZONE) {
      onUpdateBlob(id, { pinned: true });
      return;
    }
    // A group is a chat, and every member answers a message in it, so the
    // cap is enforced where the membership is written — a seventh Blob that
    // sat in the group but never spoke would be a silent lie.
    if (zone.startsWith(SECTION_PREFIX)) {
      const name = zone.slice(SECTION_PREFIX.length);
      const taken = agents.filter(
        (candidate) => candidate.hidden !== true && candidate.section === name,
      ).length;
      if (taken >= MAX_GROUP_MEMBERS) {
        return;
      }
    }
    // Anything that is not the pin tray unpins: a Blob lives in one place.
    // The ungrouped run clears `section` rather than setting one.
    onUpdateBlob(
      id,
      zone.startsWith(SECTION_PREFIX)
        ? { pinned: false, section: zone.slice(SECTION_PREFIX.length) }
        : { pinned: false, section: "" },
    );
    // Dropping into a shut section would otherwise look like the Blob
    // vanished; open it so the landing is visible.
    if (zone.startsWith(SECTION_PREFIX)) {
      const name = zone.slice(SECTION_PREFIX.length);
      if (collapsedSections.includes(name)) {
        saveCollapsedSections(collapsedSections.filter((candidate) => candidate !== name));
      }
    }
  });

  /**
   * Reordering sections, on the same pointer-drag machinery as Blobs: a
   * section takes the place of whichever group it is dropped on, and the
   * ungrouped run (always the topmost) means "move to the top".
   */
  const {
    drag: sectionDrag,
    start: startSectionDrag,
    consumeClick: consumeSectionClick,
  } = useBlobDrag((name, zone) => {
    const rest = sections.filter((candidate) => candidate !== name);
    if (zone === UNGROUPED_ZONE) {
      saveSections([name, ...rest]);
      return;
    }
    if (!zone.startsWith(SECTION_PREFIX)) {
      return;
    }
    const target = zone.slice(SECTION_PREFIX.length);
    const landing = rest.indexOf(target);
    if (target === name || landing === -1) {
      return;
    }
    // Dragging downwards lands *after* the target, upwards *before* it — the
    // section ends up where the cursor is, not one slot short of it.
    const forwards = sections.indexOf(name) < sections.indexOf(target);
    rest.splice(forwards ? landing + 1 : landing, 0, name);
    saveSections(rest);
  });

  // Escape dismisses the context menu; clicks are handled by its backdrop.
  useEffect(() => {
    if (contextMenu === null) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [contextMenu]);

  const openContextMenu = (event: ReactMouseEvent, agentId: string) => {
    event.preventDefault();
    setContextMenu({
      agentId,
      x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8),
      y: Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - 8),
    });
  };
  // Re-render every 30s so relative timestamps ("Now" → "14:32") stay honest.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const accountRef = useRef<HTMLDivElement>(null);
  const { closing, requestClose, finishClose } = useExitAnimation(() => setMenuOpen(false));

  const [width, setWidth] = useState(() => {
    const stored = Number(readPreference("pref:sidebarWidth", "292"));
    return Number.isFinite(stored) ? Math.min(Math.max(stored, MIN_WIDTH), MAX_WIDTH) : 292;
  });
  const [userCollapsed, setUserCollapsed] = useState(
    () => readPreference("pref:sidebarCollapsed", "false") === "true",
  );
  const [resizing, setResizing] = useState(false);
  // A narrow window forces the rail; widening restores the user's own choice.
  const narrowWindow = useNarrowWindow();
  const collapsed = userCollapsed || narrowWindow;

  const applyCollapsed = (next: boolean) => {
    setUserCollapsed(next);
    writePreference("pref:sidebarCollapsed", String(next));
  };

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = collapsed ? RAIL_WIDTH : width;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setResizing(true);
    // Track collapse across moves locally; the closure's `collapsed` is stale.
    let isCollapsed = collapsed;

    const onMove = (move: PointerEvent) => {
      const raw = startWidth + (move.clientX - startX);
      // Width follows the cursor 1:1 all the way down to the rail width, so
      // there is never a jump to animate mid-drag. Only the CONTENT swaps at
      // the thresholds (with hysteresis so it never flaps).
      if (raw < COLLAPSE_AT && !isCollapsed) {
        isCollapsed = true;
        applyCollapsed(true);
      } else if (raw >= EXPAND_AT && isCollapsed) {
        isCollapsed = false;
        applyCollapsed(false);
      }
      setWidth(Math.min(Math.max(raw, RAIL_WIDTH), MAX_WIDTH));
    };
    const onUp = () => {
      handle.releasePointerCapture(event.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Release: settle to the resting width (animated again now that the
      // resizing class is gone). Only an expanded width is worth persisting;
      // a collapsed release restores the last good expanded width so a later
      // expand never reopens below MIN_WIDTH.
      setResizing(false);
      setWidth((final) => {
        if (isCollapsed) {
          const stored = Number(readPreference("pref:sidebarWidth", "292"));
          return Number.isFinite(stored)
            ? Math.min(Math.max(stored, MIN_WIDTH), MAX_WIDTH)
            : MIN_WIDTH;
        }
        const settled = Math.min(Math.max(final, MIN_WIDTH), MAX_WIDTH);
        writePreference("pref:sidebarWidth", String(settled));
        return settled;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onHandleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      applyCollapsed(!collapsed);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    if (collapsed) {
      if (event.key === "ArrowRight") {
        applyCollapsed(false);
      }
      return;
    }
    if (event.key === "ArrowLeft" && width === MIN_WIDTH) {
      applyCollapsed(true);
      return;
    }
    const delta = event.key === "ArrowLeft" ? -16 : 16;
    const next = Math.min(Math.max(width + delta, MIN_WIDTH), MAX_WIDTH);
    setWidth(next);
    writePreference("pref:sidebarWidth", String(next));
  };

  // Close the account menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (accountRef.current !== null && !accountRef.current.contains(event.target as Node)) {
        requestClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        requestClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, requestClose]);
  const style = {
    // Mid-drag the width follows the cursor even while the content is in its
    // collapsed layout; at rest, collapsed always parks at the rail width.
    "--sidebar-width": collapsed && !resizing ? `${RAIL_WIDTH}px` : `${width}px`,
  } as CSSProperties;

  const listed = agents.filter((candidate) => candidate.hidden !== true);
  const hidden = agents.filter((candidate) => candidate.hidden === true);
  const pinned = listed.filter((candidate) => candidate.pinned === true);
  const unpinned = listed.filter((candidate) => candidate.pinned !== true);
  // A section name no longer in the list reads as ungrouped, so deleting a
  // section never strands the Blobs that were in it.
  const inSection = (candidate: Agent) =>
    candidate.section !== undefined && sections.includes(candidate.section);
  const ungrouped = unpinned.filter((candidate) => !inSection(candidate));
  const sectionGroups = groups.map(({ id, name, unread }) => ({
    id,
    name,
    unread,
    rows: unpinned.filter((candidate) => candidate.section === name),
  }));
  const dragging = drag !== null;
  const dragTarget = agents.find((candidate) => candidate.id === drag?.id);

  /**
   * One conversation row. Hidden rows are `draggable: false`: their group is
   * not a drop zone, and a drag out of it would write a `section` on a Blob
   * that stays invisible.
   */
  const agentRow = (agent: Agent, draggable: boolean) => {
    const selected = agent.id === selectedId;
    return (
      <li key={agent.id}>
        <button
          type="button"
          className={[
            "agent-row",
            selected ? "agent-row-selected" : "",
            drag?.id === agent.id ? "agent-row-dragging" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-current={selected ? "true" : undefined}
          title={collapsed ? agent.name : undefined}
          onPointerDown={draggable ? (event) => startDrag(event, agent.id) : undefined}
          onClick={() => {
            // The click that ends a drag must not also select.
            if (!consumeClick()) {
              onSelect(agent.id);
            }
          }}
          onContextMenu={(event) => openContextMenu(event, agent.id)}
        >
          {/* The dot badges the avatar rather than trailing the snippet: at
              the end of a variable-length line it sat in a different place on
              every row, and it vanished entirely when the sidebar collapsed
              to avatars — exactly when it is the only signal left. */}
          <span className="agent-row-face">
            <BlobAvatar tone={agent.tone} shape={agent.shape} />
            {agent.unread === true ? (
              <span className="unread-dot" role="status" aria-label="Unread messages" />
            ) : null}
          </span>
          <span className="agent-row-text">
            <span className="agent-row-top">
              <span className="agent-name">{agent.name}</span>
              <span className="agent-time">
                {agent.lastActivityAt === undefined
                  ? agent.time
                  : formatAgentTime(agent.lastActivityAt, now)}
              </span>
            </span>
            <span className="agent-row-bottom">
              <span className="agent-snippet">{agent.snippet}</span>
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <nav
      className={[
        "sidebar",
        collapsed ? "sidebar-collapsed" : "",
        resizing ? "sidebar-resizing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      aria-label="Conversations"
    >
      <div className="sidebar-titlebar" data-tauri-drag-region>
        {/* Inside Tauri the real macOS controls overlay this spot; keep the
            spacer so the + button stays right-aligned either way. */}
        <div className="traffic-lights" aria-hidden="true" data-tauri-drag-region>
          {isTauri() ? null : (
            <>
              <span className="traffic-light traffic-close" />
              <span className="traffic-light traffic-minimize" />
              <span className="traffic-light traffic-zoom" />
            </>
          )}
        </div>
        {/* "New chat", not "New Blob": the pane it opens starts a group too. */}
        <button
          type="button"
          className="icon-button sidebar-new-blob"
          aria-label="New chat"
          onClick={onStartCompose}
        >
          <Plus size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar-search">
        <Search size={13} strokeWidth={2} aria-hidden="true" className="search-glyph" />
        {/* Looks like a field, acts as the door to the palette: searching spans
            messages, files, links and routines, not just this list. */}
        <button type="button" className="search-input search-trigger" onClick={onOpenSearch}>
          Search
        </button>
      </div>

      <ul className="agent-list">
        {agents.length === 0 ? (
          <li>
            <div className="agent-row agent-row-selected compose-row">
              <BlobAvatar tone="blue" shape="sphere" size={28} />
              <span className="agent-name">Create your first Blob</span>
            </div>
          </li>
        ) : null}
        {/* Always mounted so the row can animate open and closed. */}
        <li
          className={
            composing && agents.length > 0 ? "compose-slot compose-slot-open" : "compose-slot"
          }
          aria-hidden={composing && agents.length > 0 ? undefined : true}
        >
          <div className="compose-slot-inner">
            <div className="agent-row agent-row-selected compose-row">
              <span className="compose-row-glyph" aria-hidden="true">
                <Plus size={17} strokeWidth={2} />
              </span>
              <span className="agent-name">Create new</span>
            </div>
          </div>
        </li>
        {agents.length === 0 ? (
          <li aria-hidden="true" className="sidebar-empty">
            No Blobs yet
          </li>
        ) : null}

        {/* Pin tray. Always a drop target while dragging, even when empty —
            that empty state is the only thing that teaches the gesture. */}
        {pinned.length > 0 || dragging ? (
          <li
            data-drop={PIN_ZONE}
            className={[
              "pin-tray",
              pinned.length === 0 ? "pin-tray-empty" : "",
              drag?.over === PIN_ZONE ? "pin-tray-over" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {pinned.length === 0 ? (
              <span className="pin-tray-hint">Drag here to pin</span>
            ) : (
              pinned.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  className={agent.id === selectedId ? "pin-tile pin-tile-selected" : "pin-tile"}
                  aria-current={agent.id === selectedId ? "true" : undefined}
                  onPointerDown={(event) => startDrag(event, agent.id)}
                  onClick={() => {
                    if (!consumeClick()) {
                      onSelect(agent.id);
                    }
                  }}
                  onContextMenu={(event) => openContextMenu(event, agent.id)}
                >
                  <BlobAvatar tone={agent.tone} shape={agent.shape} size={44} />
                  <span className="pin-tile-name">{agent.name}</span>
                </button>
              ))
            )}
          </li>
        ) : null}

        {/* Blobs in no group first, then one run per group. */}
        {[{ id: null, name: null, unread: undefined, rows: ungrouped }, ...sectionGroups].map(
          (group) => {
            const zone = zoneFor(group.name);
            // Never collapsed in the rail: it hides `.section-header`, so the
            // only control that could reopen the section is gone and its Blobs
            // would be unreachable until the sidebar is widened again.
            const shut =
              !collapsed && group.name !== null && collapsedSections.includes(group.name);
            return (
              <li
                key={group.name ?? UNGROUPED_ZONE}
                className={[
                  "agent-group",
                  sectionDrag?.id === group.name ? "agent-group-dragging" : "",
                  sectionDrag !== null && sectionDrag.over === zone && sectionDrag.id !== group.name
                    ? "agent-group-reorder-over"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-drop={zone}
              >
                {group.name === null ? null : (
                  <div
                    className={
                      group.id === selectedGroupId
                        ? "section-header section-header-open"
                        : "section-header"
                    }
                  >
                    {/* The name is the group's chat: press-and-hold reorders, a
                      plain click opens the conversation. Collapsing moved to
                      the chevron beside it — a group is somewhere you go now,
                      and that has to be the primary click. */}
                    <button
                      type="button"
                      className="section-toggle"
                      aria-current={group.id === selectedGroupId ? "true" : undefined}
                      aria-label={
                        group.unread === true ? `${group.name}, unread messages` : undefined
                      }
                      onPointerDown={(event) => startSectionDrag(event, group.name)}
                      onClick={() => {
                        if (!consumeSectionClick()) {
                          onSelectGroup(group.id);
                        }
                      }}
                    >
                      <span className="section-name">{group.name}</span>
                      {/* Replies landed while you were elsewhere. The group's
                        words live in its own transcript, so no member's unread
                        dot can stand in for this.

                        Announced through the button's own accessible name:
                        inside a button, a labelled child is concatenated into
                        that name, so the row read as “LaunchUnread messages in
                        Launch”. */}
                      {group.unread === true ? (
                        <span className="unread-dot unread-dot-shimmer" aria-hidden="true" />
                      ) : null}
                      {/* Shut: how much is hidden. Full: why the next drop will
                        not land — a group answers as a whole, so it is capped. */}
                      {shut || group.rows.length >= MAX_GROUP_MEMBERS ? (
                        <span className="section-count">
                          {shut ? group.rows.length : `${group.rows.length}/${MAX_GROUP_MEMBERS}`}
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="section-collapse"
                      aria-expanded={!shut}
                      aria-label={shut ? `Expand ${group.name}` : `Collapse ${group.name}`}
                      onClick={() => toggleSection(group.name)}
                    >
                      <ChevronDown
                        size={15}
                        strokeWidth={2}
                        aria-hidden="true"
                        className={
                          shut ? "section-chevron section-chevron-shut" : "section-chevron"
                        }
                      />
                    </button>
                    {/* Only an empty group can be removed: with rows it would be
                    a destructive-looking button next to real conversations. */}
                    {group.rows.length === 0 ? (
                      <button
                        type="button"
                        className="section-remove"
                        aria-label={`Remove group ${group.name}`}
                        onClick={() => removeSection(group.name)}
                      >
                        <X size={12} strokeWidth={2} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                )}
                {/* Collapses on the same 0fr→1fr grid as the compose slot, and
                  stays mounted while shut so the group remains a drop target
                  the Blob drag can hit and expand. `inert` (not `hidden`,
                  which cannot animate) takes the rows out of the a11y tree
                  and off the tab order for the duration. */}
                <div className={shut ? "section-slot section-slot-shut" : "section-slot"}>
                  <ul
                    inert={shut}
                    className={
                      drag?.over === zone ? "agent-group-rows agent-group-over" : "agent-group-rows"
                    }
                  >
                    {group.rows.length === 0 && group.name !== null ? (
                      <li className="section-empty">Drag Blobs here to add them</li>
                    ) : null}
                    {group.rows.map((agent) => agentRow(agent, true))}
                  </ul>
                </div>
              </li>
            );
          },
        )}

        {/* Hidden Blobs. Not a drop zone: see agentRow. */}
        {hidden.length > 0 && !collapsed ? (
          <li className="agent-group">
            <button
              type="button"
              className="section-add"
              aria-expanded={showHidden}
              onClick={() => setShowHidden(!showHidden)}
            >
              {showHidden ? (
                <EyeOff size={13} strokeWidth={2} aria-hidden="true" />
              ) : (
                <Eye size={13} strokeWidth={2} aria-hidden="true" />
              )}
              {showHidden
                ? `Hidden chats (${hidden.length})`
                : `Show hidden chats (${hidden.length})`}
            </button>
            {showHidden ? (
              <ul className="agent-group-rows">{hidden.map((agent) => agentRow(agent, false))}</ul>
            ) : null}
          </li>
        ) : null}
      </ul>

      {/* The dragged Blob follows the cursor. Fixed-position and
          pointer-events: none so it never becomes its own drop target. */}
      {drag === null || dragTarget === undefined ? null : (
        <div
          className={drag.over === null ? "drag-tile" : "drag-tile drag-tile-armed"}
          style={{ left: drag.x, top: drag.y }}
          aria-hidden="true"
        >
          <BlobAvatar tone={dragTarget.tone} shape={dragTarget.shape} size={44} />
          <span className="pin-tile-name">{dragTarget.name}</span>
        </div>
      )}

      {sectionDrag === null ? null : (
        <div
          className={
            sectionDrag.over === null
              ? "drag-tile section-tile"
              : "drag-tile section-tile drag-tile-armed"
          }
          style={{ left: sectionDrag.x, top: sectionDrag.y }}
          aria-hidden="true"
        >
          {sectionDrag.id}
        </div>
      )}

      {contextMenu !== null &&
        (() => {
          const target = agents.find((candidate) => candidate.id === contextMenu.agentId);
          if (target === undefined) {
            return null;
          }
          const item = (
            label: string,
            icon: React.ReactNode,
            action: () => void,
            danger = false,
          ) => (
            <button
              type="button"
              className={danger ? "context-menu-item context-menu-danger" : "context-menu-item"}
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                action();
              }}
            >
              {icon}
              {label}
            </button>
          );
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: transparent scrim; click-away mirrors Escape
            // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the window listener
            <div
              className="context-menu-scrim"
              onClick={() => setContextMenu(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu(null);
              }}
            >
              {/* Containment: keep item clicks from reaching the scrim's dismiss.
                  Items are real buttons, so no key handler is needed here. */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: items are real buttons */}
              <div
                className="context-menu"
                role="menu"
                aria-label={`Actions for ${target.name}`}
                style={{ left: contextMenu.x, top: contextMenu.y }}
                onClick={(event) => event.stopPropagation()}
              >
                {target.pinned === true
                  ? item("Unpin", <PinOff size={15} strokeWidth={1.8} aria-hidden="true" />, () =>
                      onUpdateBlob(target.id, { pinned: false }),
                    )
                  : item("Pin", <Pin size={15} strokeWidth={1.8} aria-hidden="true" />, () =>
                      onUpdateBlob(target.id, { pinned: true }),
                    )}
                {item(
                  "Mark as Unread",
                  <Bell size={15} strokeWidth={1.8} aria-hidden="true" />,
                  () => onUpdateBlob(target.id, { unread: true }),
                )}
                <hr className="context-menu-separator" />
                {item(
                  "Edit Profile",
                  <Pencil size={15} strokeWidth={1.8} aria-hidden="true" />,
                  () => onEditProfile(target.id),
                )}
                {/* No Duplicate at the cap: the copy would silently not appear. */}
                {agents.length >= MAX_BLOBS
                  ? null
                  : item("Duplicate", <Copy size={15} strokeWidth={1.8} aria-hidden="true" />, () =>
                      onDuplicate(target.id),
                    )}
                <hr className="context-menu-separator" />
                {item(
                  "Copy conversation ID",
                  <Link size={15} strokeWidth={1.8} aria-hidden="true" />,
                  () => void navigator.clipboard?.writeText(target.id),
                )}
                <hr className="context-menu-separator" />
                {target.hidden === true
                  ? item("Unhide", <Eye size={15} strokeWidth={1.8} aria-hidden="true" />, () =>
                      onUpdateBlob(target.id, { hidden: false }),
                    )
                  : item(
                      "Hide from sidebar",
                      <EyeOff size={15} strokeWidth={1.8} aria-hidden="true" />,
                      () => onUpdateBlob(target.id, { hidden: true }),
                    )}
                {item(
                  "Delete",
                  <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />,
                  // Styled dialog: window.confirm never shows in the webview.
                  () => setConfirmDelete(target),
                  true,
                )}
              </div>
            </div>
          );
        })()}

      {confirmDelete !== null ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss mirrors Escape
        // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the dialog
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setConfirmDelete(null);
            }
          }}
        >
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label={`Delete ${confirmDelete.name}`}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setConfirmDelete(null);
              }
            }}
          >
            <h2 className="confirm-title">{`Delete \u201c${confirmDelete.name}\u201d`}</h2>
            <p className="confirm-body">
              This removes the Blob and its chat history from Blobbies. Its files sit in the app's
              trash folder on this computer for 30 days before they're purged. If you may need its
              work later, hide it instead.
            </p>
            <div className="confirm-actions">
              <button type="button" className="modal-button" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="modal-button confirm-danger"
                // biome-ignore lint/a11y/noAutofocus: destructive dialogs focus their primary action
                autoFocus
                onClick={() => {
                  onDelete(confirmDelete.id);
                  setConfirmDelete(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="sidebar-footer">
        {/* Collapsed rail: + moves down here, above the account avatar. Only
            mounted while collapsed so the expanded tree has one New button. */}
        {collapsed ? (
          <button
            type="button"
            className="icon-button footer-new-blob"
            aria-label="New chat"
            onClick={onStartCompose}
          >
            <Plus size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="footer-row"
          title={collapsed ? "Plugins" : undefined}
          onClick={onOpenPlugins}
        >
          <span className="footer-glyph">
            <Plug size={16} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <span className="row-label">Plugins</span>
        </button>
        <div className="account-area" ref={accountRef}>
          {menuOpen ? (
            <div
              className={closing ? "account-menu account-menu-closing" : "account-menu"}
              role="menu"
              aria-label="Account menu"
              onAnimationEnd={(event) => {
                if (closing && event.target === event.currentTarget) {
                  finishClose();
                }
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="account-menu-item"
                onClick={() => {
                  // Jump straight out; the modal takes over the screen.
                  setMenuOpen(false);
                  onOpenSettings();
                }}
              >
                <Settings size={15} strokeWidth={1.8} aria-hidden="true" />
                Settings
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="footer-row"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              if (menuOpen) {
                requestClose();
              } else {
                setMenuOpen(true);
              }
            }}
          >
            <span className="footer-avatar" aria-hidden="true">
              {initialsOf(userName)}
            </span>
            <span className="row-label">{userName}</span>
          </button>
        </div>
      </div>

      {/* Focusable window-splitter (WAI-ARIA): a separator with value state. */}
      {/* biome-ignore lint/a11y/useSemanticElements: no semantic element models a splitter */}
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={RAIL_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={collapsed ? RAIL_WIDTH : width}
        tabIndex={0}
        onPointerDown={onHandlePointerDown}
        onKeyDown={onHandleKeyDown}
      />
    </nav>
  );
}
