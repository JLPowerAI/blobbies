import { CircleArrowDown, Cpu, Settings, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "@/components/ExternalLink";
import { PillSelect } from "@/components/PillSelect";
import {
  getOllamaVersion,
  isOllamaInstalled,
  listOllamaModels,
  type OllamaModel,
  startOllama,
} from "@/lib/ollama";
import { useExitAnimation } from "@/lib/useExitAnimation";

export const MAX_USER_NAME_LENGTH = 32;

export type ThemePreference = "system" | "light" | "dark";

const APP_VERSION = "0.1.0";

interface SettingsModalProps {
  userName: string;
  onUserNameChange: (name: string) => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  timezone: string;
  onTimezoneChange: (timezone: string) => void;
  model: string;
  onModelChange: (model: string) => void;
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

function modelBlurb(status: OllamaStatus): string {
  if (status.kind === "running") {
    return status.models.length === 0
      ? "No models downloaded yet. Run `ollama pull gemma3`, then re-check."
      : "Your Blobs think with this model. Everything stays on your device.";
  }
  return "Available once Ollama is installed and running.";
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
  userName,
  onUserNameChange,
  theme,
  onThemeChange,
  timezone,
  onTimezoneChange,
  model,
  onModelChange,
  onClose,
}: SettingsModalProps) {
  const [tab, setTab] = useState<"general" | "model" | "updates">("general");
  const [updateStatus, setUpdateStatus] = useState("You're up to date");
  const [track, setTrack] = useState("stable");
  const [ollama, setOllama] = useState<OllamaStatus>({ kind: "idle" });
  const dialogRef = useRef<HTMLDivElement>(null);
  const { closing, requestClose, finishClose } = useExitAnimation(onClose);

  // Probe lazily: only once the Model tab is first opened.
  useEffect(() => {
    if (tab === "model" && ollama.kind === "idle") {
      void probeOllama(setOllama);
    }
  }, [tab, ollama.kind]);

  const availableModels = ollama.kind === "running" ? ollama.models : [];

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

              <p className="modal-section-label">Model</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <label className="modal-row-title" htmlFor="model-select">
                      Chat model
                    </label>
                    <span className="modal-row-blurb">{modelBlurb(ollama)}</span>
                  </span>
                  <PillSelect
                    id="model-select"
                    label="Chat model"
                    value={model}
                    onChange={onModelChange}
                  >
                    <option value="">Choose a model</option>
                    {model !== "" && !availableModels.some((entry) => entry.name === model) ? (
                      <option value={model}>{`${model} (not downloaded)`}</option>
                    ) : null}
                    {availableModels.map((entry) => (
                      <option key={entry.name} value={entry.name}>
                        {entry.name}
                      </option>
                    ))}
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
                    <span className="modal-row-title">Update Track</span>
                    <span className="modal-row-blurb">
                      Stable is the safe default. Other tracks ship new builds earlier and more
                      often.
                    </span>
                  </span>
                  <PillSelect
                    id="track-select"
                    label="Update track"
                    value={track}
                    onChange={setTrack}
                  >
                    <option value="stable">Stable</option>
                    <option value="beta">Beta</option>
                  </PillSelect>
                </div>
                <div className="modal-divider" />
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-title">Blobbies {APP_VERSION}</span>
                    <span className="modal-row-blurb">
                      Updates follow the {track === "stable" ? "Stable" : "Beta"} track
                      <br />
                      {updateStatus}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="modal-button"
                    onClick={() => setUpdateStatus("You're up to date")}
                  >
                    Check for Updates
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
