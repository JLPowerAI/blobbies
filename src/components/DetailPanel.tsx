import { ChevronsRight, Clock, FileText, Plus, Settings, Trash2, User, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Agent, Routine } from "@/data/agents";
import { type HomeEntry, homeFor } from "@/lib/home";
import { type BlobMemory, MEMORY_LIMIT, MEMORY_TEXT_LIMIT } from "@/lib/memory";

/** "12.4k", "380k", "1.2M" — a glance, not an invoice. */
function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  return count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : `${count}`;
}

interface DetailPanelProps {
  agent: Agent;
  routines: Routine[];
  /** Memories shared by every Blob; edited here, stored in the `user` slice. */
  userMemories: BlobMemory[];
  /** Tokens the last run spent, for the "this run" half of the usage line. */
  lastRunTokens?: number;
  /** Bumped whenever the folder may have changed (attachment saved, turn
      finished); re-lists the files without polling for writes. */
  filesKey?: number;
  onChangeMemories: (next: { blob?: BlobMemory[]; user?: BlobMemory[] }) => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onCreateRoutine: () => void;
  onOpenRoutine: (id: string) => void;
}

function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/** Characters of a file shown in the side-panel preview. */
const PREVIEW_CHARS = 4_000;

/**
 * The Blob's home folder: files its tools wrote during autonomous turns, and
 * the text pulled out of anything the user attached. Read-only viewer plus
 * delete — authoring happens through the Blob itself.
 */
