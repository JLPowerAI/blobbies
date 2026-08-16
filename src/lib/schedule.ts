/**
 * Routine schedules: when a routine fires, in the user's local time.
 *
 * Deliberately not cron: three shapes cover "every N minutes / daily at /
 * weekly on", are editable with two dropdowns, and need no parser dependency.
 */

export type RoutineSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

/** Interval bounds: below 5 minutes thrashes the model; above a day, use daily. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 24 * 60;

/** Clamp helper so a hand-edited store value cannot produce a hot loop. */
function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) {
    return MAX_INTERVAL_MINUTES;
  }
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes)));
}

/**
 * Next fire time strictly after `fromMs`, in local time (Date handles DST:
 * setHours on a shifted day resolves to the wall-clock hour).
 */
export function nextFireTime(schedule: RoutineSchedule, fromMs: number): number {
  switch (schedule.kind) {
    case "interval":
      return fromMs + clampInterval(schedule.minutes) * 60_000;
    case "daily": {
      const next = new Date(fromMs);
      next.setHours(schedule.hour, schedule.minute, 0, 0);
      if (next.getTime() <= fromMs) {
        next.setDate(next.getDate() + 1);
        // Re-pin the wall-clock time in case the day shift crossed DST.
        next.setHours(schedule.hour, schedule.minute, 0, 0);
      }
      return next.getTime();
    }
    case "weekly": {
      const next = new Date(fromMs);
      next.setHours(schedule.hour, schedule.minute, 0, 0);
      const daysAhead = (schedule.weekday - next.getDay() + 7) % 7;
      next.setDate(next.getDate() + daysAhead);
      if (next.getTime() <= fromMs) {
        next.setDate(next.getDate() + 7);
      }
      next.setHours(schedule.hour, schedule.minute, 0, 0);
      return next.getTime();
    }
  }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Human line for the routine list, e.g. "Every day at 09:00". */
export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case "interval": {
      const minutes = clampInterval(schedule.minutes);
      if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return hours === 1 ? "Every hour" : `Every ${hours} hours`;
      }
      return `Every ${minutes} minutes`;
    }
    case "daily":
      return `Every day at ${clock(schedule.hour, schedule.minute)}`;
    case "weekly":
      return `Every ${WEEKDAYS[schedule.weekday] ?? "?"} at ${clock(schedule.hour, schedule.minute)}`;
  }
}

/** Validate a value read from the store; null when it is not a schedule. */
export function parseSchedule(value: unknown): RoutineSchedule | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const int = (key: string): number | null =>
    typeof raw[key] === "number" && Number.isInteger(raw[key]) ? (raw[key] as number) : null;
  switch (raw.kind) {
    case "interval": {
      const minutes = int("minutes");
      return minutes === null ? null : { kind: "interval", minutes: clampInterval(minutes) };
    }
    case "daily": {
      const hour = int("hour");
      const minute = int("minute");
      if (hour === null || minute === null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return null;
      }
      return { kind: "daily", hour, minute };
    }
    case "weekly": {
      const weekday = int("weekday");
      const hour = int("hour");
      const minute = int("minute");
      if (
        weekday === null ||
        hour === null ||
        minute === null ||
        weekday < 0 ||
        weekday > 6 ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
      ) {
        return null;
      }
      return { kind: "weekly", weekday, hour, minute };
    }
    default:
      return null;
  }
}
