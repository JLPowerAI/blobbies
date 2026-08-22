import { loadPlugins } from "@/data/plugins";
import { callComposioTool, composioReachable, forgetComposioSession } from "@/lib/composio-mcp";

/**
 * Composio: the broker that owns the OAuth dance for every plugin.
 *
 * Connecting Gmail or Calendar means an OAuth app registered with Google — a
 * redirect URI, a client secret, a token refresh loop — per provider.
 * Composio runs those apps, so this app registers none of them.
 *
 * **This used to shell out to their CLI, and no longer does.** That binary
 * ships for macOS and Linux only; no Windows build exists and their installer
 * stops with "Windows is not supported". Since every plugin action ran
 * `composio execute`, the whole 942-app surface was dead on Windows rather
 * than merely awkward. Their hosted MCP endpoint needs no binary, so one code
 * path now serves every platform — and there is no 80MB install step, no
 * version drift between machines, and no WSL detour.
 *
 * The functions here keep the shapes their callers already expect; only the
 * transport underneath changed. `composio-mcp.ts` holds the pinned endpoint,
 * the credential and the tool allowlist.
 */

export { COMPOSIO_DASHBOARD_URL, forgetComposioSession } from "@/lib/composio-mcp";

/**
 * Whether Composio is usable right now: a key that actually works.
 *
 * A real handshake, not a "is a key present" check. A revoked or mistyped key
 * looks identical to a good one until it is used, and "connected" is the one
 * thing the Plugins tab must not get wrong.
 */
export async function composioSignedIn(): Promise<boolean> {
  return composioReachable();
}

/**
 * Turn a thrown transport failure into text the model can act on.
 *
 * Returned rather than rethrown: a failed tool call is information a Blob can
 * use — it can tell the user to reconnect — while an exception aborts the
 * whole turn and loses the rest of the work.
 */
function asText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Find tools for a task. Returns Composio's ranked plan as JSON text.
 *
 * This is what makes three meta-tools enough. Gmail alone exposes 61 tools;
 * shipping their definitions would swamp the prompt's cached prefix and would
 * have to be repeated per app. Instead the model asks for what it needs at
 * call time, and discovery scales to any app connected later with no code.
 */
export async function composioSearch(query: string): Promise<string> {
  try {
    return await callComposioTool("COMPOSIO_SEARCH_TOOLS", { use_case: query });
  } catch (error) {
    return asText(error);
  }
}

/**
 * The input schema for one tool, carrying Composio's own field descriptions.
 *
 * Those descriptions are written by the people who built each integration and
 * are far better than anything we would invent — which is why nothing here is
 * hardcoded, and why the text is passed through whole.
 */
export async function composioSchema(tool: string): Promise<string> {
  try {
    return await callComposioTool("COMPOSIO_GET_TOOL_SCHEMAS", { tool_slugs: [tool] });
  } catch (error) {
    return asText(error);
  }
}

/** Run one tool. `args` is a JSON object matching its schema. */
export async function composioExecute(tool: string, args: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = args.trim() === "" ? {} : JSON.parse(args);
  } catch {
    // The model wrote this string, so a malformed one is its mistake to fix.
    // Saying so beats forwarding invalid JSON and relaying a vaguer error.
    return "The arguments were not valid JSON. Send a JSON object matching the tool schema.";
  }
  try {
    return await callComposioTool("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: tool, arguments: parsed }],
      // Never true. Syncing pushes the result into Composio's remote workbench
      // sandbox for further processing there — off-device handling of the
      // user's own mail and files, which is the thing this app exists to
      // avoid. Results come back here and stay here.
      sync_response_to_workbench: false,
    });
  } catch (error) {
    return asText(error);
  }
}

/** One connected account of one app. */
export interface ComposioAccount {
  toolkit: string;
  /** Composio's handle for this account, used to name it in `account`. */
  id: string;
  /** User-chosen name for a second account on the same app, else empty. */
  alias: string;
  /** Address or username on the account, once resolved; "" until then. */
  identity?: string;
  /** Raw status: active, initiated, failed, … */
  status: string;
  active: boolean;
}

