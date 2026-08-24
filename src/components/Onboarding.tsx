import { ArrowRight, Check } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { BlobAvatar } from "@/components/BlobAvatar";
import { OnboardingMemes } from "@/components/OnboardingMemes";
import { PillSelect } from "@/components/PillSelect";
import { MAX_USER_NAME_LENGTH } from "@/components/SettingsModal";
import type { AgentShape, AvatarTone } from "@/data/agents";
import { COMPOSIO_DASHBOARD_URL, composioSignedIn, forgetComposioSession } from "@/lib/composio";
import { composioLogIn, OauthError } from "@/lib/composio-oauth";
import { requestNotificationPermission } from "@/lib/notify";
import { getSecret, setSecret } from "@/lib/secrets";
import { openExternal } from "@/lib/tauri";

/**
 * Steps in order; the index is the whole flow state.
 *
 * Making the first Blob is deliberately *not* a step: the flow ends by
 * handing over to the app's own creator (`CreatorPane`), which already owns
 * name uniqueness, the roster cap and the store write. A second creator here
 * would be a copy of that screen drifting away from it.
 */
/**
 * The flow's screens.
 *
 * Picking plugins is deliberately not among them: a grid of twenty app tiles
 * asks which tools you want before you have a Blob to use them, and the
 * Plugins modal owns that list anyway. Composio stays — it is one sign-in that
 * later covers every app, so it is setup rather than a shopping list.
 */
const ALL_STEPS = [
  "welcome",
  "blobs",
  "name",
  "timezone",
  "permissions",
  "tinfoil",
  "composio",
] as const;

type Step = (typeof ALL_STEPS)[number];

/**
 * The three Blobs that travel through the flow: the content of the "one job"
 * step, where they fade in spread across the middle, then decoration drifting
 * around the window once that step passes.
 *
 * Each one says what it does, in its own voice — "Inbox Triage" is a job
 * title, and a job title tells you nothing about what the thing will actually
 * do for you. One sentence, present tense, concrete enough to picture.
 *
 * The compact positions are deliberately uneven — different insets, heights
 * and scales — because three evenly spaced marks at one size read as a
 * progress indicator. They are percentages of the trio box in CSS, and they
 * start each Blob inside the side margins, clear of both the content column
 * and the meme corners; the drift keyframes keep them there.
 */
