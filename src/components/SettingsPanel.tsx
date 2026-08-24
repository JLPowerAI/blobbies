import { ChevronLeft, ChevronsRight } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { AvatarField } from "@/components/AvatarPicker";
import { MemoriesModal } from "@/components/MemoriesModal";
import { SystemPromptModal } from "@/components/SystemPromptModal";
import { type Agent, MAX_BLOB_NAME_LENGTH } from "@/data/agents";
import type { McpServerConfig } from "@/lib/mcp";
import type { BlobMemory } from "@/lib/memory";
import { blobSystemPrompt, type UserContext } from "@/lib/prompt";
import { exportBlob } from "@/lib/store";

interface SettingsPanelProps {
  agent: Agent;
  /** Name + timezone from app settings; completes the prompt preview. */
  user: UserContext;
  /**
   * `commitName` marks the end of a rename — the app settles name uniqueness
   * only then, so it never fights a half-typed name.
   */
  onUpdate: (patch: Partial<Agent> & { commitName?: boolean }) => void;
  /** Shared memories, so the prompt preview matches what a turn actually sends. */
  userMemories: BlobMemory[];
  /** Writes from the Memories dialog; both scopes, same shape as the panel's. */
  onChangeMemories: (next: { blob?: BlobMemory[]; user?: BlobMemory[] }) => void;
  /** App-wide local MCP servers (not per-Blob); named in the prompt preview. */
  mcpServers: McpServerConfig[];
  /** Back to the info (screen + routines) view. */
  onBack: () => void;
  onClose: () => void;
}

/** Per-Blob settings: identity fields and notification preference. */
export function SettingsPanel({
  agent,
  user,
  onUpdate,
  userMemories,
  onChangeMemories,
  mcpServers,
  onBack,
  onClose,
}: SettingsPanelProps) {
  const notifications = agent.notifications ?? true;
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  // Tagged with the Blob it describes: this panel is not remounted when the
  // selection changes, so a bare string would keep claiming "Saved …" about a
  // Blob the user has already navigated away from.
  const [exported, setExported] = useState<{ id: string; text: string } | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [memoriesOpen, setMemoriesOpen] = useState(false);

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
          <AvatarField tone={agent.tone} shape={agent.shape} group="settings" onChange={onUpdate} />
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-name">
            Name
          </label>
          {/* Typing is never fought: the field updates on every keystroke and
              uniqueness is settled on blur. Enforcing per keystroke fights the
              user — “Scout Two” becomes “Scout 2” the moment it passes an
              existing “Scout”, and a trailing space is stripped before the
              second word can be typed. */}
          <input
            id="settings-name"
            type="text"
            className="settings-input"
            maxLength={MAX_BLOB_NAME_LENGTH}
            value={agent.name}
            onChange={(event) => onUpdate({ name: event.currentTarget.value })}
            onBlur={() => onUpdate({ name: agent.name, commitName: true })}
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

        <div className="settings-field">
          <button type="button" className="settings-button" onClick={() => setPromptOpen(true)}>
            System prompt
          </button>
        </div>

        <div className="settings-field">
          {/* The count is the point: it answers "does it remember me?" without
              opening anything, and both scopes reach the prompt so both are
              counted. */}
          <button type="button" className="settings-button" onClick={() => setMemoriesOpen(true)}>
            Memories ({(agent.memories?.length ?? 0) + userMemories.length})
          </button>
        </div>

        <div className="settings-field">
          <button
            type="button"
            className="settings-button"
            onClick={() => {
              const id = agent.id;
              const say = (text: string) => setExported({ id, text });
              say("Exporting…");
              exportBlob(id, agent.name)
                .then((path) =>
                  say(path === null ? "Export needs the desktop app." : `Saved ${path}`),
                )
                .catch(() => say("Could not write the export."));
            }}
          >
            Export Blob
          </button>
          {/* Empty until something happens: a permanent blurb under a
              self-explanatory button is noise, but an export that silently
              failed is a file the user goes looking for and never finds.
              Always mounted, because a live region has to be in the DOM
              before its text changes for a screen reader to announce it. */}
          <span className="settings-hint" aria-live="polite">
            {exported?.id === agent.id ? exported.text : ""}
          </span>
        </div>

        {/* Last, and the only switch here: the buttons above all open or write
            something, so a setting that just sits on belongs after them rather
            than splitting them in two. */}
        <div className="settings-card">
          <span className="settings-card-title">Notifications</span>
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

      {promptOpen ? (
        <SystemPromptModal
          blobName={agent.name}
          // The real prompt minus the saved facts: the memory sections are
          // omitted entirely (redactMemories) because the Memories dialog lists
          // them — two screens of the same facts is two places to keep in sync.
          prompt={blobSystemPrompt(agent, user, {
            userMemories,
            mcpServers: mcpServers.filter((server) => server.enabled).map((server) => server.name),
            redactMemories: true,
          })}
          onClose={() => setPromptOpen(false)}
        />
      ) : null}

      {memoriesOpen ? (
        <MemoriesModal
          blobName={agent.name}
          memories={agent.memories ?? []}
          userMemories={userMemories}
          onChange={onChangeMemories}
          onClose={() => setMemoriesOpen(false)}
        />
      ) : null}
    </aside>
  );
}
