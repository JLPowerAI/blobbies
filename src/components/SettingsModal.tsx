import { CircleArrowDown, Cpu, Plug, Settings, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "@/components/ExternalLink";
import { PillSelect } from "@/components/PillSelect";
import {
  composioCliInstallable,
  composioCliVersion,
  composioSignedIn,
  installComposioCli,
  pollComposioLogin,
  startComposioLogin,
} from "@/lib/composio";
import {
  getOllamaVersion,
  isOllamaInstalled,
  listOllamaModels,
  type OllamaModel,
  startOllama,
} from "@/lib/ollama";
import { deleteSecret, setSecret } from "@/lib/secrets";
import { listSkills, type Skill } from "@/lib/skills";
import { openExternal } from "@/lib/tauri";
// Tinfoil's real module (attestation stack) is a lazy chunk: only the pure
// id helpers are imported statically; handlers `import()` the rest on use.
import type { TinfoilModel } from "@/lib/tinfoil";
import { isTinfoilModel, TINFOIL_MODEL_PREFIX } from "@/lib/tinfoil-model";
import { checkForUpdates, simulateUpdate, type UpdateState, useUpdateState } from "@/lib/updater";
import { useExitAnimation } from "@/lib/useExitAnimation";

export const MAX_USER_NAME_LENGTH = 32;

export type ThemePreference = "system" | "light" | "dark";

const APP_VERSION = "0.1.2";

/** The Updates tab status line under the version. One sentence per phase; the
 *  sidebar card carries the interactive part, this is the quiet summary. */
function updateBlurb(update: UpdateState): string {
  switch (update.phase) {
    case "checking":
      return "Checking GitHub Releases…";
    case "up-to-date":
      return `Up to date (checked ${new Date(update.checkedAt).toLocaleTimeString()})`;
    case "available":
      return `Blobbies ${update.version} is ready to download.`;
    case "downloading":
      return `Downloading ${update.version} — ${update.percent}%`;
    case "ready":
      return `${update.version} downloaded — see the sidebar to install and restart.`;
    case "installing":
      return `Installing ${update.version}…`;
    case "failed":
      return update.message;
    default:
      return "Updates arrive through GitHub Releases.";
  }
}

/** The dialog's tabs; also what the search palette can jump straight to. */
export type SettingsTab = "general" | "model" | "plugins" | "updates";

interface SettingsModalProps {
  /** Tab to open on, for callers that jump to one. Defaults to General. */
  initialTab?: SettingsTab;
  userName: string;
  onUserNameChange: (name: string) => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  timezone: string;
  onTimezoneChange: (timezone: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  /** Dev switch: replay the first-run flow on every launch. */
  forceOnboarding: boolean;
  onForceOnboardingChange: (on: boolean) => void;
  onClose: () => void;
}

/** What the Model tab knows about the local Ollama install right now. */
type OllamaStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "not-installed" }
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "start-failed" }
  | { kind: "running"; version: string; models: OllamaModel[] };

/** Status-dot tone per Ollama state. */
const OLLAMA_DOT_TONE: Record<OllamaStatus["kind"], "wait" | "err" | "warn" | "ok"> = {
  idle: "wait",
  checking: "wait",
  "not-installed": "err",
  stopped: "warn",
  starting: "wait",
  "start-failed": "err",
  running: "ok",
};

function ollamaBlurb(status: OllamaStatus): string {
  switch (status.kind) {
    case "idle":
    case "checking":
      return "Checking your local Ollama\u2026";
    case "not-installed":
      return "Not found on this machine. Blobbies runs models locally through Ollama, so nothing ever leaves your device.";
    case "stopped":
      return "Installed, but not running.";
    case "starting":
      return "Starting Ollama\u2026";
    case "start-failed":
      return "Couldn't start Ollama. Try opening the Ollama app yourself, then re-check.";
    case "running": {
      const count = status.models.length;
      return `Running v${status.version} \u00b7 ${count} ${count === 1 ? "model" : "models"} downloaded`;
    }
  }
}

