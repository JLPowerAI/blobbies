import { ChevronsRight, Clock, Plus, Settings } from "lucide-react";
import type { Agent, Routine } from "@/data/agents";

interface DetailPanelProps {
  agent: Agent;
  routines: Routine[];
  onClose: () => void;
  onOpenSettings: () => void;
  onCreateRoutine: () => void;
  onOpenRoutine: (id: string) => void;
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

      {/* Live screen placeholder: intentionally blank until capture exists. */}
      <div className="screen-frame screen-frame-blank" aria-hidden="true" />
      <p className="screen-caption">{agent.name}'s screen</p>

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
    </aside>
  );
}
