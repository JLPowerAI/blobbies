import { ArrowRight, Check, Search } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { BlobAvatar } from "@/components/BlobAvatar";
import { PluginTile } from "@/components/PluginsModal";
import type { AgentShape, AvatarTone } from "@/data/agents";
import { plugins } from "@/data/plugins";
import {
  composioCliVersion,
  composioSignedIn,
  installComposioCli,
  pollComposioLogin,
  startComposioLogin,
} from "@/lib/composio";
import { requestNotificationPermission } from "@/lib/notify";
import { setSecret } from "@/lib/secrets";
import { openExternal } from "@/lib/tauri";

/**
 * Steps in order; the index is the whole flow state.
 *
 * Making the first Blob is deliberately *not* a step: the flow ends by
 * handing over to the app's own creator (`CreatorPane`), which already owns
 * name uniqueness, the roster cap and the store write. A second creator here
 * would be a copy of that screen drifting away from it.
 */
/** The flow's screens. */
const ALL_STEPS = ["welcome", "blobs", "permissions", "tinfoil", "composio", "plugins"] as const;

type Step = (typeof ALL_STEPS)[number];

/**
 * The three Blobs that travel through the flow: the content of the "one job"
 * step, where CSS puts them on one slow clockwise orbit (phase spreads them
 * around it), then decoration once that step passes.
 *
 * The compact positions are deliberately uneven — different insets, heights
 * and scales — because three evenly spaced marks at one size read as a
 * progress indicator. They are percentages of the trio box in CSS, kept
 * under 20% or over 80% so every Blob sits in the margin beside the content
 * column and none can land on a card or a heading.
 */
const TRIO = [
  {
    job: "Inbox Triage",
    tone: "red",
    shape: "droplet",
    compactX: "9%",
    compactY: "14%",
    compactScale: 0.34,
  },
  {
    job: "Monday Recap",
    tone: "teal",
    shape: "cloud",
    compactX: "4%",
    compactY: "63%",
    compactScale: 0.26,
  },
  {
    job: "Pipeline Watch",
    tone: "blue",
    shape: "squircle",
    compactX: "93%",
    compactY: "27%",
    compactScale: 0.42,
  },
] as const satisfies readonly {
  job: string;
  tone: AvatarTone;
  shape: AgentShape;
  compactX: string;
  compactY: string;
  compactScale: number;
}[];

type PermissionState = "idle" | "granted" | "denied" | "unavailable";

/**
 * Shown, not resolved: the real path comes from Rust (`store::data_root`) and
 * naming the folder is the point of the row. `~` reads better than the
 * expanded home directory and is the same folder.
 */
const DATA_ROOT_LABEL = "~/.blobbies";

/**
 * Where Tinfoil hands out keys; opened in the real browser, not in-app.
 *
 * The dashboard root, deliberately not a deep link.
 *
 * `tinfoil.sh/dashboard/api-keys` redirects to `dash.tinfoil.sh/api-keys`,
 * which 404s (measured). The root is the stable entry point; keys are one
 * click from there, which beats landing someone on an error page.
 */
const TINFOIL_KEYS_URL = "https://dash.tinfoil.sh/";

/** Idle, or the outcome of one save attempt. */
type KeyState = "idle" | "saved" | "rejected";

/**
 * The Composio step's states, in the order a first run walks them.
 *
 * One machine rather than two flags because the states are sequential and
 * mutually exclusive: there is no "installing while signed in", and a pair of
 * booleans would allow several such nonsense combinations. `waiting` is the
 * one that matters most — the browser is open, this app is polling, and the
 * user needs a way out that is not force-quitting.
 */
type ComposioState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "missing" }
  | { kind: "installing" }
  | { kind: "installed" }
  | { kind: "opening" }
  | { kind: "waiting" }
  | { kind: "signedIn" }
  // `retry` names which step failed, so "Try again" repeats *that* one. Without
  // it a failed sign-in would offer a button wired to the installer.
  | { kind: "failed"; message: string; retry: "install" | "signIn" };

