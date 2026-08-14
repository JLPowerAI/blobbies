import { ChevronDown, CircleArrowDown, Settings, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
  onClose: () => void;
}

function PillSelect({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <span className="pill-select">
      <select
        id={id}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {children}
      </select>
      <ChevronDown size={14} strokeWidth={2} aria-hidden="true" className="pill-select-chevron" />
    </span>
  );
}

/** Settings dialog: General (account, appearance, agent) and Updates tabs. */
export function SettingsModal({
  userName,
  onUserNameChange,
  theme,
  onThemeChange,
  timezone,
  onTimezoneChange,
  onClose,
}: SettingsModalProps) {
  const [tab, setTab] = useState<"general" | "updates">("general");
  const [updateStatus, setUpdateStatus] = useState("You're up to date");
  const [track, setTrack] = useState("stable");
  const dialogRef = useRef<HTMLDivElement>(null);
  const { closing, requestClose, finishClose } = useExitAnimation(onClose);

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
          ) : (
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
          )}
        </div>
      </div>
    </div>
  );
}
