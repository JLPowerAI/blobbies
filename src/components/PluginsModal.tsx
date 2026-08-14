import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ListFilter,
  Plus,
  Search,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PLUGIN_CATEGORIES, type PluginDef, plugins } from "@/data/plugins";
import { useExitAnimation } from "@/lib/useExitAnimation";

/** Rows shown per category before the "Show N more" expander. */
const PREVIEW_COUNT = 4;

interface PluginsModalProps {
  installed: string[];
  onSetInstalled: (id: string, installed: boolean) => void;
  onClose: () => void;
}

function PluginTile({ plugin, size = 40 }: { plugin: PluginDef; size?: number }) {
  return (
    <span
      className="plugin-tile"
      style={{
        width: size,
        height: size,
        background: plugin.tile.bg,
        color: plugin.tile.fg ?? "#ffffff",
        fontSize: size * 0.38,
      }}
      aria-hidden="true"
    >
      {plugin.tile.iconPath === undefined ? (
        plugin.tile.label
      ) : (
        <svg
          width={size * 0.55}
          height={size * 0.55}
          viewBox="0 0 24 24"
          fill="currentColor"
          focusable="false"
          aria-hidden="true"
        >
          <path d={plugin.tile.iconPath} />
        </svg>
      )}
    </span>
  );
}