function FilesSection({ blobId, filesKey }: { blobId: string; filesKey: number }) {
  const [entries, setEntries] = useState<HomeEntry[]>([]);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);

  const refresh = () => {
    homeFor(blobId)
      .list()
      .then(setEntries)
      .catch(() => setEntries([]));
  };
  // Refresh on Blob switch and whenever the app knows a write happened;
  // "live *while* a run writes" is still not worth polling.
  // biome-ignore lint/correctness/useExhaustiveDependencies(filesKey): the key is the signal, not a value refresh reads
  useEffect(refresh, [blobId, filesKey]);

  const openPreview = (name: string) => {
    homeFor(blobId)
      .read(name)
      .then((text) =>
        setPreview({
          name,
          // Capped because this renders into one <pre>: an OCR'd 20-page scan
          // is far longer than anyone reads in a side panel, and the point
          // here is checking what an extractor got, not reading the file.
          text:
            text.length > PREVIEW_CHARS
              ? `${text.slice(0, PREVIEW_CHARS)}\n\n[showing the first ${PREVIEW_CHARS.toLocaleString()} characters of ${text.length.toLocaleString()}]`
              : text,
        }),
      )
      .catch(() => setPreview({ name, text: "(not a readable text file)" }));
  };

  const remove = (name: string) => {
    homeFor(blobId)
      .remove(name)
      .then(() => {
        setPreview((current) => (current?.name === name ? null : current));
        refresh();
      })
      .catch(refresh);
  };

  if (entries.length === 0) {
    return null;
  }
  return (
    <section className="routines" aria-label="Files">
      <div className="routines-header">
        <h2 className="routines-title">Files</h2>
      </div>
      <ul className="routine-list">
        {entries.map((entry) => (
          <li key={entry.name} className="file-row-item">
            <button
              type="button"
              className="routine-row"
              // Without this the name reads as "seats.csv15 B": two spans with
              // no separator between them.
              aria-label={entry.isDir ? entry.name : `Open ${entry.name}`}
              disabled={entry.isDir}
              onClick={() => openPreview(entry.name)}
            >
              <span className="routine-glyph">
                <FileText size={16} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className="routine-text">
                <span className="routine-name">{entry.name}</span>
                <span className="routine-schedule">
                  {entry.isDir ? "folder" : fileSize(entry.size)}
                </span>
              </span>
            </button>
            {entry.isDir ? null : (
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete ${entry.name}`}
                onClick={() => remove(entry.name)}
              >
                <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {preview === null ? null : (
        <div className="file-preview">
          <div className="routines-header">
            <h3 className="routines-title">{preview.name}</h3>
            <button
              type="button"
              className="icon-button"
              aria-label="Close preview"
              onClick={() => setPreview(null)}
            >
              <ChevronsRight size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
          <pre className="file-preview-text">{preview.text}</pre>
        </div>
      )}
    </section>
  );
}

/** Sentinel edit target for the row that does not exist yet. */
const NEW_MEMORY = "new";

/**
 * What the Blob remembers, in both scopes.
 *
 * The Blob's own facts are numbered exactly as `renderMemories` numbers them
 * in the prompt, so "forget 2" in chat and row 2 here are the same fact.
 * Shared facts are unnumbered for the same reason: the model addresses only
 * one list by position. Promotion between scopes is manual — the intent
 * router still writes Blob scope only.
 */
function MemoriesSection({
  memories,
  userMemories,
  onChange,
}: {
  memories: BlobMemory[];
  userMemories: BlobMemory[];
  onChange: (next: { blob?: BlobMemory[]; user?: BlobMemory[] }) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /**
   * Live edit target, mirroring `editing`.
   *
   * Enter commits and unmounts the input, which can also fire `onBlur` — a
   * second commit whose closure still holds the old `editing` (React state
   * has not re-rendered yet), adding the same memory twice. Clearing this ref
   * inside `commit` makes the second call a no-op, and makes Escape actually
   * cancel instead of being undone by the blur behind it.
   */
  const target = useRef<string | null>(null);

  const startEdit = (id: string, text: string) => {
    target.current = id;
    setDraft(text);
    setEditing(id);
  };

  const cancel = () => {
    target.current = null;
    setEditing(null);
  };

  const rows = [
    ...memories.map((memory, index) => ({ memory, scope: "blob" as const, position: index + 1 })),
    ...userMemories.map((memory) => ({ memory, scope: "user" as const, position: 0 })),
  ];

  const listFor = (scope: "blob" | "user") => (scope === "blob" ? memories : userMemories);
  const patchFor = (scope: "blob" | "user", next: BlobMemory[]) =>
    scope === "blob" ? { blob: next } : { user: next };

  const commit = () => {
    const editedId = target.current;
    target.current = null;
    setEditing(null);
    if (editedId === null) {
      return;
    }
    // The store caps memory text too; cap here so the user sees what is kept.
    const text = draft.trim().slice(0, MEMORY_TEXT_LIMIT);
    if (editedId === NEW_MEMORY) {
      if (text !== "" && memories.length < MEMORY_LIMIT) {
        onChange({
          blob: [...memories, { id: crypto.randomUUID().slice(0, 8), text, createdAt: Date.now() }],
        });
      }
      return;
    }
    const row = rows.find((candidate) => candidate.memory.id === editedId);
    if (row === undefined) {
      return;
    }
    const list = listFor(row.scope);
    // Emptying the text deletes the fact: the alternative is a blank row that
    // costs prompt space and says nothing.
    onChange(
      patchFor(
        row.scope,
        text === ""
          ? list.filter((memory) => memory.id !== editedId)
          : list.map((memory) =>
              memory.id === editedId ? { ...memory, text, updatedAt: Date.now() } : memory,
            ),
      ),
    );
  };

  const remove = (id: string, scope: "blob" | "user") => {
    onChange(
      patchFor(
        scope,
        listFor(scope).filter((memory) => memory.id !== id),
      ),
    );
  };

  /** Move a fact between scopes, keeping its id and createdAt. */
  const moveScope = (memory: BlobMemory, from: "blob" | "user") => {
    const to = from === "blob" ? "user" : "blob";
    if (listFor(to).length >= MEMORY_LIMIT) {
      return;
    }
    onChange({
      ...patchFor(
        from,
        listFor(from).filter((candidate) => candidate.id !== memory.id),
      ),
      ...patchFor(to, [...listFor(to), memory]),
    });
  };

  const editor = (
    <input
      className="memory-input"
      value={draft}
      maxLength={MEMORY_TEXT_LIMIT}
      aria-label="Memory text"
      // biome-ignore lint/a11y/noAutofocus: the row was just clicked to edit it
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        } else if (event.key === "Escape") {
          cancel();
        }
      }}
    />
  );

  return (
    <section className="routines" aria-label="Memories">
      <div className="routines-header">
        <h2 className="routines-title">Memories</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Add memory"
          disabled={memories.length >= MEMORY_LIMIT}
          onClick={() => startEdit(NEW_MEMORY, "")}
        >
          <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      {rows.length === 0 && editing === null ? (
        <p className="routines-empty-text">
          Facts this Blob has learned about you show up here. You can add or edit them yourself.
        </p>
      ) : (
        <ul className="routine-list">
          {rows.map((row) => (
            <li key={row.memory.id} className="file-row-item">
              {editing === row.memory.id ? (
                editor
              ) : (
                <button
                  type="button"
                  className="routine-row"
                  onClick={() => startEdit(row.memory.id, row.memory.text)}
                >
                  <span className="routine-text">
                    <span className="routine-name">
                      {row.scope === "blob" ? `[${row.position}] ` : ""}
                      {row.memory.text}
                    </span>
                    <span className="routine-schedule">
                      {row.scope === "blob" ? "This Blob" : "All Blobs"}
                    </span>
                  </span>
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label={
                  row.scope === "blob" ? "Share with all Blobs" : "Keep to this Blob only"
                }
                disabled={listFor(row.scope === "blob" ? "user" : "blob").length >= MEMORY_LIMIT}
                onClick={() => moveScope(row.memory, row.scope)}
              >
                {row.scope === "blob" ? (
                  <Users size={15} strokeWidth={1.8} aria-hidden="true" />
                ) : (
                  <User size={15} strokeWidth={1.8} aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete memory: ${row.memory.text}`}
                onClick={() => remove(row.memory.id, row.scope)}
              >
                <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </li>
          ))}
          {editing === NEW_MEMORY ? <li className="file-row-item">{editor}</li> : null}
        </ul>
      )}
    </section>
  );
}

