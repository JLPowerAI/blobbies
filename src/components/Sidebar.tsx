import { Plug, Plus, Search, Settings } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { BlobAvatar } from "@/components/BlobAvatar";
import type { Agent } from "@/data/agents";
import { readPreference, writePreference } from "@/lib/preferences";
import { isTauri } from "@/lib/tauri";
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
  composing: boolean;
  userName: string;
  onSelect: (id: string) => void;
  onStartCompose: () => void;
  onOpenSettings: () => void;
  onOpenPlugins: () => void;
}

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
  composing,
  userName,
  onSelect,
  onStartCompose,
  onOpenSettings,
  onOpenPlugins,
}: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
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
        <button
          type="button"
          className="icon-button sidebar-new-blob"
          aria-label="New Blob"
          onClick={onStartCompose}
        >
          <Plus size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar-search">
        <Search size={13} strokeWidth={2} aria-hidden="true" className="search-glyph" />
        <input
          type="search"
          className="search-input"
          placeholder="Search"
          aria-label="Search conversations"
        />
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
        {agents.map((agent) => {
          const selected = agent.id === selectedId;
          return (
            <li key={agent.id}>
              <button
                type="button"
                className={selected ? "agent-row agent-row-selected" : "agent-row"}
                aria-current={selected ? "true" : undefined}
                title={collapsed ? agent.name : undefined}
                onClick={() => onSelect(agent.id)}
              >
                <BlobAvatar tone={agent.tone} shape={agent.shape} />
                <span className="agent-row-text">
                  <span className="agent-row-top">
                    <span className="agent-name">{agent.name}</span>
                    <span className="agent-time">{agent.time}</span>
                  </span>
                  <span className="agent-row-bottom">
                    <span className="agent-snippet">{agent.snippet}</span>
                    {agent.unread === true ? (
                      <span className="unread-dot" role="status" aria-label="Unread messages" />
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="sidebar-footer">
        {/* Collapsed rail: + moves down here, above the account avatar. Only
            mounted while collapsed so the expanded tree has one New Blob button. */}
        {collapsed ? (
          <button
            type="button"
            className="icon-button footer-new-blob"
            aria-label="New Blob"
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