/**
 * What a pasted key must look like: one run of key characters, nothing else.
 *
 * This catches the mistakes a paste actually makes — wrapping quotes, a
 * trailing newline mid-string, `TINFOIL_API_KEY=` copied along with the
 * value, half a key. It deliberately does *not* claim the key works: that
 * needs an authenticated call through the attested client, which cannot run
 * here, so the copy below promises storage and nothing more.
 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;

interface OnboardingProps {
  /** Plugins already installed; the step is a live editor of that list. */
  installedPlugins: string[];
  onSetPluginInstalled: (id: string, installed: boolean) => void;
  /** Flow is over: mark it done and open the app's Blob creator. */
  onDone: () => void;
}

/**
 * First-run flow: welcome, what a Blob is, permissions, Tinfoil, Composio and
 * plugins, ending on the app's Blob creator. Rendered over the app shell, so nothing
 * behind it is reachable until it finishes; `onDone` is the only way out
 * (plus the dev toggle in Settings, which re-opens it on demand).
 */
export function Onboarding({ installedPlugins, onSetPluginInstalled, onDone }: OnboardingProps) {
  const [index, setIndex] = useState(0);
  const [notifications, setNotifications] = useState<PermissionState>("idle");
  const [key, setKey] = useState("");
  const [keyState, setKeyState] = useState<KeyState>("idle");
  const [query, setQuery] = useState("");
  const [composio, setComposio] = useState<ComposioState>({ kind: "idle" });
  const dialogRef = useRef<HTMLDivElement>(null);

  const step: Step = ALL_STEPS[index] ?? "welcome";
  const last = index === ALL_STEPS.length - 1;

  // Move focus to the flow on mount and on every step, so the keyboard lands
  // on the new screen rather than wherever the old Next button was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocusing is the point of depending on the step
  useEffect(() => {
    dialogRef.current?.focus();
  }, [step]);

  const next = () => setIndex((current) => Math.min(current + 1, ALL_STEPS.length - 1));
  const back = () => setIndex((current) => Math.max(current - 1, 0));

  const grantNotifications = async () => {
    setNotifications(await requestNotificationPermission());
  };

  const saveKey = async () => {
    const trimmed = key.trim();
    if (!KEY_PATTERN.test(trimmed)) {
      setKeyState("rejected");
      return;
    }
    await setSecret("tinfoil-api-key", trimmed);
    // Forced: a probe earlier this session may have cached "no key", which
    // would otherwise keep Tinfoil models out of the pickers until relaunch.
    const tinfoil = await import("@/lib/tinfoil");
    await tinfoil.configureTinfoilFromKeychain(true);
    setKeyState("saved");
  };

  // Probe when the Composio screen is reached, not on mount: it spawns a
  // process, and most of a first run never needs the answer.
  useEffect(() => {
    if (step !== "composio" || composio.kind !== "idle") {
      return;
    }
    setComposio({ kind: "checking" });
    void (async () => {
      const version = await composioCliVersion();
      if (version === null) {
        setComposio({ kind: "missing" });
        return;
      }
      // Installed *and* already signed in is a real state on a replayed run;
      // showing "Sign in" there would invite a pointless second login.
      setComposio({ kind: (await composioSignedIn()) ? "signedIn" : "installed" });
    })();
  }, [step, composio.kind]);

  const failure = (error: unknown, retry: "install" | "signIn") => ({
    kind: "failed" as const,
    retry,
    // The Rust side returns a sentence written for this screen; anything else
    // would be a bug, so it is shown rather than swallowed.
    message: error instanceof Error ? error.message : String(error),
  });

  const installCli = async () => {
    setComposio({ kind: "installing" });
    try {
      await installComposioCli();
      // Back to `idle` so the probe above re-runs: a machine that was signed
      // in before a reinstall should land on "Ready", not be asked to log in
      // a second time.
      setComposio({ kind: "idle" });
    } catch (error) {
      setComposio(failure(error, "install"));
    }
  };

  /**
   * Start the login, hand the URL to the real browser, then wait for it.
   *
   * Two calls rather than one because that is what makes this survivable from
   * a GUI: `--no-wait` returns a URL immediately, and only the second call
   * blocks. Doing it in one would mean holding a terminal open for ten
   * minutes with nothing on screen.
   */
  const signIn = async () => {
    setComposio({ kind: "opening" });
    try {
      const url = await startComposioLogin();
      await openExternal(url);
      setComposio({ kind: "waiting" });
      await pollComposioLogin();
      // Ask the disk rather than trusting the poll's answer: the CLI can save
      // credentials while the poll still reports false (it competes with any
      // other `--poll` for the same session), so the file is the only honest
      // source. Checked directly rather than by bouncing through `idle`, which
      // would re-run the probe and flash "Checking\u2026" over a finished login.
      setComposio((await composioSignedIn()) ? { kind: "signedIn" } : { kind: "installed" });
    } catch (error) {
      setComposio(failure(error, "signIn"));
    }
  };

  const trimmedQuery = query.trim().toLowerCase();
  const matchingPlugins = plugins.filter(
    (plugin) => trimmedQuery.length === 0 || plugin.name.toLowerCase().includes(trimmedQuery),
  );

  const renderStep = () => {
    switch (step) {
      case "welcome":
        return (
          <div className="onboarding-step onboarding-step-welcome">
            <div className="onboarding-wordmark">
              <BlobAvatar tone="blue" shape="sphere" size={64} />
              <h1 className="onboarding-title">Blobbies</h1>
            </div>
            <p className="onboarding-lede">
              A small crew of agents you can hand real work to, living entirely on this machine.
            </p>
            <button type="button" className="onboarding-start" onClick={next}>
              Get started
              <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        );

      case "blobs":
        return (
          <div className="onboarding-step onboarding-step-blobs">
            <h1 className="onboarding-heading">Every Blob gets one job</h1>
          </div>
        );

      case "permissions":
        return (
          <div className="onboarding-step">
            <h1 className="onboarding-heading">A few things to settle</h1>
            <div className="onboarding-card">
              <div className="onboarding-row">
                <span className="onboarding-row-text">
                  <span className="onboarding-row-title">Notifications</span>
                  <span className="onboarding-row-blurb">
                    So a Blob can reach you when its work lands, or when it is stuck waiting on an
                    answer.
                  </span>
                </span>
                {notifications === "idle" ? (
                  <button
                    type="button"
                    className="onboarding-allow"
                    onClick={() => void grantNotifications()}
                  >
                    Allow
                  </button>
                ) : (
                  <span className="onboarding-row-state" data-granted={notifications === "granted"}>
                    {notifications === "granted" ? (
                      <>
                        <Check size={13} strokeWidth={2.2} aria-hidden="true" />
                        Allowed
                      </>
                    ) : notifications === "denied" ? (
                      "Not allowed"
                    ) : (
                      "Unavailable"
                    )}
                  </span>
                )}
              </div>
              <div className="onboarding-divider" />
              <div className="onboarding-row">
                <span className="onboarding-row-text">
                  <span className="onboarding-row-title">Everything lives in one folder</span>
                  <span className="onboarding-row-blurb">
                    Blobs, chats and files sit in {DATA_ROOT_LABEL}, one folder each. Nothing
                    outside it can be read or written.
                  </span>
                </span>
              </div>
              <div className="onboarding-divider" />
              <div className="onboarding-row">
                <span className="onboarding-row-text">
                  <span className="onboarding-row-title">Where the thinking happens</span>
                  <span className="onboarding-row-blurb">
                    A model on this machine, by default. Turn on the private cloud and requests are
                    sealed before they leave, readable by nobody.
                  </span>
                </span>
              </div>
              <div className="onboarding-divider" />
              <div className="onboarding-row">
                <span className="onboarding-row-text">
                  <span className="onboarding-row-title">Links and Finder</span>
                  <span className="onboarding-row-blurb">
                    Blobbies can open a link in your browser and point Finder at a file it saved. It
                    runs nothing else for you.
                  </span>
                </span>
              </div>
            </div>
          </div>
        );

      case "tinfoil":
        return (
          <div className="onboarding-step">
            <h1 className="onboarding-heading">Want a bigger brain?</h1>
            <p className="onboarding-blurb">
              Tinfoil runs bigger models in sealed hardware. Encrypted to the chip, unreadable by
              them or us.
            </p>
            <div className="onboarding-key">
              <label className="onboarding-key-label" htmlFor="onboarding-tinfoil-key">
                API key
              </label>
              <div className="onboarding-key-row">
                <input
                  id="onboarding-tinfoil-key"
                  type="password"
                  className="creator-name"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste your key"
                  aria-invalid={keyState === "rejected"}
                  aria-describedby="onboarding-key-note"
                  value={key}
                  onChange={(event) => {
                    setKey(event.currentTarget.value);
                    setKeyState("idle");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void saveKey();
                    }
                  }}
                />
                <button
                  type="button"
                  className="onboarding-allow"
                  disabled={key.trim() === ""}
                  onClick={() => void saveKey()}
                >
                  Save
                </button>
              </div>
              {/* One live region for all three outcomes, so a screen reader
                  hears the result of a save it cannot see. */}
              <span
                className="onboarding-key-note"
                id="onboarding-key-note"
                data-state={keyState}
                role="status"
              >
                {keyState === "saved" ? (
                  <>
                    <Check size={13} strokeWidth={2.2} aria-hidden="true" />
                    Saved to your keychain. Pick a Tinfoil model in Settings to use it.
                  </>
                ) : keyState === "rejected" ? (
                  "That does not look like a key. Paste the whole thing, on its own."
                ) : (
                  <>
                    Kept in your OS keychain, never in app files. Keys live at{" "}
                    <button
                      type="button"
                      className="onboarding-key-link"
                      onClick={() => void openExternal(TINFOIL_KEYS_URL)}
                    >
                      tinfoil.sh
                    </button>
                    .
                  </>
                )}
              </span>
            </div>
          </div>
        );

      case "composio":
        return (
          <div className="onboarding-step">
            <h1 className="onboarding-heading">Hooking up your apps</h1>
            <p className="onboarding-blurb">
              Gmail, Calendar, Slack and the rest connect through Composio. One sign-in covers all
              of them.
            </p>
            <div className="onboarding-card">
              <div className="onboarding-row">
                <span className="onboarding-row-text">
                  <span className="onboarding-row-title">Composio</span>
                  <span className="onboarding-row-blurb" role="status">
                    {composio.kind === "idle" || composio.kind === "checking"
                      ? "Checking\u2026"
                      : composio.kind === "missing"
                        ? "Not installed yet."
                        : composio.kind === "installing"
                          ? "Installing\u2026 this takes a moment."
                          : composio.kind === "installed"
                            ? "Installed. Sign in to connect your apps."
                            : composio.kind === "opening"
                              ? "Opening your browser\u2026"
                              : composio.kind === "waiting"
                                ? "Waiting for you in the browser\u2026 blank page? Open again."
                                : composio.kind === "failed"
                                  ? composio.message
                                  : "Signed in. Your apps can connect now."}
                  </span>
                </span>
                {composio.kind === "signedIn" ? (
                  <span className="onboarding-row-state" data-granted={true}>
                    <Check size={13} strokeWidth={2.2} aria-hidden="true" />
                    Ready
                  </span>
                ) : composio.kind === "installed" ||
                  composio.kind === "waiting" ||
                  (composio.kind === "failed" && composio.retry === "signIn") ? (
                  <button
                    type="button"
                    className="onboarding-allow"
                    // Kept live while waiting: the poll runs for ten minutes,
                    // and a browser tab closed by accident must not leave the
                    // only way forward greyed out.
                    onClick={() => void signIn()}
                  >
                    {composio.kind === "waiting"
                      ? "Open again"
                      : composio.kind === "failed"
                        ? "Try again"
                        : "Sign in"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="onboarding-allow"
                    disabled={
                      composio.kind === "installing" ||
                      composio.kind === "checking" ||
                      composio.kind === "idle" ||
                      composio.kind === "opening"
                    }
                    onClick={() => void installCli()}
                  >
                    {composio.kind === "installing"
                      ? "Installing"
                      : composio.kind === "failed"
                        ? "Try again"
                        : "Install"}
                  </button>
                )}
              </div>
            </div>
          </div>
        );

      case "plugins":
        return (
          <div className="onboarding-step">
            <h1 className="onboarding-heading">What do you work in daily?</h1>
            <div className="onboarding-search">
              <Search size={13} strokeWidth={2} aria-hidden="true" className="search-glyph" />
              <input
                type="search"
                className="search-input"
                placeholder="Search"
                aria-label="Search plugins"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
            <div className="onboarding-plugins">
              {matchingPlugins.map((plugin) => {
                const added = installedPlugins.includes(plugin.id);
                return (
                  <button
                    type="button"
                    key={plugin.id}
                    className="onboarding-plugin"
                    aria-pressed={added}
                    onClick={() => onSetPluginInstalled(plugin.id, !added)}
                  >
                    <PluginTile plugin={plugin} size={30} />
                    <span className="onboarding-plugin-name">{plugin.name}</span>
                    {added ? (
                      <span className="onboarding-plugin-check" aria-hidden="true">
                        <Check size={12} strokeWidth={2.4} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {matchingPlugins.length === 0 ? (
                <p className="onboarding-blurb">No plugins match your search.</p>
              ) : null}
            </div>
          </div>
        );
    }
  };

  const compact = step !== "blobs";

  /** Next is not the way past a setup step; Skip is, and it is right there. */
  const needsKey =
    (step === "tinfoil" && keyState !== "saved") ||
    (step === "composio" && composio.kind !== "signedIn");

  return (
    <div
      ref={dialogRef}
      className="onboarding"
      role="dialog"
      aria-modal="true"
      // Fixed name: the per-step heading is the first thing inside, so the
      // dialog's own name should say which flow this is, not repeat the step.
      aria-label="Welcome to Blobbies"
      tabIndex={-1}
      data-tauri-drag-region
    >
      {step === "welcome" ? null : (
        <div className="onboarding-trio" data-compact={compact} aria-hidden={compact}>
          {TRIO.map((blob, index) => (
            <span
              key={blob.job}
              className="onboarding-trio-blob"
              style={
                {
                  // Uncompacted, position comes from the orbit: one shared
                  // anchor in CSS, spread by this phase offset.
                  "--phase": index,
                  ...(compact
                    ? { left: blob.compactX, top: blob.compactY, scale: blob.compactScale }
                    : {}),
                } as CSSProperties
              }
            >
              <BlobAvatar tone={blob.tone} shape={blob.shape} size={88} />
              <span className="onboarding-trio-label">{blob.job}</span>
            </span>
          ))}
        </div>
      )}

      {/* Scrolls when the content outgrows a short window; the actions below
          sit outside it, so Next and Back are reachable at any size. */}
      <div className="onboarding-body">{renderStep()}</div>

      {step === "welcome" ? null : (
        <div className="onboarding-actions">
          {/* The last Next hands over to the app's own creator, so it says so. */}
          <button
            type="button"
            className="onboarding-next"
            // On the key steps, Next means "I gave you a key" and Skip means
            // "I did not". Letting an empty Next through collapses the two
            // into one button, and the user who pressed it believes they
            // set something up — finding out later, at the first app that
            // will not connect. Skip stays one click away, so this is a
            // rename of the exit, not a wall.
            disabled={needsKey}
            onClick={last ? onDone : next}
          >
            {last ? "Make your first Blob" : "Next"}
          </button>
          <button type="button" className="onboarding-back" onClick={back}>
            Back
          </button>
          {/* The two key steps are the ones with something to decline, so they
              say so outright rather than leaving "Next with an empty field" to
              be inferred. Composio's wording names the cost of skipping: the
              next screen is a list of apps that cannot connect without it. */}
          {step === "tinfoil" && keyState !== "saved" ? (
            <button type="button" className="onboarding-skip" onClick={next}>
              Skip, I'll use the local model
            </button>
          ) : null}
          {step === "composio" && composio.kind !== "signedIn" ? (
            <button type="button" className="onboarding-skip" onClick={next}>
              Skip, I'll connect my apps later
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
