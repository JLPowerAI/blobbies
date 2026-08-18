import { ArrowUpRight, Check, ChevronLeft, ListFilter, Plus, Search, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { ExternalLink } from "@/components/ExternalLink";
import { PLUGIN_CATEGORIES, type PluginDef, plugins } from "@/data/plugins";
import {
  COMPOSIO_DASHBOARD_URL,
  type ComposioAccount,
  composioAccounts,
  startComposioLink,
  waitForComposioLink,
} from "@/lib/composio";
import { openExternal } from "@/lib/tauri";
import { useExitAnimation } from "@/lib/useExitAnimation";

/** Rows shown per category before the "Show N more" expander. */
const PREVIEW_COUNT = 4;

interface PluginsModalProps {
  installed: string[];
  onSetInstalled: (id: string, installed: boolean) => void;
  onClose: () => void;
}

/** Brand tile: exported because onboarding's plugin step draws the same one. */
export function PluginTile({ plugin, size = 40 }: { plugin: PluginDef; size?: number }) {
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
  /**
   * Every account Composio knows about, working or not.
   *
   * `installed` is the user's own shortlist — which apps they care about — and
   * is a different question from whether the account can actually reach them.
   * Only Composio can answer the second, so it is read rather than inferred.
   */
  const [accounts, setAccounts] = useState<ComposioAccount[]>([]);
  const [connecting, setConnecting] = useState("");
  /** Which app is having a second account named, and the name so far. */
  const [addingTo, setAddingTo] = useState("");
  const [alias, setAlias] = useState("");
  const [connectError, setConnectError] = useState("");
  /** Which row the error belongs to, so it is never shown against another. */
  const [failedId, setFailedId] = useState("");
  const [tab, setTab] = useState<"marketplace" | "yours">("marketplace");
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<"all" | "connectors" | "skills">("all");
  const [ownershipFilter, setOwnershipFilter] = useState<"all" | "team" | "public">("all");
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void composioAccounts().then(setAccounts);
  }, []);

  const accountsFor = (toolkit: string) =>
    accounts.filter((account) => account.toolkit === toolkit);
  /** A tile is green only when at least one account can actually be used. */
  const isConnected = (toolkit: string) => accountsFor(toolkit).some((account) => account.active);

  /**
   * Connect one app: mint a link, open the real browser, wait for Composio.
   *
   * The plugin id doubles as the Composio toolkit slug, which is why the
   * existing catalog maps over without a translation table.
   */
  const connect = async (plugin: PluginDef, accountAlias = "") => {
    setConnecting(plugin.id);
    setConnectError("");
    setFailedId("");
    try {
      // Snapshot first: completion means a *new* usable account appeared, not
      // merely that this app is connected — which it may already have been.
      const before = accounts;
      await openExternal(await startComposioLink(plugin.id, accountAlias));
      if (await waitForComposioLink(plugin.id, before)) {
        // Connecting an app is also a statement of intent, so it joins the
        // user's shortlist rather than making them add it twice.
        onSetInstalled(plugin.id, true);
      }
      setAccounts(await composioAccounts());
      setAddingTo("");
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : String(error));
      setFailedId(plugin.id);
    } finally {
      setConnecting("");
    }
  };
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
    return (
      <div key={plugin.id} className="plugin-row">
        <button
          type="button"
          className="plugin-open"
          onClick={() => {
            setDetailId(plugin.id);
          }}
        >
          <PluginTile plugin={plugin} />
          <span className="plugin-text">
            <span className="plugin-name">{plugin.name}</span>
            {/* The failure replaces the description on the row that caused it:
                shown anywhere else, a missing CLI and an abandoned browser tab
                both look like a button that did nothing. */}
            <span className="plugin-desc">
              {connectError !== "" && connecting === "" && failedId === plugin.id
                ? connectError
                : plugin.description}
            </span>
          </span>
        </button>
        {isConnected(plugin.id) ? (
          <span className="plugin-added">Connected</span>
        ) : (
          <button
            type="button"
            className="modal-button plugin-add"
            disabled={connecting !== ""}
            onClick={() => void connect(plugin)}
          >
            {connecting === plugin.id ? "Waiting\u2026" : "Connect"}
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
              {/* Not a raw anchor: the webview must never navigate away from
                  the bundled app, since a navigated webview keeps the IPC
                  bridge and remote content could then call commands. */}
              <ExternalLink className="plugin-source" href={plugin.sourceUrl}>
                View Source
                <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
              </ExternalLink>
            </div>
            {isConnected(plugin.id) ? (
              <span className="plugin-added">Connected</span>
            ) : (
              <button
                type="button"
                className="modal-button plugin-add"
                disabled={connecting !== ""}
                onClick={() => void connect(plugin)}
              >
                {connecting === plugin.id ? "Waiting\u2026" : "Connect"}
              </button>
            )}
            {connectError !== "" && failedId === plugin.id ? (
              <span className="plugin-desc">{connectError}</span>
            ) : null}
          </div>

          <p className="plugin-detail-desc">{plugin.description}</p>

          <p className="modal-section-label">Accounts</p>
          <div className="modal-card">
            {accountsFor(plugin.id).length === 0 ? (
              <div className="modal-row">
                <span className="modal-row-blurb">
                  No account connected yet. Connecting opens {plugin.name} in your browser.
                </span>
              </div>
            ) : (
              accountsFor(plugin.id).map((account, position) => (
                <Fragment key={account.id}>
                  {position === 0 ? null : <div className="modal-divider" />}
                  <div className="modal-row">
                    {/* The alias is what the user named it; the CLI's word_id
                        is the fallback, since it is what they would type to
                        manage the account themselves. */}
                    <span className="modal-row-label">{account.alias || account.id}</span>
                    <span className="plugin-auth">
                      {account.active ? (
                        <span className="plugin-added">Connected</span>
                      ) : (
                        <>
                          {/* The raw status, not a euphemism: EXPIRED and
                              INITIALIZING need different actions from the
                              user, and flattening both to "Needs auth" hides
                              which one they are looking at. */}
                          <span className="plugin-needs-auth">{account.status.toLowerCase()}</span>
                          <button
                            type="button"
                            className="modal-button"
                            disabled={connecting !== ""}
                            onClick={() => void connect(plugin)}
                          >
                            Reconnect
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                </Fragment>
              ))
            )}
            <div className="modal-divider" />
            {addingTo === plugin.id ? (
              <div className="modal-row">
                <input
                  className="modal-name-input"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Name for the new account"
                  placeholder="work, personal\u2026"
                  value={alias}
                  onChange={(event) => setAlias(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void connect(plugin, alias.trim());
                    }
                  }}
                />
                <button
                  type="button"
                  className="modal-button"
                  disabled={alias.trim() === "" || connecting !== ""}
                  onClick={() => void connect(plugin, alias.trim())}
                >
                  {connecting === plugin.id ? "Waiting\u2026" : "Connect"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="plugin-add-account"
                onClick={() => {
                  // A second account on the same app needs a name: the CLI
                  // requires an alias to tell them apart, so the field is
                  // shown before the browser opens rather than after.
                  setAddingTo(plugin.id);
                  setAlias("");
                }}
              >
                <Plus size={14} strokeWidth={2} aria-hidden="true" />
                Add Another Account
              </button>
            )}
          </div>
          {connectError !== "" && failedId === plugin.id ? (
            <p className="modal-row-blurb">{connectError}</p>
          ) : null}

          <p className="modal-section-label">Removing an account</p>
          <div className="modal-card">
            <div className="modal-row modal-row-multiline">
              <span className="modal-row-text">
                {/* Honest rather than a button that cannot work: the CLI's
                    remove command is an arrow-key menu with no non-interactive
                    flag (measured — piping and a pseudo-terminal both fail),
                    so driving it from here would mean scraping a TUI. */}
                <span className="modal-row-blurb">
                  Removing an account is done on Composio's dashboard.
                </span>
              </span>
              <button
                type="button"
                className="modal-button"
                onClick={() => void openExternal(COMPOSIO_DASHBOARD_URL)}
              >
                Open Dashboard
              </button>
            </div>
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
