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
import {
  coerceSchedule,
  describeSchedule,
  type RoutineSchedule,
  WEEKDAY_NAMES,
} from "@/lib/schedule";
import { useExitAnimation } from "@/lib/useExitAnimation";

interface RoutinePanelProps {
  routine: Routine;
  onUpdate: (patch: Partial<Routine>) => void;
  onDelete: () => void;
  /** Run the routine now, through the same path as a scheduled fire. */
  onTestRun: () => void;
  /** Back to the routines list (info view). */
  onBack: () => void;
  onClose: () => void;
}

/**
 * Preset schedule choices. Each maps to a real `RoutineSchedule` — picking
 * one arms the scheduler; the label also lands in `triggers` for display.
 */
const SCHEDULE_OPTIONS: ReadonlyArray<{ label: string; schedule: RoutineSchedule }> = [
  { label: "Every hour", schedule: { kind: "interval", minutes: 60 } },
  { label: "Every day", schedule: { kind: "daily", hour: 9, minute: 0 } },
  { label: "Every week", schedule: { kind: "weekly", weekday: 1, hour: 9, minute: 0 } },
  { label: "Every 30 minutes", schedule: { kind: "interval", minutes: 30 } },
];

/** Hour-of-day options, 0–23, shown 24-hour to match describeSchedule. */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

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
export function RoutinePanel({
  routine,
  onUpdate,
  onDelete,
  onTestRun,
  onBack,
  onClose,
}: RoutinePanelProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // Custom-schedule editor state, shown in place of the preset list. Prefilled
  // from the current schedule so tweaking a time starts from it, not from 9am.
  const [customOpen, setCustomOpen] = useState(false);
  const [customKind, setCustomKind] = useState<"interval" | "once" | "daily" | "weekly">("daily");
  const [customMinutes, setCustomMinutes] = useState("60");
  // Optional run count for a bounded interval ("every minute, 5 times");
  // empty string = unbounded.
  const [customCount, setCustomCount] = useState("");
  const [customHour, setCustomHour] = useState("9");
  const [customMinute, setCustomMinute] = useState("0");
  const [customWeekday, setCustomWeekday] = useState("1");
  const [customError, setCustomError] = useState("");
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

  /** A schedule replaces any previous one — one clock per routine. */
  const setSchedule = (label: string, schedule: RoutineSchedule) => {
    // Any earlier schedule's label goes too, not just the presets': switching
    // "Every day at 15:30" → "Every hour" must swap labels, not stack them.
    const stale = new Set([
      ...SCHEDULE_OPTIONS.map((option) => option.label),
      ...(routine.schedule === undefined ? [] : [describeSchedule(routine.schedule)]),
    ]);
    onUpdate({
      schedule,
      triggers: [...routine.triggers.filter((t) => !stale.has(t)), label],
    });
    requestClose();
  };

  /** Open the custom editor, prefilled from whatever schedule exists. */
  const openCustom = () => {
    const current = routine.schedule;
    if (current?.kind === "interval" || current?.kind === "once") {
      setCustomKind(current.kind);
      setCustomMinutes(String(current.minutes));
      setCustomCount(
        current.kind === "interval" && current.count !== undefined ? String(current.count) : "",
      );
    } else if (current?.kind === "daily") {
      setCustomKind("daily");
      setCustomHour(String(current.hour));
      setCustomMinute(String(current.minute));
    } else if (current?.kind === "weekly") {
      setCustomKind("weekly");
      setCustomWeekday(String(current.weekday));
      setCustomHour(String(current.hour));
      setCustomMinute(String(current.minute));
    }
    setCustomError("");
    setCustomOpen(true);
  };

  /** Build the schedule from the editor fields; null shows why it failed. */
  const applyCustom = () => {
    const bounded = customKind === "interval" && customCount.trim() !== "";
    const schedule = coerceSchedule(
      customKind === "interval" || customKind === "once"
        ? {
            kind: customKind,
            minutes: Number(customMinutes),
            ...(bounded ? { count: Number(customCount) } : {}),
          }
        : customKind === "daily"
          ? { kind: customKind, hour: Number(customHour), minute: Number(customMinute) }
          : {
              kind: customKind,
              weekday: Number(customWeekday),
              hour: Number(customHour),
              minute: Number(customMinute),
            },
    );
    if (schedule === null) {
      setCustomError(
        customKind === "once"
          ? "Minutes must be 1–1440."
          : bounded
            ? "Minutes must be 1–1440, times 1–50."
            : "Minutes must be 5–1440.",
      );
      return;
    }
    setSchedule(describeSchedule(schedule), schedule);
    setCustomOpen(false);
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
              disabled={routine.instruction.trim().length === 0}
              onClick={onTestRun}
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
                    // Reopening starts at the top level, not wherever the last
                    // visit ended — stale editor fields read as someone else's.
                    setCustomOpen(false);
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
                  {scheduleOpen ? (
                    customOpen ? (
                      <div className="trigger-custom">
                        <select
                          aria-label="Repeat"
                          className="trigger-custom-select"
                          value={customKind}
                          onChange={(event) =>
                            setCustomKind(
                              event.currentTarget.value as "interval" | "once" | "daily" | "weekly",
                            )
                          }
                        >
                          <option value="interval">Every N minutes</option>
                          <option value="once">Once, in N minutes</option>
                          <option value="daily">Every day</option>
                          <option value="weekly">Every week</option>
                        </select>
                        {customKind === "interval" || customKind === "once" ? (
                          <>
                            <label className="trigger-custom-field">
                              Minutes
                              <input
                                type="number"
                                aria-label="Minutes"
                                className="trigger-custom-input"
                                min={customKind === "interval" && customCount.trim() !== "" ? 1 : 5}
                                max={1440}
                                value={customMinutes}
                                onChange={(event) => setCustomMinutes(event.currentTarget.value)}
                              />
                            </label>
                            {customKind === "interval" ? (
                              <label className="trigger-custom-field">
                                Times
                                <input
                                  type="number"
                                  aria-label="Times"
                                  className="trigger-custom-input"
                                  min={1}
                                  max={50}
                                  placeholder="∞"
                                  value={customCount}
                                  onChange={(event) => setCustomCount(event.currentTarget.value)}
                                />
                              </label>
                            ) : null}
                          </>
                        ) : (
                          <>
                            {customKind === "weekly" ? (
                              <select
                                aria-label="Weekday"
                                className="trigger-custom-select"
                                value={customWeekday}
                                onChange={(event) => setCustomWeekday(event.currentTarget.value)}
                              >
                                {WEEKDAY_NAMES.map((name, index) => (
                                  <option key={name} value={String(index)}>
                                    {name}
                                  </option>
                                ))}
                              </select>
                            ) : null}
                            <select
                              aria-label="Hour"
                              className="trigger-custom-select"
                              value={customHour}
                              onChange={(event) => setCustomHour(event.currentTarget.value)}
                            >
                              {HOURS.map((hour) => (
                                <option key={`hour-${hour}`} value={String(hour)}>
                                  {String(hour).padStart(2, "0")}
                                </option>
                              ))}
                            </select>
                            <select
                              aria-label="Minute"
                              className="trigger-custom-select"
                              value={customMinute}
                              onChange={(event) => setCustomMinute(event.currentTarget.value)}
                            >
                              {/* Five-minute steps keep the list short; anything
                                  finer is what the Blob's own tool is for. */}
                              {Array.from({ length: 12 }, (_, slot) => slot * 5).map((minute) => (
                                <option key={minute} value={String(minute)}>
                                  {String(minute).padStart(2, "0")}
                                </option>
                              ))}
                            </select>
                          </>
                        )}
                        {customError === "" ? null : (
                          <span className="trigger-custom-error" aria-live="polite">
                            {customError}
                          </span>
                        )}
                        <div className="trigger-custom-actions">
                          <button
                            type="button"
                            role="menuitem"
                            className="account-menu-item"
                            onClick={() => setCustomOpen(false)}
                          >
                            Back
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="account-menu-item"
                            onClick={applyCustom}
                          >
                            Apply
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {SCHEDULE_OPTIONS.map((option) => (
                          <button
                            type="button"
                            role="menuitem"
                            key={option.label}
                            className="account-menu-item trigger-schedule-item"
                            onClick={() => setSchedule(option.label, option.schedule)}
                          >
                            {option.label}
                          </button>
                        ))}
                        <button
                          type="button"
                          role="menuitem"
                          className="account-menu-item trigger-schedule-item"
                          onClick={openCustom}
                        >
                          Custom…
                        </button>
                      </>
                    )
                  ) : (
                    EVENT_TRIGGERS.map(({ label, icon: Icon }) => (
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
                    ))
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {routine.schedule === undefined ? null : (
          <div className="settings-field">
            <span className="settings-label">Schedule</span>
            <p className="routine-empty-note">
              {describeSchedule(routine.schedule)}
              {routine.runsLeft === undefined || !routine.active || routine.runsLeft === 0
                ? ""
                : ` \u00b7 ${routine.runsLeft} left`}
              {routine.nextRunAt === undefined || !routine.active
                ? ""
                : ` \u00b7 next ${new Date(routine.nextRunAt).toLocaleString([], {
                    weekday: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}`}
            </p>
          </div>
        )}

        <div className="settings-field">
          <span className="settings-label">Run history</span>
          <p className="routine-empty-note">
            {routine.lastRunAt === undefined
              ? "No runs yet"
              : `Last run ${new Date(routine.lastRunAt).toLocaleString([], {
                  weekday: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })} \u00b7 ${routine.lastRunStatus ?? "done"}`}
          </p>
        </div>
      </div>
    </aside>
  );
}