function modelBlurb(status: OllamaStatus, tinfoilReady: boolean): string {
  if (status.kind === "running") {
    return status.models.length === 0
      ? "No models downloaded yet. Run `ollama pull gemma3`, then re-check."
      : "Your Blobs think with this model. Everything stays on your device.";
  }
  return tinfoilReady
    ? "Tinfoil models stay available while Ollama is off; local models return once it's running."
    : "Available once Ollama is installed and running.";
}

/** What the Model tab knows about the Tinfoil account right now. */
type TinfoilStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "configured"; models: TinfoilModel[] };

const TINFOIL_DOT_TONE: Record<TinfoilStatus["kind"], "wait" | "err" | "warn" | "ok"> = {
  idle: "wait",
  checking: "wait",
  none: "warn",
  configured: "ok",
};

function tinfoilBlurb(status: TinfoilStatus): string {
  switch (status.kind) {
    case "idle":
    case "checking":
      return "Checking for a saved Tinfoil key…";
    case "none":
      // Kept short so every state renders on one line: the row height must
      // not change when the save flips the status (and unmounts the link).
      return "Private cloud models in secure enclaves.";
    case "configured": {
      const count = status.models.length;
      return `API key saved · ${count} ${count === 1 ? "model" : "models"} available`;
    }
  }
}

/**
 * What the Plugins tab knows about Composio.
 *
 * Install and sign-in are tracked as one sequence rather than two flags: a
 * login is meaningless without the binary, and the pair would allow states
 * that cannot exist. `waiting` is the one that has to be visible — the
 * browser is open and this app is polling for up to ten minutes.
 */
type ComposioStatus = {
  stage:
    | "idle"
    | "checking"
    | "missing"
    | "installing"
    | "installed"
    | "opening"
    | "waiting"
    | "signedIn";
  version: string;
  /** Empty unless something failed; shown verbatim. */
  error: string;
  installable: boolean;
};

const COMPOSIO_IDLE: ComposioStatus = {
  stage: "idle",
  version: "",
  error: "",
  installable: true,
};

/** Status-dot tone for the Composio row. */
function composioTone(status: ComposioStatus): "wait" | "err" | "warn" | "ok" {
  if (status.stage === "missing" || status.error !== "") {
    return "err";
  }
  if (status.stage === "signedIn") {
    return "ok";
  }
  // Installed but signed out is a warning, not success: the difference between
  // "a binary exists" and "connecting an app will work".
  return status.stage === "installed" ? "warn" : "wait";
}

function composioBlurb(status: ComposioStatus): string {
  if (status.error !== "") {
    return status.error;
  }
  switch (status.stage) {
    case "idle":
    case "checking":
      return "Checking\u2026";
    case "installing":
      return "Installing\u2026 this takes a moment.";
    case "missing":
      // The WSL line stays specific: it is the one case where the user has to
      // do something elsewhere, so naming it saves a dead-end click.
      return status.installable
        ? "Not installed yet."
        : "Needs a POSIX shell. On Windows, install it inside WSL.";
    case "installed":
      return `Installed \u00b7 ${status.version}. Sign in to connect your apps.`;
    case "opening":
      return "Opening your browser\u2026";
    case "waiting":
      // Naming the blank page is the difference between retrying and giving
      // up: the link dies after ten minutes and an expired one renders empty
      // rather than saying so. "Open again" mints a fresh key (verified), so
      // it genuinely recovers rather than replaying a dead one.
      return "Waiting for you in the browser\u2026 blank page? Open again.";
    case "signedIn":
      return `Connected \u00b7 ${status.version}`;
  }
}

/**
 * Probe the CLI and whether it holds a login.
 *
 * The sign-in check is skipped when there is no binary to ask about, which is
 * the common case on a first open.
 */
async function probeComposio(
  setStatus: (update: (current: ComposioStatus) => ComposioStatus) => void,
): Promise<void> {
  setStatus((current) => ({ ...current, stage: "checking", error: "" }));
  const [version, installable] = await Promise.all([
    composioCliVersion(),
    composioCliInstallable(),
  ]);
  const signedIn = version !== null && (await composioSignedIn());
  setStatus((current) => ({
    ...current,
    stage: version === null ? "missing" : signedIn ? "signedIn" : "installed",
    version: version ?? "",
    installable,
  }));
}