export function DetailPanel({
  agent,
  routines,
  userMemories,
  lastRunTokens,
  filesKey = 0,
  onChangeMemories,
  onClose,
  onOpenSettings,
  onCreateRoutine,
  onOpenRoutine,
}: DetailPanelProps) {
  const lifetime = (agent.usage?.inputTokens ?? 0) + (agent.usage?.outputTokens ?? 0);
  return (
    <aside className="detail-panel" aria-label={`${agent.name} details`}>
      <header className="detail-header" data-tauri-drag-region>
        <span className="detail-header-spacer" data-tauri-drag-region />
        <div className="detail-header-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Open settings"
            onClick={onOpenSettings}
          >
            <Settings size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close details"
            onClick={onClose}
          >
            <ChevronsRight size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="routines" aria-label="Routines">
        {routines.length === 0 ? (
          <div className="routines-empty">
            <p className="routines-empty-text">
              Routines are recurring tasks this agent runs on a schedule.
            </p>
            <button type="button" className="routine-create" onClick={onCreateRoutine}>
              Create Routine
            </button>
          </div>
        ) : (
          <>
            <div className="routines-header">
              <h2 className="routines-title">Routines</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Create Routine"
                onClick={onCreateRoutine}
              >
                <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
            <ul className="routine-list">
              {routines.map((routine) => (
                <li key={routine.id}>
                  <button
                    type="button"
                    className="routine-row"
                    onClick={() => onOpenRoutine(routine.id)}
                  >
                    <span
                      className={
                        routine.active ? "routine-glyph" : "routine-glyph routine-glyph-paused"
                      }
                    >
                      <Clock size={16} strokeWidth={1.8} aria-hidden="true" />
                    </span>
                    <span className="routine-text">
                      <span className="routine-name">
                        {routine.name.trim().length > 0 ? routine.name : "Untitled routine"}
                      </span>
                      <span className="routine-schedule">
                        {routine.active ? (routine.triggers[0] ?? "No trigger yet") : "Paused"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {lifetime > 0 ? (
        // Framed as why replies slow down, not as cost: local inference has
        // no bill, and the context window is what actually bites.
        <p className="detail-usage">
          {lastRunTokens !== undefined && lastRunTokens > 0
            ? `${formatTokens(lastRunTokens)} tokens this run · `
            : ""}
          {formatTokens(lifetime)} over {agent.usage?.runs ?? 0} runs
        </p>
      ) : null}

      <FilesSection blobId={agent.id} filesKey={filesKey} />

      <MemoriesSection
        memories={agent.memories ?? []}
        userMemories={userMemories}
        onChange={onChangeMemories}
      />
    </aside>
  );
}
