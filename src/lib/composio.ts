import { invoke } from "@tauri-apps/api/core";
import { plugins } from "@/data/plugins";
import { isTauri } from "@/lib/tauri";

/**
 * Composio: the broker that owns the OAuth dance for every plugin.
 *
 * Connecting Gmail or Calendar means an OAuth app registered with Google — a
 * redirect URI, a client secret, a token refresh loop — per provider. Composio
 * runs those apps, so this app registers none of them.
 *
 * **The CLI owns the credential, and this app stores nothing.** An earlier
 * draft asked the user to paste an API key from the dashboard and kept it in
 * the OS keychain. `composio login` is strictly better: `--no-wait` prints a
 * login URL and exits, the browser does the sign-in, and `--poll` waits for it
 * — so the user never visits a dashboard, never copies a key, and the
 * credential lands in `~/.composio/config.json` under the CLI's own care.
 * Even a pasted key would only have been forwarded to `login --user-api-key`,
 * so holding a second copy bought nothing.
 */

/**
 * Whether the CLI is on this machine, as a version string.
 *
 * A plain browser cannot see the filesystem, so "not installed" is the only
 * honest answer there — same shape as `isOllamaInstalled`.
 */
export async function composioCliVersion(): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }
  try {
    return await invoke<string | null>("composio_cli_version");
  } catch {
    return null;
  }
}

/**
 * Whether this platform can run Composio's installer.
 *
 * It is a POSIX shell script, so Windows is a WSL-only path. Outside Tauri
 * this answers `true`: saying otherwise would put "needs WSL" on screen in a
 * dev browser, which is the wrong reason — let the install itself explain.
 */
export async function composioCliInstallable(): Promise<boolean> {
  if (!isTauri()) {
    return true;
  }
  try {
    return await invoke<boolean>("composio_cli_installable");
  } catch {
    return false;
  }
}

/**
 * Download and run Composio's installer. Resolves to the installed version.
 *
 * Rejects rather than returning a sentinel: the caller shows the message, and
 * a failed install is exactly the case the user needs told about.
 */
export function installComposioCli(): Promise<string> {
  if (!isTauri()) {
    return Promise.reject(new Error("The installer only runs in the desktop app."));
  }
  return invoke<string>("composio_cli_install");
}

/**
 * Whether the CLI holds a login.
 *
 * Not an exit-code probe: every authenticated CLI command exits **0 with
 * empty output** when logged out (measured), so running one would report
 * "connected" to someone who never signed in. The Rust side reads the
 * credential itself.
 */
export async function composioSignedIn(): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }
  try {
    return await invoke<boolean>("composio_signed_in");
  } catch {
    return false;
  }
}

/**
 * Start a login and get the URL the user must open.
 *
 * Rejects when the CLI is missing or prints no usable link; the caller shows
 * the message rather than opening something unexpected.
 */
export function startComposioLogin(): Promise<string> {
  if (!isTauri()) {
    return Promise.reject(new Error("Signing in only works in the desktop app."));
  }
  return invoke<string>("composio_login_start");
}

/** How long to wait for an OAuth consent screen before giving up on it. */
const LINK_TIMEOUT_MS = 5 * 60_000;

/** Gap between checks. Each one spawns a process, so it is not a tight loop. */
const LINK_POLL_MS = 2_000;

/**
 * Find tools for a task. Returns Composio's ranked plan as JSON text.
 *
 * This is what makes three meta-tools enough. Gmail alone exposes 61 tools;
 * shipping their definitions would swamp the prompt's cached prefix and would
 * have to be repeated per app. Instead the model asks for what it needs at
 * call time, and discovery scales to any app connected later with no code.
 */