const TRIO = [
  {
    job: "I handle your inbox and flag the emails that actually matter",
    tone: "red",
    shape: "droplet",
    compactX: "11%",
    compactY: "40%",
    compactScale: 0.34,
  },
  {
    job: "I scan YouTube for the next video you should make",
    tone: "teal",
    shape: "cloud",
    compactX: "6%",
    compactY: "62%",
    compactScale: 0.26,
  },
  {
    job: "I watch your deals and tell you which ones are going cold",
    tone: "blue",
    shape: "squircle",
    compactX: "91%",
    compactY: "47%",
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

type PermissionState = "idle" | "granted" | "denied" | "unavailable" | "translocated";

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

/** The author's channels, linked from the welcome screen's byline. */
const YOUTUBE_URL = "https://www.youtube.com/@kenkaidoesai";
const SKOOL_URL = "https://www.skool.com/kenkai";

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
/**
 * Composio is reached over its hosted MCP endpoint, so setup is one key
 * rather than an installer plus a browser login. The CLI this replaced had no
 * Windows build at all, which made the old install step impossible to finish
 * on a supported platform.
 */
type ComposioState =
  | { kind: "idle" }
  | { kind: "checking" }
  /** Not connected yet. One button: log in. */
  | { kind: "signedOut" }
  | { kind: "verifying" }
  | { kind: "signedIn" }
  /**
   * Sign-in failed, so the key field is offered as the way through.
   *
   * A fallback, and only shown once it is needed: a key is what the transport
   * reaches for when there is no OAuth token (see composio-mcp credential()),
   * and showing both up front read as "log in, THEN fetch a key, THEN paste
   * it" — three chores for what is one button.
   */
  | { kind: "failed"; message: string };

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
  /** Flow is over: mark it done and open the app's Blob creator. */
  onDone: () => void;
  /** Current display name, offered as the starting point of the name step. */
  userName: string;
  onUserNameChange: (name: string) => void;
  /** Current timezone preference ("auto" until chosen). */
  timezone: string;
  onTimezoneChange: (timezone: string) => void;
}

/**
 * First-run flow: welcome, what a Blob is, name and timezone, permissions,
 * Tinfoil and Composio, ending on the app's Blob creator. Rendered over the
 * app shell, so nothing behind it is reachable until it finishes; `onDone` is
 * the only way out (plus the dev Replay button in Settings, which re-opens it
 * on demand).
 */
export function Onboarding({
  onDone,
  userName,
  onUserNameChange,
  timezone,
  onTimezoneChange,
}: OnboardingProps) {
  const [index, setIndex] = useState(0);
  const [notifications, setNotifications] = useState<PermissionState>("idle");
  const [key, setKey] = useState("");
  const [keyState, setKeyState] = useState<KeyState>("idle");
  const [composio, setComposio] = useState<ComposioState>({ kind: "idle" });
  const [composioKey, setComposioKey] = useState("");
  // Local to the flow; committed through the parent only when the step is
  // left via Next, so Back and Skip leave the stored values untouched.
  const [nameInput, setNameInput] = useState(userName);
  const [timezoneChoice, setTimezoneChoice] = useState(timezone);
  const dialogRef = useRef<HTMLDivElement>(null);

  const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Built once per flow; ~400 entries with their current local time.
  const zones = useMemo(() => {
    const names =
      typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    const now = new Date();
    return names.map((zone) => {
      let time = "";
      try {
        time = new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: zone,
        }).format(now);
      } catch {
        // Skip the time preview for zones the runtime can't format.
      }
      return { zone, time };
    });
  }, []);

  const step: Step = ALL_STEPS[index] ?? "welcome";
  const last = index === ALL_STEPS.length - 1;

  // Move focus to the flow on mount and on every step, so the keyboard lands
  // on the new screen rather than wherever the old Next button was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocusing is the point of depending on the step
  useEffect(() => {
    dialogRef.current?.focus();
  }, [step]);

  const next = () => {
    // Leaving a profile step through Next is the commit point; Back and
    // Skip leave the stored preference alone.
    if (step === "name" && nameInput.trim() !== "") {
      onUserNameChange(nameInput.trim());
    }
    if (step === "timezone") {
      onTimezoneChange(timezoneChoice);
    }
    setIndex((current) => Math.min(current + 1, ALL_STEPS.length - 1));
  };
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

  // A key saved in an earlier run (Settings, or a previous onboarding) should
  // greet the user as done, not as a blank field asking for it again. Probed
  // once per flow: after the first keystroke the user's own edit is the
  // truth, and the keychain answer would only fight it.
  const keyProbeDone = useRef(false);
  useEffect(() => {
    if (step !== "tinfoil" || keyProbeDone.current) {
      return;
    }
    keyProbeDone.current = true;
    void (async () => {
      const existing = await getSecret("tinfoil-api-key");
      if (existing !== null && KEY_PATTERN.test(existing.trim())) {
        setKeyState("saved");
      }
    })();
  }, [step]);

  // Probe when the Composio screen is reached, not on mount: it is a network
  // round trip, and most of a first run never needs the answer.
  useEffect(() => {
    if (step !== "composio" || composio.kind !== "idle") {
      return;
    }
    setComposio({ kind: "checking" });
    void (async () => {
      // Already keyed is a real state on a replayed run; asking again there
      // would invite a pointless second paste.
      setComposio({ kind: (await composioSignedIn()) ? "signedIn" : "signedOut" });
    })();
  }, [step, composio.kind]);

  /**
   * Store the key, then prove it works before calling it done.
   *
   * Saving alone would show "Ready" for a mistyped key and fail later inside
   * a Blob's turn, where the person cannot see why. One handshake here moves
   * that error to the screen that can fix it.
   */
  /** Browser sign-in, which is the path most people should take. */
  const logInComposio = async () => {
    setComposio({ kind: "verifying" });
    try {
      await composioLogIn(openExternal);
      forgetComposioSession();
      setComposio(
        (await composioSignedIn())
          ? { kind: "signedIn" }
          : // Came back from the browser without a working session: say so,
            // which is also what reveals the key fallback.
            { kind: "failed", message: "That did not connect. Paste a key instead?" },
      );
    } catch (error) {
      // Our own OauthError messages are written for this screen ("Session
      // expired\u2026"); anything else is a stack-shaped string from a failed
      // invoke, which tells the user nothing they can act on. Both end in the
      // same place \u2014 the key field below \u2014 so unknown failures say that
      // instead of leaking "Cannot read properties of undefined".
      const known = error instanceof OauthError ? error.message : null;
      setComposio({
        kind: "failed",
        message: known ?? "Sign-in did not work here. Paste a key instead?",
      });
    }
  };

  const saveComposioKey = async () => {
    const key = composioKey.trim();
    if (!KEY_PATTERN.test(key)) {
      setComposio({ kind: "failed", message: "That does not look like a Composio key." });
      return;
    }
    setComposio({ kind: "verifying" });
    try {
      await setSecret("composio-api-key", key);
      forgetComposioSession();
      if (await composioSignedIn()) {
        setComposioKey("");
        setComposio({ kind: "signedIn" });
      } else {
        setComposio({ kind: "failed", message: "Composio did not accept that key." });
      }
    } catch (error) {
      setComposio({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

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
              Because we shouldn't be handing our sensitive data to AI providers. F*ck that.
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

      case "name":
        return (
          <div className="onboarding-step">
            <h1 className="onboarding-heading">Who are your Blobs working for?</h1>
            <p className="onboarding-blurb">
              They use your name to know who they are talking to. You can change it any time in
              Settings.
            </p>
            <div className="onboarding-key">
              <label className="onboarding-key-label" htmlFor="onboarding-name">
                Your name
              </label>
              <input
                id="onboarding-name"
                type="text"
                className="creator-name"
                autoComplete="off"
                spellCheck={false}
                placeholder="Type your name"
                maxLength={MAX_USER_NAME_LENGTH}
                value={nameInput}
                onChange={(event) => setNameInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    next();
                  }
                }}
              />
            </div>
          </div>
        );

      case "timezone":
        return (
          <div className="onboarding-step">
            <h1 className="onboarding-heading">What time is it for you?</h1>
            <p className="onboarding-blurb">
              Blobs schedule routines and time-stamp their work in your timezone.
            </p>
            <div className="onboarding-key">
              <label className="onboarding-key-label" htmlFor="onboarding-timezone">
                Timezone
              </label>
              <PillSelect
                id="onboarding-timezone"
                label="Timezone"
                value={timezoneChoice}
                onChange={setTimezoneChoice}
              >
                <option value="auto">{`Auto-detect (${detectedZone})`}</option>
                {zones.map(({ zone, time }) => (
                  <option key={zone} value={zone}>
                    {time.length > 0 ? `${zone}  ${time}` : zone}
                  </option>
                ))}
              </PillSelect>
            </div>
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
                    So a Blob can reach you when work lands or it needs an answer.
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
                    ) : notifications === "translocated" ? (
                      // Not the user's doing: they clicked Allow and macOS
                      // threw the grant away with the temporary copy.
                      "Move to Applications first"
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
                    Blobs, chats and files sit in {DATA_ROOT_LABEL}, one folder each.
                  </span>
                </span>
              </div>
              <div className="onboarding-divider" />
              <div className="onboarding-row">
                <span className="onboarding-row-text">
                  <span className="onboarding-row-title">Where the thinking happens</span>
                  <span className="onboarding-row-blurb">
                    A model on this machine, by default. Private cloud is a switch away.
                  </span>
                </span>
              </div>
              <div className="onboarding-divider" />
              <div className="onboarding-row">
                <span className="onboarding-row-text">
                  <span className="onboarding-row-title">Links and files</span>
                  <span className="onboarding-row-blurb">
                    Opens links, shows files in Finder, reads files in its folder.
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
              Gmail, Calendar, Slack and the rest connect through Composio. Log in once and every
              app is one click away.
            </p>
            <div className="onboarding-card">
              <div className="onboarding-row">
                <span className="onboarding-row-text">
                  <span className="onboarding-row-title">Composio</span>
                  <span className="onboarding-row-blurb" role="status">
                    {composio.kind === "idle" || composio.kind === "checking"
                      ? "Checking\u2026"
                      : composio.kind === "verifying"
                        ? "Waiting for Composio\u2026"
                        : composio.kind === "failed"
                          ? composio.message
                          : composio.kind === "signedIn"
                            ? "Connected. Your apps can connect now."
                            : "Log in to connect your apps."}
                  </span>
                </span>
                {/* Action on the right of its own row, like Allow on the
                    permissions step — and in the exact spot the Ready state
                    takes over once connected, so nothing jumps. */}
                {composio.kind === "signedIn" ? (
                  <span className="onboarding-row-state" data-granted={true}>
                    <Check size={13} strokeWidth={2.2} aria-hidden="true" />
                    Ready
                  </span>
                ) : (
                  <button
                    type="button"
                    className="onboarding-allow"
                    disabled={composio.kind === "verifying"}
                    onClick={() => void logInComposio()}
                  >
                    {composio.kind === "verifying"
                      ? "Working\u2026"
                      : composio.kind === "failed"
                        ? "Try again"
                        : "Log in"}
                  </button>
                )}
              </div>
              {/* The key is the fallback for when the browser sign-in cannot
                  work — SSO that refuses a loopback redirect, a locked-down
                  machine — so it appears only once sign-in has actually
                  failed. Shown alongside the button from the start, it read as
                  "log in, then fetch a key, then paste it": three chores for
                  what is one click.

                  Divided from the row above like the permissions card divides
                  its rows: this is a second way in, not a second step of the
                  first one. */}
              {composio.kind !== "failed" ? null : <div className="onboarding-divider" />}
              {composio.kind !== "failed" ? null : (
                <div className="onboarding-key-row">
                  <input
                    // The same field style the Tinfoil step uses; a key row is
                    // a key row, and this one had a class with no CSS behind
                    // it, so it rendered as a raw browser input.
                    className="creator-name"
                    type="password"
                    value={composioKey}
                    placeholder="ck_…"
                    aria-label="Composio API key"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setComposioKey(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveComposioKey();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="onboarding-allow"
                    disabled={composioKey.trim() === ""}
                    onClick={() => void saveComposioKey()}
                  >
                    Connect
                  </button>
                </div>
              )}
              {composio.kind !== "failed" ? null : (
                <button
                  type="button"
                  className="onboarding-link"
                  onClick={() => void openExternal(COMPOSIO_DASHBOARD_URL)}
                >
                  Get a key from Composio
                </button>
              )}
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
      {/* Four corners on the welcome screen, one on every step after it: the
          later steps are asking for something, and a single card beside the
          question is flair rather than competition.

          Keyed by step so every screen deals its own card in its own corner —
          without it the rotation timer alone decides, and a step passed
          through quickly inherits whatever the last one left behind.

          Sits outside `.onboarding-body` because that scrolls and clips: the
          corners belong to the window, not to the content column. */}
      <OnboardingMemes key={step} count={step === "welcome" ? 4 : 1} />

      {/* Always mounted so it can fade in and out: the welcome screen hides
          it, every other step shows it, and the opacity transition below is
          the whole in/out animation. */}
      <div
        className="onboarding-trio"
        data-compact={compact}
        data-hidden={step === "welcome"}
        aria-hidden={compact}
      >
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
            {/* The bob animation lives on this inner wrapper so it composes
                with (rather than fights) the orbit transform on the outer
                span. */}
            <span className="onboarding-trio-avatar">
              <BlobAvatar tone={blob.tone} shape={blob.shape} size={88} />
            </span>
            <span className="onboarding-trio-label">{blob.job}</span>
          </span>
        ))}
      </div>

      {/* Scrolls when the content outgrows a short window; the actions below
          sit outside it, so Next and Back are reachable at any size. */}
      <div className="onboarding-body">{renderStep()}</div>

      {/* Pinned to the bottom of the window rather than trailing the button:
          a signature belongs at the foot of the page, and out of the flow it
          cannot push the Get started button off-centre.

          Buttons, not anchors: a webview follows an href in place, which would
          replace the app with a web page and no way back. Same reason every
          other link in this flow is a button. */}
      {step === "welcome" ? (
        <p className="onboarding-byline">
          By Ken Kai · YouTube{" "}
          <button
            type="button"
            className="onboarding-byline-link"
            onClick={() => void openExternal(YOUTUBE_URL)}
          >
            @kenkaidoesai
          </button>{" "}
          · Learn with me{" "}
          <button
            type="button"
            className="onboarding-byline-link"
            onClick={() => void openExternal(SKOOL_URL)}
          >
            skool.com/kenkai
          </button>
        </p>
      ) : null}

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
          {/* The two setup steps are the ones with something to decline, so
              they say so outright rather than leaving "Next with an empty
              field" to be inferred. */}
          {step === "tinfoil" && keyState !== "saved" ? (
            <button type="button" className="onboarding-skip" onClick={next}>
              Skip, I'll use the local model
            </button>
          ) : null}
          {/* Composio is the last step, where `next` clamps and would do
              nothing — declining here has to finish the flow, or Skip is a
              dead button on the one screen that most needs it. */}
          {step === "composio" && composio.kind !== "signedIn" ? (
            <button type="button" className="onboarding-skip" onClick={last ? onDone : next}>
              Skip, I'll connect my apps later
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
