import { ChevronsRight, Clock, FileText, Plus, Settings, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Agent, Routine } from "@/data/agents";
import { type HomeEntry, homeFor } from "@/lib/home";

interface DetailPanelProps {
  agent: Agent;
  routines: Routine[];
  onClose: () => void;
  onOpenSettings: () => void;
  onCreateRoutine: () => void;
  onOpenRoutine: (id: string) => void;
}

function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * The Blob's home folder: files its tools wrote during autonomous turns.
 * Read-only viewer plus delete — authoring happens through the Blob itself.
 */
function FilesSection({ blobId }: { blobId: string }) {
  const [entries, setEntries] = useState<HomeEntry[]>([]);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);

  const refresh = () => {
    homeFor(blobId)
      .list()
      .then(setEntries)
      .catch(() => setEntries([]));
  };
  // Refresh on Blob switch; "live while a run writes" is not worth polling.
  useEffect(refresh, [blobId]);

  const openPreview = (name: string) => {
    homeFor(blobId)
      .read(name)
      .then((text) => setPreview({ name, text: text.slice(0, 4_000) }))
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

export function DetailPanel({
  agent,
  routines,
  onClose,
  onOpenSettings,
  onCreateRoutine,
  onOpenRoutine,
}: DetailPanelProps) {
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

      <FilesSection blobId={agent.id} />
    </aside>
  );
}
