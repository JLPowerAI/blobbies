import { type FormEvent, useState } from "react";
import { AvatarPicker } from "@/components/AvatarPicker";
import { BlobAvatar } from "@/components/BlobAvatar";
import { type AgentShape, type AvatarTone, MAX_BLOB_NAME_LENGTH, MAX_BLOBS } from "@/data/agents";

interface CreatorPaneProps {
  initialName: string;
  /** Roster is full: the form explains why, instead of failing silently. */
  atCapacity?: boolean;
  onCreate: (name: string, tone: AvatarTone, shape: AgentShape) => void;
}

interface Suggestion {
  name: string;
  blurb: string;
  tone: AvatarTone;
  shape: AgentShape;
}

const SUGGESTIONS: readonly Suggestion[] = [
  {
    name: "Social Blob",
    blurb: "Drafts posts and keeps your accounts buzzing",
    tone: "pink",
    shape: "cloud",
  },
  {
    name: "Writer Blob",
    blurb: "Turns your rough notes into polished writing",
    tone: "blue",
    shape: "droplet",
  },
  {
    name: "To-Do Blob",
    blurb: "Tracks your tasks and nudges you at the right time",
    tone: "green",
    shape: "squircle",
  },
];

/**
 * Blob creator: avatar tone/shape picker, name field and starter suggestions.
 * Shown as the first-run screen and when adding another Blob.
 */
export function CreatorPane({ initialName, atCapacity = false, onCreate }: CreatorPaneProps) {
  const [name, setName] = useState(initialName.slice(0, MAX_BLOB_NAME_LENGTH));
  const [tone, setTone] = useState<AvatarTone>("blue");
  const [shape, setShape] = useState<AgentShape>("sphere");

  const trimmed = name.trim();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (trimmed.length === 0 || atCapacity) {
      return;
    }
    onCreate(trimmed, tone, shape);
  };

  const applySuggestion = (suggestion: Suggestion) => {
    setName(suggestion.name);
    setTone(suggestion.tone);
    setShape(suggestion.shape);
  };

  return (
    <section className="creator-pane" aria-label="New Blob">
      <header className="chat-header" data-tauri-drag-region>
        <div className="chat-header-identity" data-tauri-drag-region>
          <BlobAvatar tone={tone} shape={shape} size={24} />
          <h1 className="chat-title" data-tauri-drag-region>
            New Blob
          </h1>
        </div>
      </header>

      <form className="creator-body" onSubmit={submit}>
        {/* Re-keying pops the preview when the look changes. */}
        <div key={`${tone}-${shape}`} className="creator-preview">
          <BlobAvatar tone={tone} shape={shape} size={64} />
        </div>

        <AvatarPicker
          tone={tone}
          shape={shape}
          group="creator"
          onChange={(patch) => {
            if ("tone" in patch) {
              setTone(patch.tone);
            } else {
              setShape(patch.shape);
            }
          }}
        />

        <div className="creator-field">
          <label className="creator-label" htmlFor="creator-name">
            Name
          </label>
          <input
            id="creator-name"
            type="text"
            className="creator-name"
            maxLength={MAX_BLOB_NAME_LENGTH}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          {name.length >= MAX_BLOB_NAME_LENGTH - 4 ? (
            <span className="creator-count" aria-live="polite">
              {name.length}/{MAX_BLOB_NAME_LENGTH}
            </span>
          ) : null}
        </div>

        <button
          type="submit"
          className="creator-submit"
          disabled={trimmed.length === 0 || atCapacity}
        >
          Get started
        </button>
        {atCapacity ? (
          <p className="creator-hint">
            You have the maximum of {MAX_BLOBS} Blobs. Delete one to make room.
          </p>
        ) : null}
      </form>

      <section className="creator-suggestions" aria-label="Suggestions">
        {/* Inner wrapper enables the animated grid-rows collapse. */}
        <div className="suggestions-inner">
          <h2 className="suggestions-title">Suggestions</h2>
          <div className="suggestion-cards">
            {SUGGESTIONS.map((suggestion) => (
              <button
                type="button"
                key={suggestion.name}
                className="suggestion-card"
                onClick={() => applySuggestion(suggestion)}
              >
                <BlobAvatar tone={suggestion.tone} shape={suggestion.shape} size={40} />
                <span className="suggestion-text">
                  <span className="suggestion-name">{suggestion.name}</span>
                  <span className="suggestion-blurb">{suggestion.blurb}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </section>
  );
}