/** Marketplace + per-plugin detail, presented in the settings-sized modal. */
export function PluginsModal({ installed, onSetInstalled, onClose }: PluginsModalProps) {
  const [tab, setTab] = useState<"marketplace" | "yours">("marketplace");
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<"all" | "connectors" | "skills">("all");
  const [ownershipFilter, setOwnershipFilter] = useState<"all" | "team" | "public">("all");
  const filterRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { closing, requestClose, finishClose } = useExitAnimation(onClose);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Close the filter menu on outside click.
  useEffect(() => {
    if (!filterOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (filterRef.current !== null && !filterRef.current.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [filterOpen]);

  // Escape steps back out of the detail view, then dismisses the modal.
  // Document-level so it still works when the focused element unmounts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (filterOpen) {
        setFilterOpen(false);
        return;
      }
      if (detailId !== null) {
        setDetailId(null);
        return;
      }
      requestClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [detailId, filterOpen, requestClose]);

  const detail = detailId === null ? null : (plugins.find((p) => p.id === detailId) ?? null);
  const trimmed = query.trim().toLowerCase();

  const visiblePlugins = plugins.filter((plugin) => {
    if (tab === "yours" && !installed.includes(plugin.id)) {
      return false;
    }
    if (trimmed.length === 0) {
      return true;
    }
    return (
      plugin.name.toLowerCase().includes(trimmed) ||
      plugin.description.toLowerCase().includes(trimmed)
    );
  });

  const renderRow = (plugin: PluginDef) => {
    const isInstalled = installed.includes(plugin.id);
    return (
      <div key={plugin.id} className="plugin-row">
        <button
          type="button"
          className="plugin-open"
          onClick={() => {
            setDetailId(plugin.id);
            setConnectorsOpen(false);
          }}
        >
          <PluginTile plugin={plugin} />
          <span className="plugin-text">
            <span className="plugin-name">{plugin.name}</span>
            <span className="plugin-desc">{plugin.description}</span>
          </span>
        </button>
        {isInstalled ? (
          <span className="plugin-added">
            <Check size={13} strokeWidth={2.2} aria-hidden="true" />
            Added
          </span>
        ) : (
          <button
            type="button"
            className="modal-button plugin-add"
            onClick={() => onSetInstalled(plugin.id, true)}
          >
            Add
          </button>
        )}
      </div>
    );
  };

  const renderList = () => (
    <>
      <div className="plugins-header">
        <h2 className="modal-title">Plugins</h2>
        <button
          type="button"
          className="icon-button modal-close"
          aria-label="Close plugins"
          onClick={requestClose}
        >
          <X size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <div className="plugins-toolbar">
        <div className="plugins-tabs" role="tablist" aria-label="Plugin lists">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "marketplace"}
            className={tab === "marketplace" ? "plugins-tab plugins-tab-active" : "plugins-tab"}
            onClick={() => setTab("marketplace")}
          >
            Marketplace
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "yours"}
            className={tab === "yours" ? "plugins-tab plugins-tab-active" : "plugins-tab"}
            onClick={() => setTab("yours")}
          >
            Yours
          </button>
        </div>
        <div className="plugins-toolbar-end">
          <div className="plugins-filter" ref={filterRef}>
            <button
              type="button"
              className="icon-button"
              aria-label="Filter plugins"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((open) => !open)}
            >
              <ListFilter size={16} strokeWidth={1.8} aria-hidden="true" />
            </button>
            {filterOpen ? (
              <div className="filter-menu" role="menu" aria-label="Plugin filters">
                <p className="filter-section">Type</p>
                {(
                  [
                    ["all", "All types"],
                    ["connectors", "Connectors"],
                    ["skills", "Skills"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={typeFilter === value}
                    key={`type-${value}`}
                    className="account-menu-item filter-item"
                    onClick={() => setTypeFilter(value)}
                  >
                    {label}
                    {typeFilter === value ? (
                      <Check
                        size={14}
                        strokeWidth={2}
                        aria-hidden="true"
                        className="filter-check"
                      />
                    ) : null}
                  </button>
                ))}
                <div className="modal-divider" />
                <p className="filter-section">Ownership</p>
                {(
                  [
                    ["all", "All"],
                    ["team", "Team"],
                    ["public", "Public"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={ownershipFilter === value}
                    key={`own-${value}`}
                    className="account-menu-item filter-item"
                    onClick={() => setOwnershipFilter(value)}
                  >
                    {label}
                    {ownershipFilter === value ? (
                      <Check
                        size={14}
                        strokeWidth={2}
                        aria-hidden="true"
                        className="filter-check"
                      />
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="plugins-search">
            <Search size={13} strokeWidth={2} aria-hidden="true" className="search-glyph" />
            <input
              type="search"
              className="search-input"
              placeholder="Search plugins"
              aria-label="Search plugins"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
        </div>
      </div>

      <div className="plugins-body">
        {visiblePlugins.length === 0 ? (
          <p className="plugins-empty">
            {tab === "yours" && trimmed.length === 0
              ? "No plugins added yet. Browse the Marketplace to add one."
              : "No plugins match your search."}
          </p>
        ) : null}
        {trimmed.length > 0 || tab === "yours" ? (
          <div className="plugin-grid">{visiblePlugins.map(renderRow)}</div>
        ) : (
          PLUGIN_CATEGORIES.map((category) => {
            const inCategory = visiblePlugins.filter((plugin) => plugin.category === category);
            if (inCategory.length === 0) {
              return null;
            }
            const isExpanded = expanded[category] === true;
            const shown = isExpanded ? inCategory : inCategory.slice(0, PREVIEW_COUNT);
            const hidden = inCategory.length - shown.length;
            return (
              <section key={category} aria-label={category}>
                <p className="modal-section-label">{category}</p>
                <div className="plugin-grid">{shown.map(renderRow)}</div>
                {hidden > 0 ? (
                  <button
                    type="button"
                    className="plugins-show-more"
                    onClick={() => setExpanded((previous) => ({ ...previous, [category]: true }))}
                  >
                    Show {hidden} more
                  </button>
                ) : null}
              </section>
            );
          })
        )}
      </div>
    </>
  );

  const renderDetail = (plugin: PluginDef) => {
    const isInstalled = installed.includes(plugin.id);
    return (
      <>
        <div className="plugins-header plugins-detail-header">
          <button
            type="button"
            className="icon-button"
            aria-label="Back to plugins"
            onClick={() => setDetailId(null)}
          >
            <ChevronLeft size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <h2 className="plugins-detail-title">{plugin.name}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close plugins"
            onClick={requestClose}
          >
            <X size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>

        <div className="plugins-body">
          <div className="plugin-hero">
            <PluginTile plugin={plugin} size={52} />
            <div className="plugin-hero-text">
              <h3 className="plugin-hero-name">{plugin.name}</h3>
              <a className="plugin-source" href={plugin.sourceUrl} target="_blank" rel="noreferrer">
                View Source
                <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
              </a>
            </div>
            {isInstalled ? (
              <button
                type="button"
                className="modal-button plugin-add"
                onClick={() => onSetInstalled(plugin.id, false)}
              >
                Uninstall
              </button>
            ) : (
              <button
                type="button"
                className="modal-button plugin-add"
                onClick={() => onSetInstalled(plugin.id, true)}
              >
                Add
              </button>
            )}
          </div>

          <p className="plugin-detail-desc">{plugin.description}</p>

          <p className="modal-section-label">Accounts</p>
          <div className="modal-card">
            <div className="modal-row">
              <span className="modal-row-label">Default</span>
              <span className="plugin-auth">
                <span className="plugin-needs-auth">Needs auth</span>
                <button type="button" className="modal-button">
                  Authenticate
                </button>
              </span>
            </div>
            <div className="modal-divider" />
            <button type="button" className="plugin-add-account">
              <Plus size={14} strokeWidth={2} aria-hidden="true" />
              Add Another Account
            </button>
          </div>

          <p className="modal-section-label">Connectors</p>
          <div className="modal-card">
            <button
              type="button"
              className="plugin-connectors"
              aria-expanded={connectorsOpen}
              onClick={() => setConnectorsOpen((open) => !open)}
            >
              1 connector
              <ChevronDown
                size={14}
                strokeWidth={2}
                aria-hidden="true"
                className={
                  connectorsOpen
                    ? "connectors-chevron connectors-chevron-open"
                    : "connectors-chevron"
                }
              />
            </button>
            {connectorsOpen ? (
              <div className="plugin-connector-row">
                <PluginTile plugin={plugin} size={24} />
                {plugin.name} MCP server
              </div>
            ) : null}
          </div>
        </div>
      </>
    );
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss mirrors the Escape path
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the dialog itself
    <div
      className={closing ? "modal-backdrop modal-backdrop-closing" : "modal-backdrop"}
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
        ref={dialogRef}
        className={
          closing
            ? "settings-modal plugins-modal settings-modal-closing"
            : "settings-modal plugins-modal"
        }
        role="dialog"
        aria-modal="true"
        aria-label="Plugins"
        tabIndex={-1}
      >
        {detail === null ? renderList() : renderDetail(detail)}
      </div>
    </div>
  );
}