/** Check the keychain for a Tinfoil key and load the model catalog. */
async function probeTinfoil(
  setStatus: (status: TinfoilStatus) => void,
  force = false,
): Promise<void> {
  setStatus({ kind: "checking" });
  const tinfoil = await import("@/lib/tinfoil");
  if (await tinfoil.configureTinfoilFromKeychain(force)) {
    setStatus({ kind: "configured", models: await tinfoil.listTinfoilModels() });
    return;
  }
  setStatus({ kind: "none" });
}

/** Probe the local Ollama install/server and report the result. */
async function probeOllama(setStatus: (status: OllamaStatus) => void): Promise<void> {
  setStatus({ kind: "checking" });
  const version = await getOllamaVersion();
  if (version !== null) {
    setStatus({ kind: "running", version, models: await listOllamaModels() });
    return;
  }
  setStatus((await isOllamaInstalled()) ? { kind: "stopped" } : { kind: "not-installed" });
}

/** Settings dialog: General (account, appearance, agent), Model, and Updates tabs. */
export function SettingsModal({
  initialTab = "general",
  userName,
  onUserNameChange,
  theme,
  onThemeChange,
  timezone,
  onTimezoneChange,
  model,
  onModelChange,
  forceOnboarding,
  onForceOnboardingChange,
  onClose,
}: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const update = useUpdateState();
  const [ollama, setOllama] = useState<OllamaStatus>({ kind: "idle" });
  const [tinfoil, setTinfoil] = useState<TinfoilStatus>({ kind: "idle" });
  const [tinfoilKeyDraft, setTinfoilKeyDraft] = useState("");
  const [composio, setComposio] = useState<ComposioStatus>(COMPOSIO_IDLE);
  const [skills, setSkills] = useState<Skill[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { closing, requestClose, finishClose } = useExitAnimation(onClose);

  // Probe lazily: only once the Model tab is first opened.
  useEffect(() => {
    if (tab === "model" && ollama.kind === "idle") {
      void probeOllama(setOllama);
    }
    if (tab === "model" && tinfoil.kind === "idle") {
      void probeTinfoil(setTinfoil);
    }
    if (tab === "plugins" && composio.stage === "idle") {
      void probeComposio(setComposio);
      // Read here rather than from App's copy: this tab is where a user looks
      // after adding a folder, so it should reflect the disk, not the list
      // captured at startup.
      void listSkills().then(setSkills);
    }
  }, [tab, ollama.kind, tinfoil.kind, composio.stage]);

  const availableModels = ollama.kind === "running" ? ollama.models : [];
  const tinfoilModels = tinfoil.kind === "configured" ? tinfoil.models : [];

  const saveTinfoilKey = async () => {
    const key = tinfoilKeyDraft.trim();
    if (key === "") {
      return;
    }
    await setSecret("tinfoil-api-key", key);
    setTinfoilKeyDraft("");
    // Force: the session probe may have cached "no key" before this save.
    await probeTinfoil(setTinfoil, true);
  };

  const installCli = async () => {
    setComposio((current) => ({ ...current, stage: "installing", error: "" }));
    try {
      await installComposioCli();
      // Re-probe rather than assume: a machine that was signed in before a
      // reinstall should land straight on "Connected".
      await probeComposio(setComposio);
    } catch (error) {
      setComposio((current) => ({
        ...current,
        stage: "missing",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  /**
   * Start the login, open the URL, then wait for the browser half.
   *
   * Split in two because `--no-wait` returns a URL immediately and only the
   * poll blocks; one blocking call would leave the tab frozen with nothing to
   * show for it.
   */
  const signIn = async () => {
    setComposio((current) => ({ ...current, stage: "opening", error: "" }));
    try {
      const url = await startComposioLogin();
      await openExternal(url);
      setComposio((current) => ({ ...current, stage: "waiting" }));
      await pollComposioLogin();
      // Re-probe instead of trusting the poll's own answer. The CLI can save
      // credentials while our poll returns false — it competes with any other
      // `--poll` for the same session — and disk is the source of truth the
      // rest of this tab already reads. Abandoning the browser tab is not an
      // error either; it just leaves the user on the button that starts again.
      await probeComposio(setComposio);
    } catch (error) {
      setComposio((current) => ({
        ...current,
        stage: "installed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const removeTinfoilKey = async () => {
    await deleteSecret("tinfoil-api-key");
    // Refresh the session probe so pickers stop offering Tinfoil models.
    // Awaited before the clear below: an in-flight probe must not land after.
    const tinfoil = await import("@/lib/tinfoil");
    await tinfoil.configureTinfoilFromKeychain(true);
    tinfoil.configureTinfoil({ apiKey: null });
    setTinfoil({ kind: "none" });
    // A selected Tinfoil model is unusable without the key: back to unset.
    if (isTinfoilModel(model)) {
      onModelChange("");
    }
  };

  const turnOnOllama = async () => {
    setOllama({ kind: "starting" });
    if (await startOllama()) {
      await probeOllama(setOllama);
      return;
    }
    setOllama({ kind: "start-failed" });
  };

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Built once per open; ~400 entries with their current local time.
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

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      requestClose();
    }
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
        // Wait for the backdrop's own fade-out, not bubbled child animations.
        if (closing && event.target === event.currentTarget) {
          finishClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={closing ? "settings-modal settings-modal-closing" : "settings-modal"}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <nav className="modal-rail" aria-label="Settings sections">
          <button
            type="button"
            className={tab === "general" ? "rail-item rail-item-active" : "rail-item"}
            aria-current={tab === "general" ? "true" : undefined}
            onClick={() => setTab("general")}
          >
            <Settings size={15} strokeWidth={1.8} aria-hidden="true" />
            General
          </button>
          <button
            type="button"
            className={tab === "model" ? "rail-item rail-item-active" : "rail-item"}
            aria-current={tab === "model" ? "true" : undefined}
            onClick={() => setTab("model")}
          >
            <Cpu size={15} strokeWidth={1.8} aria-hidden="true" />
            Model
          </button>
          <button
            type="button"
            className={tab === "plugins" ? "rail-item rail-item-active" : "rail-item"}
            aria-current={tab === "plugins" ? "true" : undefined}
            onClick={() => setTab("plugins")}
          >
            <Plug size={15} strokeWidth={1.8} aria-hidden="true" />
            Plugins
          </button>
          <button
            type="button"
            className={tab === "updates" ? "rail-item rail-item-active" : "rail-item"}
            aria-current={tab === "updates" ? "true" : undefined}
            onClick={() => setTab("updates")}
          >
            <CircleArrowDown size={15} strokeWidth={1.8} aria-hidden="true" />
            Updates
          </button>
        </nav>

        <div className="modal-content">
          <button
            type="button"
            className="icon-button modal-close"
            aria-label="Close settings"
            onClick={requestClose}
          >
            <X size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>

          {tab === "general" ? (
            <>
              <h2 className="modal-title">General</h2>

              <p className="modal-section-label">Account</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <label className="modal-row-title" htmlFor="account-name">
                      Name
                    </label>
                    <span className="modal-row-blurb">Your Blobs use this to address you.</span>
                  </span>
                  <span className="modal-name-wrap">
                    <input
                      id="account-name"
                      type="text"
                      className="modal-name-input"
                      maxLength={MAX_USER_NAME_LENGTH}
                      value={userName}
                      onChange={(event) => onUserNameChange(event.currentTarget.value)}
                    />
                    {userName.length >= MAX_USER_NAME_LENGTH - 6 ? (
                      <span className="modal-count" aria-live="polite">
                        {userName.length}/{MAX_USER_NAME_LENGTH}
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>

              <p className="modal-section-label">Appearance</p>
              <div className="modal-card">
                <div className="modal-row">
                  <span className="modal-row-label">Theme</span>
                  <PillSelect
                    id="theme-select"
                    label="Theme"
                    value={theme}
                    onChange={(value) => onThemeChange(value as ThemePreference)}
                  >
                    <option value="system">Follow System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </PillSelect>
                </div>
              </div>

              <p className="modal-section-label">Agent</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <label className="modal-row-title" htmlFor="timezone-select">
                      Timezone
                    </label>
                    <span className="modal-row-blurb">
                      Your Blobs schedule and time-stamp things in this timezone.
                    </span>
                  </span>
                  <PillSelect
                    id="timezone-select"
                    label="Timezone"
                    value={timezone}
                    onChange={onTimezoneChange}
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

              <p className="modal-section-label">Developer</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-title">Show onboarding</span>
                    <span className="modal-row-blurb">
                      Replay the first-run flow now and on every launch, even once it has been
                      completed.
                    </span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={forceOnboarding}
                    aria-label="Show onboarding"
                    className={forceOnboarding ? "toggle toggle-on" : "toggle"}
                    onClick={() => onForceOnboardingChange(!forceOnboarding)}
                  >
                    <span className="toggle-knob" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </>
          ) : null}

          {tab === "plugins" ? (
            <>
              <h2 className="modal-title">Plugins</h2>

              <p className="modal-section-label">Composio</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-title ollama-title">
                      <span
                        className={`ollama-dot ollama-dot-${composioTone(composio)}`}
                        aria-hidden="true"
                      />
                      Composio CLI
                    </span>
                    <span className="modal-row-blurb" aria-live="polite">
                      {composioBlurb(composio)}
                    </span>
                  </span>
                  {composio.stage === "missing" && composio.installable ? (
                    <button
                      type="button"
                      className="modal-button"
                      onClick={() => void installCli()}
                    >
                      {composio.error === "" ? "Install" : "Try again"}
                    </button>
                  ) : composio.stage === "installed" || composio.stage === "waiting" ? (
                    <button type="button" className="modal-button" onClick={() => void signIn()}>
                      {composio.stage === "waiting" ? "Open again" : "Sign in"}
                    </button>
                  ) : composio.stage === "signedIn" ? (
                    <button
                      type="button"
                      className="modal-button"
                      onClick={() => void probeComposio(setComposio)}
                    >
                      Re-check
                    </button>
                  ) : (
                    <button type="button" className="modal-button" disabled>
                      {composio.stage === "installing"
                        ? "Installing\u2026"
                        : composio.stage === "opening"
                          ? "Opening\u2026"
                          : "Checking\u2026"}
                    </button>
                  )}
                </div>
              </div>

              <p className="modal-section-label">Skills</p>
              <div className="modal-card">
                {skills.length === 0 ? (
                  <div className="modal-row modal-row-multiline">
                    <span className="modal-row-text">
                      <span className="modal-row-blurb">
                        No skills yet. Add one in <code>~/.blobbies/skills</code>.
                      </span>
                    </span>
                  </div>
                ) : (
                  skills.map((skill, position) => (
                    <Fragment key={skill.name}>
                      {position === 0 ? null : <div className="modal-divider" />}
                      {/* Name only: this list answers "what is installed",
                          while a description answers "when should the model
                          use this". Showing it here buys a wall of text or an
                          ellipsis — and an ellipsis is the truncation refused
                          everywhere else. It stays whole in the file. */}
                      <div className="modal-row">
                        <span className="modal-row-title">{skill.name}</span>
                      </div>
                    </Fragment>
                  ))
                )}
              </div>
            </>
          ) : null}

          {tab === "model" ? (
            <>
              <h2 className="modal-title">Model</h2>

              <p className="modal-section-label">Ollama</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-title ollama-title">
                      <span
                        className={`ollama-dot ollama-dot-${OLLAMA_DOT_TONE[ollama.kind]}`}
                        aria-hidden="true"
                      />
                      Ollama
                    </span>
                    <span className="modal-row-blurb" aria-live="polite">
                      {ollamaBlurb(ollama)}
                    </span>
                  </span>
                  {ollama.kind === "not-installed" ? (
                    <ExternalLink href="https://ollama.com/download" className="modal-button">
                      Get Ollama
                    </ExternalLink>
                  ) : ollama.kind === "stopped" ||
                    ollama.kind === "start-failed" ||
                    ollama.kind === "starting" ? (
                    <button
                      type="button"
                      className="modal-button"
                      disabled={ollama.kind === "starting"}
                      onClick={() => void turnOnOllama()}
                    >
                      {ollama.kind === "starting" ? "Starting\u2026" : "Turn On"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="modal-button"
                      disabled={ollama.kind !== "running"}
                      onClick={() => void probeOllama(setOllama)}
                    >
                      Re-check
                    </button>
                  )}
                </div>
              </div>

              <p className="modal-section-label">Tinfoil</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-title ollama-title">
                      <span
                        className={`ollama-dot ollama-dot-${TINFOIL_DOT_TONE[tinfoil.kind]}`}
                        aria-hidden="true"
                      />
                      Tinfoil
                    </span>
                    <span className="modal-row-blurb" aria-live="polite">
                      {tinfoilBlurb(tinfoil)}{" "}
                      {tinfoil.kind === "none" ? (
                        <ExternalLink href="https://docs.tinfoil.sh/get-api-key">
                          Get a key
                        </ExternalLink>
                      ) : null}
                    </span>
                  </span>
                </div>
                {/* The key section always renders — only its contents swap.
                    Unmounting it on save removed ~90px from the card and threw
                    every section below it up the page, which reads as the
                    dialog flinching at the moment the user succeeded. */}
                <div className="modal-divider" />
                <div className="modal-stack">
                  <span className="modal-row-title" id="tinfoil-key-label">
                    API key
                  </span>
                  <div className="modal-field-row">
                    {tinfoil.kind === "configured" ? (
                      <>
                        <span className="modal-name-input modal-name-input-static">
                          {"\u2022".repeat(24)}
                        </span>
                        <button
                          type="button"
                          className="modal-button"
                          onClick={() => void removeTinfoilKey()}
                        >
                          Remove Key
                        </button>
                      </>
                    ) : (
                      <>
                        <input
                          id="tinfoil-key"
                          type="password"
                          className="modal-name-input"
                          autoComplete="off"
                          aria-labelledby="tinfoil-key-label"
                          placeholder="Paste your API key"
                          value={tinfoilKeyDraft}
                          onChange={(event) => setTinfoilKeyDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              void saveTinfoilKey();
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="modal-button"
                          disabled={tinfoilKeyDraft.trim() === ""}
                          onClick={() => void saveTinfoilKey()}
                        >
                          Save
                        </button>
                      </>
                    )}
                  </div>
                  <span className="modal-row-blurb">
                    Stored in your OS keychain, never in app files.
                  </span>
                </div>
              </div>

              <p className="modal-section-label">Model</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <label className="modal-row-title" htmlFor="model-select">
                      Chat model
                    </label>
                    <span className="modal-row-blurb">
                      {modelBlurb(ollama, tinfoilModels.length > 0)}
                    </span>
                  </span>
                  <PillSelect
                    id="model-select"
                    label="Chat model"
                    value={model}
                    onChange={onModelChange}
                  >
                    <option value="">Choose a model</option>
                    {model !== "" &&
                    !isTinfoilModel(model) &&
                    !availableModels.some((entry) => entry.name === model) ? (
                      <option value={model}>{`${model} (not downloaded)`}</option>
                    ) : null}
                    {availableModels.length > 0 ? (
                      <optgroup label="Ollama — local">
                        {availableModels.map((entry) => (
                          <option key={entry.name} value={entry.name}>
                            {entry.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    {tinfoilModels.length > 0 ? (
                      <optgroup label="Tinfoil — private cloud">
                        {tinfoilModels.map((entry) => (
                          <option key={entry.id} value={`${TINFOIL_MODEL_PREFIX}${entry.id}`}>
                            {entry.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </PillSelect>
                </div>
              </div>
            </>
          ) : null}

          {tab === "updates" ? (
            <>
              <h2 className="modal-title">Updates</h2>

              <p className="modal-section-label">Updates</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-title">Blobbies {APP_VERSION}</span>
                    <span className="modal-row-blurb">{updateBlurb(update)}</span>
                  </span>
                  {import.meta.env.DEV ? (
                    <button
                      type="button"
                      className="modal-button"
                      onClick={() => void simulateUpdate()}
                    >
                      Simulate Update
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="modal-button"
                    disabled={
                      update.phase === "checking" ||
                      update.phase === "downloading" ||
                      update.phase === "installing"
                    }
                    onClick={() => void checkForUpdates()}
                  >
                    {update.phase === "checking" ? "Checking…" : "Check for Updates"}
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
