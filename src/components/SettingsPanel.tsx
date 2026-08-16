import { ChevronLeft, ChevronsRight } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { BlobAvatar } from "@/components/BlobAvatar";
import { type Agent, MAX_BLOB_NAME_LENGTH } from "@/data/agents";
import { blobSystemPrompt, type UserContext } from "@/lib/ai";

interface SettingsPanelProps {
  agent: Agent;
  /** Name + timezone from app settings; completes the prompt preview. */
  user: UserContext;
  /** Where the selected model runs; keeps the preview's identity line honest. */
  runtime: "local" | "enclave";
  onUpdate: (patch: Partial<Agent>) => void;
  /** Back to the info (screen + routines) view. */
  onBack: () => void;
  onClose: () => void;
}

/** Per-Blob settings: identity fields and notification preference. */
export function SettingsPanel({
  agent,
  user,
  runtime,
  onUpdate,
  onBack,
  onClose,
}: SettingsPanelProps) {
  const notifications = agent.notifications ?? true;
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the description so long text is fully visible, never clipped.
  // Re-runs on description change: the Blob can rewrite its own description
  // via configure_blob while this panel is open.
  // biome-ignore lint/correctness/useExhaustiveDependencies(agent.description): height tracks the value, not the effect body
  useLayoutEffect(() => {
    const el = descriptionRef.current;
    if (el !== null) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [agent.description]);
  return (
    <aside className="detail-panel" aria-label={`${agent.name} settings`}>
      <header className="detail-header" data-tauri-drag-region>
        <button type="button" className="icon-button" aria-label="Back" onClick={onBack}>
          <ChevronLeft size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <h2 className="detail-title">Settings</h2>
        <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}>
          <ChevronsRight size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </header>

      <div className="settings-body">
        <div className="settings-avatar">
          <BlobAvatar tone={agent.tone} shape={agent.shape} size={56} />
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-name">
            Name
          </label>
          <input
            id="settings-name"
            type="text"
            className="settings-input"
            maxLength={MAX_BLOB_NAME_LENGTH}
            value={agent.name}
            onChange={(event) => onUpdate({ name: event.currentTarget.value })}
          />
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-title">
            Title
          </label>
          <input
            id="settings-title"
            type="text"
            className="settings-input"
            placeholder="Describe what your agent does"
            value={agent.title ?? ""}
            onChange={(event) => onUpdate({ title: event.currentTarget.value })}
          />
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-description">
            Description
          </label>
          <textarea
            id="settings-description"
            ref={descriptionRef}
            className="settings-input settings-textarea"
            placeholder="What this agent is for"
            rows={4}
            value={agent.description ?? ""}
            onChange={(event) => {
              onUpdate({ description: event.currentTarget.value });
              // Keep height tracking the content while typing.
              event.currentTarget.style.height = "auto";
              event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
            }}
          />
        </div>

        <details className="settings-field prompt-preview">
          <summary className="settings-label prompt-preview-summary">System prompt</summary>
          <pre className="prompt-preview-body">{blobSystemPrompt(agent, user, { runtime })}</pre>
        </details>

        <div className="settings-card">
          <span className="settings-card-text">
            <span className="settings-card-title">Notifications</span>
            <span className="settings-card-blurb">
              Get notified when this agent finishes or needs input
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={notifications}
            aria-label="Notifications"
            className={notifications ? "toggle toggle-on" : "toggle"}
            onClick={() => onUpdate({ notifications: !notifications })}
          >
            <span className="toggle-knob" aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  );
}
