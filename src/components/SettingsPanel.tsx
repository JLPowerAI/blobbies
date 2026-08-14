import { ChevronLeft, ChevronsRight } from "lucide-react";
import { BlobAvatar } from "@/components/BlobAvatar";
import { type Agent, MAX_BLOB_NAME_LENGTH } from "@/data/agents";

interface SettingsPanelProps {
  agent: Agent;
  onUpdate: (patch: Partial<Agent>) => void;
  /** Back to the info (screen + routines) view. */
  onBack: () => void;
  onClose: () => void;
}

/** Per-Blob settings: identity fields and notification preference. */
export function SettingsPanel({ agent, onUpdate, onBack, onClose }: SettingsPanelProps) {
  const notifications = agent.notifications ?? true;
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
            className="settings-input settings-textarea"
            placeholder="What this agent is for"
            rows={4}
            value={agent.description ?? ""}
            onChange={(event) => onUpdate({ description: event.currentTarget.value })}
          />
        </div>

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