export async function composioSearch(query: string): Promise<string> {
  if (!isTauri()) {
    return "Connected apps are only available in the desktop app.";
  }
  try {
    return await invoke<string>("composio_search", { query });
  } catch (error) {
    // Returned, not thrown: a failed tool call is information the model can
    // act on, while an exception would abort the whole turn.
    return error instanceof Error ? error.message : String(error);
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
  if (!isTauri()) {
    return "Connected apps are only available in the desktop app.";
  }
  try {
    return await invoke<string>("composio_schema", { tool });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Run one tool. `args` is a JSON object matching its schema. */
export async function composioExecute(tool: string, args: string): Promise<string> {
  if (!isTauri()) {
    return "Connected apps are only available in the desktop app.";
  }
  try {
    return await invoke<string>("composio_execute", { tool, arguments: args });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Where a user manages accounts we cannot manage for them. */
export const COMPOSIO_DASHBOARD_URL = "https://dashboard.composio.dev/";

/** One connected account of one app. */
export interface ComposioAccount {
  toolkit: string;
  /** The CLI's handle for this account, used to name it in `--account`. */
  id: string;
  /** User-chosen name for a second account on the same app, else empty. */
  alias: string;
  /** Address or username on the account, once resolved; "" until then. */
  identity?: string;
  /** Raw CLI status: ACTIVE, EXPIRED, INITIALIZING, … */
  status: string;
  active: boolean;
}

/**
 * The in-flight or finished account list, shared by every caller.
 *
 * `connections list` is a 1.7s CLI round trip (measured), and three things ask
 * for it: the prompt's app list at startup, the Plugins tiles, and the detail
 * panel. Without this they each pay the 1.7s, and opening Plugins right after
 * launch pays it twice concurrently. Cleared whenever a connection changes.
 */
let accountsPromise: Promise<ComposioAccount[]> | null = null;

/** Forget the cached account list, after connecting or disconnecting. */
export function forgetComposioAccounts(): void {
  accountsPromise = null;
}

/**
 * Every connected account, across every app.
 *
 * Includes broken ones on purpose — callers decide what an inactive one means.
 */
export async function composioAccounts(): Promise<ComposioAccount[]> {
  if (!isTauri()) {
    return [];
  }
  accountsPromise ??= invoke<ComposioAccount[]>("composio_accounts").catch(() => {
    // A failure must not be remembered: the CLI may simply not be installed
    // yet, and the next open should ask again.
    accountsPromise = null;
    return [] as ComposioAccount[];
  });
  return accountsPromise;
}

/**
 * Identities, kept for the life of the app run.
 *
 * An address costs a 3.1s CLI round trip (measured) and never changes for a
 * given account handle — Composio mints a new handle rather than moving an
 * address between them. Re-fetching it every time the Plugins panel opens
 * spends three seconds to learn what it already knew.
 *
 * Deliberately not persisted: a run is long enough to matter, and a stale
 * address surviving a restart would outlive the account it named.
 */
const identities = new Map<string, string>();

/**
 * The address or username behind one account, or "" when unknown.
 *
 * `connections list` names accounts only by an internal handle
 * (`gmail_casava-tst`), which tells the person who connected them nothing and
 * cannot distinguish two Gmail accounts. This costs one CLI call per account,
 * so callers fetch it once per panel open and fall back to the handle.
 */
export async function composioAccountIdentity(toolkit: string, account: string): Promise<string> {
  if (!isTauri()) {
    return "";
  }
  const hit = identities.get(account);
  if (hit !== undefined) {
    return hit;
  }
  try {
    const found = await invoke<string>("composio_account_identity", { toolkit, account });
    // Only a real answer is cached: an empty one means the call failed or the
    // toolkit has no profile tool, and both are worth retrying next open.
    if (found !== "") {
      identities.set(account, found);
    }
    return found;
  } catch {
    return "";
  }
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
  const slugs = await composioConnections();
  return slugs.map((slug) => plugins.find((plugin) => plugin.id === slug)?.name ?? slug);
}

/**
 * Start connecting one app, returning the URL to open.
 *
 * Rejects when the CLI is missing or answers with something unexpected — the
 * caller shows that rather than opening an unknown page.
 */
export function startComposioLink(toolkit: string, alias = ""): Promise<string> {
  if (!isTauri()) {
    return Promise.reject(new Error("Connecting apps only works in the desktop app."));
  }
  // An alias is required by the CLI for any *additional* account on an app
  // already connected; empty means "the first one".
  return invoke<string>("composio_link_start", { toolkit, alias });
}

/**
 * Wait for a connect to finish in the browser.
 *
 * `composio link` has no `--poll` counterpart to login's, so completion is
 * read from `connections list` — which is the source of truth anyway, and the
 * same lesson as the login bug: trust the disk, not a command's own answer.
 *
 * Resolves false when the user abandons the tab. Callers must keep a way out
 * on screen for the whole window.
 */
export async function waitForComposioLink(
  toolkit: string,
  before: ComposioAccount[],
): Promise<boolean> {
  // Compare against the accounts that were already usable, not just "is this
  // app connected": adding a second Gmail to an account that already has one
  // would otherwise report success the instant it started, before the user
  // had touched the browser.
  const known = new Set(before.filter((account) => account.active).map((account) => account.id));
  const deadline = Date.now() + LINK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Each pass must ask the CLI again: polling a cached answer would wait out
    // the whole five minutes on a snapshot taken before the browser opened.
    forgetComposioAccounts();
    const now = await composioAccounts();
    if (now.some((a) => a.toolkit === toolkit && a.active && !known.has(a.id))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, LINK_POLL_MS));
  }
  return false;
}

/**
 * Wait for the browser half of the login to finish.
 *
 * Resolves false when the user abandons it — a real outcome, not an error.
 * Can take minutes, so callers must keep a way out on screen.
 */
export async function pollComposioLogin(): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }
  try {
    return await invoke<boolean>("composio_login_poll");
  } catch {
    return false;
  }
}
