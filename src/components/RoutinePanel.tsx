import {
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  CircleDashed,
  Clock,
  GitBranch,
  Hash,
  MessagesSquare,
  Plus,
  Siren,
  TriangleAlert,
} from "lucide-react";
import { type ComponentType, useEffect, useRef, useState } from "react";
import type { Routine } from "@/data/agents";
import { useExitAnimation } from "@/lib/useExitAnimation";

interface RoutinePanelProps {
  routine: Routine;
  onUpdate: (patch: Partial<Routine>) => void;
  onDelete: () => void;
  /** Back to the routines list (info view). */
  onBack: () => void;
  onClose: () => void;
}

const SCHEDULE_OPTIONS = [
  "Every hour",
  "Every day",
  "Weekdays",
  "Every week",
  "Every month",
  "Interval",
  "Custom schedule",
] as const;

interface EventTrigger {
  label: string;
  icon: ComponentType<{
    size?: number | string;
    strokeWidth?: number | string;
    className?: string;
    "aria-hidden"?: boolean | "true" | "false";
  }>;
}

const EVENT_TRIGGERS: readonly EventTrigger[] = [
  { label: "Slack message", icon: Hash },
  { label: "Git event", icon: GitBranch },
  { label: "Teams message", icon: MessagesSquare },
  { label: "Linear issue", icon: CircleDashed },
  { label: "Sentry alert", icon: TriangleAlert },
  { label: "PagerDuty incident", icon: Siren },
];

/** Schedule triggers show a clock; event triggers show their service icon. */
function triggerIcon(label: string): EventTrigger["icon"] {
  return EVENT_TRIGGERS.find((candidate) => candidate.label === label)?.icon ?? Clock;
}

/** Per-routine editor: identity, triggers and run history. */
export function RoutinePanel({ routine, onUpdate, onDelete, onBack, onClose }: RoutinePanelProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { closing, requestClose, finishClose } = useExitAnimation(() => {
    setMenuOpen(false);
    setScheduleOpen(false);
  });

  // Close the trigger menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        requestClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        requestClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, requestClose]);

  const addTrigger = (label: string) => {
    if (!routine.triggers.includes(label)) {
      onUpdate({ triggers: [...routine.triggers, label] });
    }
    requestClose();
  };

  return (
    <aside className="detail-panel" aria-label="Routine">
      <header className="detail-header" data-tauri-drag-region>
        <button type="button" className="icon-button" aria-label="Back" onClick={onBack}>
          <ChevronLeft size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <h2 className="detail-title">Routine</h2>
        <button type="button" className="icon-button" aria-label="Close panel" onClick={onClose}>
          <ChevronsRight size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </header>

      <div className="settings-body">
        <div className="routine-toolbar">
          <label className="routine-active">
            <button
              type="button"
              role="switch"
              aria-checked={routine.active}
              aria-label="Active"
              className={routine.active ? "toggle toggle-on" : "toggle"}
              onClick={() => onUpdate({ active: !routine.active })}
            >
              <span className="toggle-knob" aria-hidden="true" />
            </button>
            Active
          </label>
          <div className="routine-toolbar-actions">
            <button type="button" className="modal-button" onClick={onDelete}>
              Delete
            </button>
            <button
              type="button"
              className="modal-button"
              disabled={routine.name.trim().length === 0}
            >
              Test run
            </button>
          </div>
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="routine-name">
            Name
          </label>
          <input
            id="routine-name"
            type="text"
            className="settings-input"
            placeholder="Name this routine"
            value={routine.name}
            onChange={(event) => onUpdate({ name: event.currentTarget.value })}
          />
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="routine-instruction">
            Instruction
          </label>
          <textarea
            id="routine-instruction"
            className="settings-input settings-textarea"
            placeholder="What should this routine do each time it runs?"
            rows={3}
            value={routine.instruction}
            onChange={(event) => onUpdate({ instruction: event.currentTarget.value })}
          />
        </div>

        <div className="settings-field">
          <span className="settings-label">When to run</span>
          <div className="trigger-card">
            {routine.triggers.map((trigger) => {
              const Icon = triggerIcon(trigger);
              return (
                <div key={trigger} className="trigger-row">
                  <Icon size={15} strokeWidth={1.8} aria-hidden="true" className="trigger-glyph" />
                  {trigger}
                </div>
              );
            })}
            <div className="trigger-add-area" ref={menuRef}>
              <button
                type="button"
                className="trigger-add"
                aria-expanded={menuOpen}
                onClick={() => {
                  if (menuOpen) {
                    requestClose();
                  } else {
                    setMenuOpen(true);
                    setScheduleOpen(false);
                  }
                }}
              >
                <Plus size={15} strokeWidth={2} aria-hidden="true" />
                {routine.triggers.length > 0 ? "Add another" : "Add trigger"}
              </button>
              {menuOpen ? (
                <div
                  className={closing ? "trigger-menu trigger-menu-closing" : "trigger-menu"}
                  role="menu"
                  aria-label="Trigger options"
                  onAnimationEnd={(event) => {
                    if (closing && event.target === event.currentTarget) {
                      finishClose();
                    }
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="account-menu-item"
                    aria-expanded={scheduleOpen}
                    onClick={() => setScheduleOpen((open) => !open)}
                  >
                    <Clock size={15} strokeWidth={1.8} aria-hidden="true" />
                    On a schedule
                    <ChevronRight
                      size={14}
                      strokeWidth={1.8}
                      aria-hidden="true"
                      className="trigger-submenu-chevron"
                    />
                  </button>
                  {scheduleOpen
                    ? SCHEDULE_OPTIONS.map((option) => (
                        <button
                          type="button"
                          role="menuitem"
                          key={option}
                          className="account-menu-item trigger-schedule-item"
                          onClick={() => addTrigger(option)}
                        >
                          {option}
                        </button>
                      ))
                    : EVENT_TRIGGERS.map(({ label, icon: Icon }) => (
                        <button
                          type="button"
                          role="menuitem"
                          key={label}
                          className="account-menu-item"
                          onClick={() => addTrigger(label)}
                        >
                          <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
                          {label}
                        </button>
                      ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="settings-field">
          <span className="settings-label">Run history</span>
          <p className="routine-empty-note">No runs yet</p>
        </div>
      </div>
    </aside>
  );
}
