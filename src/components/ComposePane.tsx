import { Plus, Users } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { BlobAvatar } from "@/components/BlobAvatar";
import type { Agent } from "@/data/agents";

interface ComposePaneProps {
  agents: Agent[];
  onOpen: (agentId: string) => void;
  onCreate: (name: string) => void;
  /** Start a group chat; Blobs join it by being dragged in. */
  onCreateGroup: (name: string) => void;
  onCancel: () => void;
}

/**
 * "New" compose view: a To: field with a command palette listing "Create new
 * Blob", "New group chat", and existing Blobs filtered by the query. Enter
 * opens the highlighted row, ⌘1–9 jump straight to a row, Escape dismisses.
 *
 * Both creation paths live here, which is why the sidebar list has no "new
 * group" button of its own: one door for anything new.
 */
export function ComposePane({
  agents,
  onOpen,
  onCreate,
  onCreateGroup,
  onCancel,
}: ComposePaneProps) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);

  const trimmed = query.trim();
  const matches = agents.filter((agent) =>
    agent.name.toLowerCase().includes(trimmed.toLowerCase()),
  );
  // Options 0 and 1 are the two creation rows; existing Blobs follow.
  const CREATE_ROWS = 2;
  const optionCount = CREATE_ROWS + matches.length;
  const clampedHighlight = Math.min(highlighted, optionCount - 1);

  const activate = (index: number) => {
    if (index === 0) {
      onCreate(trimmed);
      return;
    }
    if (index === 1) {
      onCreateGroup(trimmed);
      return;
    }
    const match = matches[index - CREATE_ROWS];
    if (match !== undefined) {
      onOpen(match.id);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      onCancel();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate(clampedHighlight);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((clampedHighlight + 1) % optionCount);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((clampedHighlight - 1 + optionCount) % optionCount);
      return;
    }
    // ⌘1–9 jumps directly to a row.
    if (event.metaKey && event.key >= "1" && event.key <= "9") {
      const index = Number(event.key) - 1;
      if (index < optionCount) {
        event.preventDefault();
        activate(index);
      }
    }
  };

  return (
    <section className="compose-pane" aria-label="New chat">
      <header className="compose-header" data-tauri-drag-region>
        <label className="compose-to">
          <span className="compose-to-label">To:</span>
          <input
            // Compose exists to type a name; focusing it is the whole point.
            // biome-ignore lint/a11y/noAutofocus: single-purpose entry field
            autoFocus
            type="text"
            className="compose-input"
            placeholder="Search or create Blobs"
            aria-label="Search or create Blobs"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setHighlighted(0);
            }}
            onKeyDown={onKeyDown}
          />
        </label>
      </header>

      <div className="compose-palette">
        <ul className="compose-options">
          <li>
            <button
              type="button"
              className={
                clampedHighlight === 0 ? "compose-option compose-option-active" : "compose-option"
              }
              onClick={() => activate(0)}
              onMouseEnter={() => setHighlighted(0)}
            >
              <span className="compose-create-glyph" aria-hidden="true">
                <Plus size={15} strokeWidth={2} />
              </span>
              <span className="compose-option-name">
                {trimmed.length > 0 ? `Create new Blob "${trimmed}"` : "Create new Blob"}
              </span>
              <span className="compose-kbd-group" aria-hidden="true">
                <kbd className="compose-kbd">⌘</kbd>
                <kbd className="compose-kbd">1</kbd>
              </span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={
                clampedHighlight === 1 ? "compose-option compose-option-active" : "compose-option"
              }
              onClick={() => activate(1)}
              onMouseEnter={() => setHighlighted(1)}
            >
              <span className="compose-create-glyph" aria-hidden="true">
                <Users size={15} strokeWidth={2} />
              </span>
              <span className="compose-option-name">
                {trimmed.length > 0 ? `New group chat "${trimmed}"` : "New group chat"}
              </span>
              <span className="compose-kbd-group" aria-hidden="true">
                <kbd className="compose-kbd">⌘</kbd>
                <kbd className="compose-kbd">2</kbd>
              </span>
            </button>
          </li>
          {matches.map((agent, index) => {
            const optionIndex = index + CREATE_ROWS;
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  className={
                    clampedHighlight === optionIndex
                      ? "compose-option compose-option-active"
                      : "compose-option"
                  }
                  onClick={() => activate(optionIndex)}
                  onMouseEnter={() => setHighlighted(optionIndex)}
                >
                  <BlobAvatar tone={agent.tone} shape={agent.shape} size={24} />
                  <span className="compose-option-name">{agent.name}</span>
                  {optionIndex < 9 ? (
                    <span className="compose-kbd-group" aria-hidden="true">
                      <kbd className="compose-kbd">⌘</kbd>
                      <kbd className="compose-kbd">{optionIndex + 1}</kbd>
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="compose-footer" aria-hidden="true">
          <kbd className="compose-kbd">⏎</kbd>
          <span>open</span>
          <kbd className="compose-kbd">esc</kbd>
          <span>dismiss</span>
        </div>
      </div>
    </section>
  );
}