/**
 * Apps to ask about, seeded from saved settings.
 *
 * Composio's listing takes an explicit toolkit list — there is no "list
 * everything" call, and a wildcard is read as a literal toolkit name (tested:
 * it starts connecting an app called `*`). So the question is which names to
 * put in the request.
 *
 * Settings alone was the wrong answer. `settings.plugins` records what was
 * added *in this app*, but a connection can also be made on Composio's own
 * site, or through a Blob calling COMPOSIO_MANAGE_CONNECTIONS itself. Those
 * were invisible: the Plugins tab showed two apps while four were live, and
 * the system prompt named the same two, so a Blob told the user it had no
 * Reddit access while holding a working Reddit tool.
 *
 * The whole catalog is asked instead. Measured against the live endpoint:
 * 942 toolkits in one call, 1.2s, a 72KB reply that never reaches a model —
 * only the handful of active names do. That is one request per refresh, not
 * per app, so it costs about what asking for two used to.
 */
let watchedToolkits: string[] = [];

/**
 * Seed the ask-list with the user's own apps, so a first refresh names them
 * even if the catalog has not loaded yet.
 */
export function setComposioToolkits(toolkits: readonly string[]): void {
  const next = [...new Set(toolkits)].sort();
  if (next.join(",") !== watchedToolkits.join(",")) {
    watchedToolkits = next;
    forgetComposioAccounts();
  }
}

/**
 * Every toolkit worth asking about: the catalog, plus anything settings knows
 * that the catalog does not.
 */
async function toolkitsToQuery(): Promise<string[]> {
  const catalog = await loadPlugins();
  return [...new Set([...catalog.map((plugin) => plugin.id), ...watchedToolkits])];
}

/**
 * The in-flight or finished account list, shared by every caller.
 *
 * Three things ask for it — the prompt's app list at startup, the Plugins
 * tiles, and the detail panel — and without this each pays its own round
 * trip, twice over when Plugins opens right after launch.
 */
let accountsPromise: Promise<ComposioAccount[]> | null = null;

/** Forget the cached account list, after connecting or disconnecting. */
export function forgetComposioAccounts(): void {
  accountsPromise = null;
}

/** Shape Composio returns for a connections listing. */
interface ConnectionsPayload {
  data?: {
    results?: Record<
      string,
      {
        toolkit?: string;
        status?: string;
        accounts?: {
          id?: string;
          status?: string;
          alias?: string;
          user_info?: Record<string, unknown>;
        }[];
      }
    >;
  };
}

/**
 * Pull a human-recognisable identity out of an account's profile blob.
 *
 * Composio returns whatever the provider gave it, so the useful field is
 * named differently per app — `emailAddress` on Gmail, `login` on GitHub. The
 * old CLI needed a separate 3.1s call per account for this; the MCP listing
 * carries it inline, so it now costs nothing.
 */
