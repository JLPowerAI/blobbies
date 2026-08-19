import { Check, ChevronLeft, ListFilter, Plus, Search, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { loadPlugins, PLUGIN_CATEGORIES, type PluginDef } from "@/data/plugins";
import {
  COMPOSIO_DASHBOARD_URL,
  type ComposioAccount,
  composioAccountIdentity,
  composioAccounts,
  forgetComposioAccounts,
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

/**
 * Brand tile: exported because onboarding's plugin step draws the same one.
 *
 * Each app's real logo, committed under `public/logos` by
 * `scripts/sync-plugins.mjs` — a monogram in a coloured square is not a brand,
 * and the vendors' own marks are what a user recognises in a long list.
 *
 * Drawn with `<img>` rather than inlined markup on purpose: an SVG inlined
 * into the DOM runs whatever it contains, while one behind `<img>` is inert.
 * The fetch script rejects active SVGs too, so this is the second of the two.
 *
 * The tile stays white in both themes because these marks are drawn for light
 * backgrounds — GitHub's and Notion's are near-black, and would disappear on
 * a dark tile.
 */
export function PluginTile({ plugin, size = 40 }: { plugin: PluginDef; size?: number }) {
  return (
    <span className="plugin-tile" style={{ width: size, height: size }} aria-hidden="true">
      <img
        src={`/logos/${plugin.id}.svg`}
        alt=""
        width={Math.round(size * 0.62)}
        height={Math.round(size * 0.62)}
        loading="lazy"
        decoding="async"
        draggable="false"
      />
    </span>
  );
}

/** Marketplace + per-plugin detail, presented in the settings-sized modal. */
export function PluginsModal({ installed, onSetInstalled, onClose }: PluginsModalProps) {
  /**
   * The full catalog, curated plus the generated long tail.
   *
   * Loaded once here rather than imported statically: the long tail is a
   * ~90 KB chunk behind a dynamic import (a static one blew the startup
   * bundle budget), and this modal is the only place that browses it.
   */
  const [catalog, setCatalog] = useState<PluginDef[] | null>(null);

  useEffect(() => {
    void loadPlugins().then(setCatalog);
  }, []);

  /**
   * Every account Composio knows about, working or not.
   *
   * `installed` is the user's own shortlist — which apps they care about — and
   * is a different question from whether the account can actually reach them.
   * Only Composio can answer the second, so it is read rather than inferred.
   */
  const [accounts, setAccounts] = useState<ComposioAccount[]>([]);
  const [connecting, setConnecting] = useState("");
  /** Aborts the in-flight wait, so "Waiting…" is never a one-way door. */
  const cancelRef = useRef<AbortController | null>(null);
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

  /**
   * Two stages, because they cost very different amounts.
   *
   * Measured: `connections list` is 1.7s and answers *which apps are
   * connected* — everything the tiles need. `GMAIL_GET_PROFILE` is another
   * 3.1s per account and answers only *which address*, which is needed one
   * click deeper. Waiting for both before painting anything made every tile
   * sit blank for ~5 seconds.
   *
   * So the tiles unblock at stage one, and the addresses arrive at stage two.
   * That is not the flicker this replaced: a row never contradicts itself,
   * because a row without its address does not render at all — `namesLoaded`
   * gates the account list the same way `loaded` gates the tiles.
   */
  const [loaded, setLoaded] = useState(false);
  const [namesLoaded, setNamesLoaded] = useState(false);

  useEffect(() => {
    void composioAccounts().then(async (found) => {
      // Only accounts that work. An expired one cannot be repaired from here
      // (composio link only ever creates) and cannot even name itself, so its
      // row was a dead handle the user could neither read nor act on.
      const usable = found.filter((account) => account.active);
      setAccounts(usable);
      setLoaded(true);
      const named = await Promise.all(
        usable.map(async (account) => ({
          ...account,
          identity: await composioAccountIdentity(account.toolkit, account.id),
        })),
      );
      setAccounts(named);
      setNamesLoaded(true);
    });
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
    // Abandoning the browser tab is the common case, not the exception.
    // Without this the row sits on "Waiting…" until the wait expires, with
    // nothing to press — which reads as a hung app rather than a choice the
    // user already made.
    const controller = new AbortController();
    cancelRef.current = controller;
    setConnecting(plugin.id);
    setConnectError("");
    setFailedId("");
    try {
      // Snapshot first: completion means a *new* usable account appeared, not
      // merely that this app is connected — which it may already have been.
      const before = accounts;
      await openExternal(await startComposioLink(plugin.id, accountAlias));
      if (await waitForComposioLink(plugin.id, before, controller.signal)) {
        // Connecting an app is also a statement of intent, so it joins the
        // user's shortlist rather than making them add it twice.
        onSetInstalled(plugin.id, true);
        setAddingTo("");
      } else if (!controller.signal.aborted) {
        // Ran the full window with nothing to show. Silence here left the row
        // back on "Connect" as if the click had never happened — but this is
        // not a failure either: a slow consent still completes in Composio and
        // appears the next time this panel reads its accounts, so the wording
        // must not send the user off to redo something that already worked.
        setConnectError("Still not connected. Finish in the browser, then reopen this panel.");
        setFailedId(plugin.id);
      }
      // A fresh connection is exactly the thing the cache does not know about.
      forgetComposioAccounts();
      setAccounts((await composioAccounts()).filter((account) => account.active));
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : String(error));
      setFailedId(plugin.id);
    } finally {
      cancelRef.current = null;
      setConnecting("");
    }
  };

  /** Ends the wait the user is currently sitting in, if any. */
  const cancelConnect = () => cancelRef.current?.abort();

  /**
   * Connect, or the way out of a connect already running.
   *
   * The same button cancels while this app is the one waiting. Abandoning the
   * consent tab is ordinary — wrong account, changed mind — and the previous
   * behaviour left every control disabled for the whole window with no exit,
   * which is indistinguishable from a hang.
   */
  const renderConnect = (
    plugin: PluginDef,
    className: string,
    onStart: () => void,
    blocked = false,
  ) =>
    connecting === plugin.id ? (
      <button type="button" className={className} onClick={cancelConnect}>
        Cancel
      </button>
    ) : (
      <button
        type="button"
        className={className}
        disabled={blocked || connecting !== ""}
        onClick={onStart}
      >
        Connect
      </button>
    );
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

  const detail =
    detailId === null || catalog === null ? null : (catalog.find((p) => p.id === detailId) ?? null);
  const trimmed = query.trim().toLowerCase();

  const visiblePlugins = (catalog ?? []).filter((plugin) => {
    // "Yours" answers "what do I have", not "what did I bookmark": an app
    // connected before the shortlist auto-add existed (or outside the app
    // entirely) is still the user's, so the union of the shortlist and the
    // live account list is the honest membership. A connection only counts
    // once its account is known usable — expired ones are not "yours" in any
    // sense the Connect button can act on.
    if (tab === "yours" && !installed.includes(plugin.id) && !isConnected(plugin.id)) {
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
        {/* Nothing until the probe answers: rendering Connect first meant every
            already-connected app flashed the wrong state before correcting
            itself, which reads as the app not knowing what it is doing. */}
        {!loaded ? null : isConnected(plugin.id) ? (
          <span className="plugin-added">Connected</span>
        ) : (
          renderConnect(plugin, "modal-button plugin-add", () => void connect(plugin))
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
            </div>
            {!loaded ? null : isConnected(plugin.id) ? (
              <span className="plugin-added">Connected</span>
            ) : (
              renderConnect(plugin, "modal-button plugin-add", () => void connect(plugin))
            )}
            {connectError !== "" && failedId === plugin.id ? (
              <span className="plugin-desc">{connectError}</span>
            ) : null}
          </div>

          <p className="plugin-detail-desc">{plugin.description}</p>

          <p className="modal-section-label">Accounts</p>
          <div className="modal-card">
            {/* Also reached when every account for this app has expired: they
                are filtered out, so "no account connected" is the honest state
                — none of them can do anything. */}
            {!namesLoaded || accountsFor(plugin.id).length === 0 ? (
              <div className="modal-row">
                <span className="modal-row-blurb">
                  {!namesLoaded
                    ? "Checking\u2026"
                    : `No account connected yet. Connecting opens ${plugin.name} in your browser.`}
                </span>
              </div>
            ) : (
              accountsFor(plugin.id).map((account, position) => (
                <Fragment key={account.id}>
                  {position === 0 ? null : <div className="modal-divider" />}
                  <div className="modal-row">
                    {/* The address on the account, or the name the user gave
                        it. Composio's internal handle ("gmail_casava-tst") is
                        never shown: it names nothing the user has ever seen.
                        Every row here is a working account — unusable ones are
                        filtered out above — so there is no status to render
                        either, only the identity and a Connected pill. */}
                    <span className="modal-row-label">
                      {account.identity || account.alias || plugin.name}
                    </span>
                    <span className="plugin-auth">
                      <span className="plugin-added">Connected</span>
                    </span>
                  </div>
                </Fragment>
              ))
            )}
            <div className="modal-divider" />
            {addingTo === plugin.id ? (
              <div className="modal-row">
                {/* Literal characters in JSX attributes: they are not JS
                    strings, so a \u2026 escape renders as those six chars. */}
                <input
                  className="modal-name-input"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Name for the new account"
                  placeholder="work, personal…"
                  value={alias}
                  onChange={(event) => setAlias(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void connect(plugin, alias.trim());
                    }
                  }}
                />
                {renderConnect(
                  plugin,
                  "modal-button",
                  () => void connect(plugin, alias.trim()),
                  alias.trim() === "",
                )}
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

          <p className="modal-section-label">Managing accounts</p>
          <div className="modal-card">
            <div className="modal-row modal-row-multiline">
              <span className="modal-row-text">
                {/* Honest rather than buttons that cannot work. Removing: the
                    CLI's remove command is an arrow-key menu with no
                    non-interactive flag (measured — piping and a pseudo-terminal
                    both fail), so driving it would mean scraping a TUI.
                    Repairing: `composio link` only creates, and demands a fresh
                    alias once an account exists, so a "Reconnect" button added a
                    row instead of fixing one. */}
                <span className="modal-row-blurb">
                  Removing an account, or repairing an expired one, is done on Composio's dashboard.
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
        {/* Nothing until the catalog chunk resolves: a list that grows
            mid-glance reads as a bug, not a refresh. */}
        {catalog === null ? null : detail === null ? renderList() : renderDetail(detail)}
      </div>
    </div>
  );
}