function identityOf(info: Record<string, unknown> | undefined): string {
  for (const key of ["emailAddress", "email", "login", "username", "name", "displayName"]) {
    const value = info?.[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return "";
}

/**
 * Every connected account, across the apps the user has added.
 *
 * Includes broken ones on purpose — callers decide what an inactive one means.
 */
export async function composioAccounts(): Promise<ComposioAccount[]> {
  accountsPromise ??= (async () => {
    const toolkits = await toolkitsToQuery();
    if (toolkits.length === 0) {
      return [];
    }
    const raw = await callComposioTool("COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: toolkits.map((name) => ({ name, action: "list" })),
    });
    const parsed = JSON.parse(raw) as ConnectionsPayload;
    const out: ComposioAccount[] = [];
    for (const [slug, entry] of Object.entries(parsed.data?.results ?? {})) {
      for (const account of entry.accounts ?? []) {
        const status = account.status ?? entry.status ?? "unknown";
        out.push({
          toolkit: entry.toolkit ?? slug,
          id: account.id ?? "",
          alias: account.alias ?? "",
          identity: identityOf(account.user_info),
          status,
          active: status.toLowerCase() === "active",
        });
      }
    }
    return out;
  })().catch(() => {
    // A failure must not be remembered: the key may not be set yet, and the
    // next open should ask again.
    accountsPromise = null;
    return [] as ComposioAccount[];
  });
  return accountsPromise;
}

/**
 * The address or username behind one account, or "" when unknown.
 *
 * Now free: the listing carries it. Kept as a function so callers that ask
 * per row do not have to change shape.
 */
export async function composioAccountIdentity(_toolkit: string, account: string): Promise<string> {
  const accounts = await composioAccounts();
  return accounts.find((row) => row.id === account)?.identity ?? "";
}

/** Apps with at least one usable account — what a Blob can actually reach. */
export async function composioConnections(): Promise<string[]> {
  const accounts = await composioAccounts();
  return [...new Set(accounts.filter((account) => account.active).map((a) => a.toolkit))].sort();
}

/**
 * Connected apps by display name, for the system prompt.
 *
 * Slugs are Composio's vocabulary, not the user's: a Blob that says "gmail"
 * back to someone is quoting our plumbing. Falls back to the slug for an app
 * connected outside our catalog, which is better than dropping it silently.
 */
export async function connectedAppNames(): Promise<string[]> {
  const [slugs, catalog] = await Promise.all([composioConnections(), loadPlugins()]);
  return slugs.map((slug) => catalog.find((plugin) => plugin.id === slug)?.name ?? slug);
}

/** Anything that looks like the consent link Composio wants opened. */
const URL_IN_TEXT = /https:\/\/[^\s"'\\]+/;

/**
 * Start connecting one app, returning the URL to open.
 *
 * Rejects when Composio answers without a link — the caller shows that rather
 * than opening something unexpected.
 */
export async function startComposioLink(toolkit: string, alias = ""): Promise<string> {
  const raw = await callComposioTool("COMPOSIO_MANAGE_CONNECTIONS", {
    toolkits: [{ name: toolkit, action: "add", ...(alias === "" ? {} : { alias }) }],
  });
  const found = URL_IN_TEXT.exec(raw)?.[0];
  if (found === undefined) {
    throw new Error("Composio did not return a link to open.");
  }
  // Trailing punctuation from surrounding JSON must not ride along into the
  // browser.
  return found.replace(/[",.)\]}]+$/, "");
}

/**
 * How long to wait for an OAuth consent screen before giving up on it.
 *
 * Ninety seconds, not five minutes: most of a longer window is spent holding
 * a row hostage after the user has walked away, and Cancel is on screen for
 * the whole wait anyway.
 */
const LINK_TIMEOUT_MS = 90_000;

/** Gap between checks. */
const LINK_POLL_MS = 2_000;

/**
 * Wait for a connect to finish in the browser.
 *
 * Completion is read from the connection listing, which is the source of
 * truth, rather than from the answer to the request that started it.
 *
 * Resolves false when the user abandons the tab. Callers must keep a way out
 * on screen for the whole window — a spinner with no exit is
 * indistinguishable from a hang, so `signal` lets the user end it themselves.
 *
 * False means "not seen yet", not "failed": consent granted after the
 * deadline still lands on Composio's side and shows up on the next listing.
 * Callers must not word the timeout as a failure.
 */
export async function waitForComposioLink(
  toolkit: string,
  before: ComposioAccount[],
  signal?: AbortSignal,
): Promise<boolean> {
  // Compare against accounts that were already usable, not just "is this app
  // connected": adding a second Gmail to an account that has one would
  // otherwise report success the instant it started.
  const known = new Set(before.filter((account) => account.active).map((account) => account.id));
  const deadline = Date.now() + LINK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted === true) {
      return false;
    }
    // Each pass must ask again: polling a cached answer would wait out the
    // whole window on a snapshot taken before the browser opened.
    forgetComposioAccounts();
    const now = await composioAccounts();
    if (now.some((a) => a.toolkit === toolkit && a.active && !known.has(a.id))) {
      return true;
    }
    // Sleeping through an abort would leave the button dead for up to another
    // poll interval, so the wait ends the moment the signal fires. The
    // listener is removed on every exit.
    await new Promise<void>((resolve) => {
      const stop = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve();
      };
      const timer = setTimeout(stop, LINK_POLL_MS);
      signal?.addEventListener("abort", stop);
    });
  }
  return false;
}

/** Drop a connected account. */
export async function removeComposioAccount(toolkit: string, accountId: string): Promise<void> {
  await callComposioTool("COMPOSIO_MANAGE_CONNECTIONS", {
    toolkits: [{ name: toolkit, action: "remove", account_id: accountId }],
  });
  forgetComposioAccounts();
  forgetComposioSession();
}
