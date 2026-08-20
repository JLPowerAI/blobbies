/**
 * Routine schedules: when a routine fires, in the user's local time.
 *
 * Deliberately not cron: four shapes cover "every N minutes / daily at /
 * weekly on / once after N minutes", are editable with two dropdowns, and
 * need no parser dependency.
 */

export type RoutineSchedule =
  | { kind: "interval"; minutes: number; count?: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "once"; minutes: number };

/** Interval bounds: below 5 minutes thrashes the model; above a day, use daily. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 24 * 60;

/**
 * A counted interval may run every minute: the run count is capped, so the
 * 5-minute floor's reason (an endless hot loop) does not apply. This is the
 * "five tips, one a minute" shape.
 */
export const MIN_BOUNDED_INTERVAL_MINUTES = 1;

/** Ceiling on a counted interval: bursts, not a second calendar. */
export const MAX_INTERVAL_COUNT = 50;

/**
 * One-shot bounds: no floor above 1 (it fires a single time, so there is no
 * loop to thrash) and the same day-scale ceiling — further out is a daily.
 */
export const MIN_ONCE_MINUTES = 1;
export const MAX_ONCE_MINUTES = 24 * 60;

/** Clamp helper so a hand-edited store value cannot produce a hot loop. */
function clampInterval(minutes: number, minMinutes: number): number {
  if (!Number.isFinite(minutes)) {
    return MAX_INTERVAL_MINUTES;
  }
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(minMinutes, Math.round(minutes)));
}

/**
 * Clamp a model-written run count into 1..MAX_INTERVAL_COUNT; anything that is
 * not a usable number means "no count" (undefined, unbounded).
 */
function clampCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(MAX_INTERVAL_COUNT, Math.max(1, Math.round(value)));
}

/** The minutes floor for an interval: counted bursts may run every minute. */
function intervalFloor(schedule: { count?: number }): number {
  return clampCount(schedule.count) === undefined
    ? MIN_INTERVAL_MINUTES
    : MIN_BOUNDED_INTERVAL_MINUTES;
}

/**
 * Initial `runsLeft` for a schedule: the count on an interval, undefined for
 * every unbounded shape. Arming sites use it to reset a burst's budget.
 */
export function scheduleBudget(schedule: RoutineSchedule): number | undefined {
  return schedule.kind === "interval" ? clampCount(schedule.count) : undefined;
}

/** Same idea for a one-shot: a single fire, so the floor is 1 minute. */
function clampOnce(minutes: number): number {
  if (!Number.isFinite(minutes)) {
    return MAX_ONCE_MINUTES;
  }
  return Math.min(MAX_ONCE_MINUTES, Math.max(MIN_ONCE_MINUTES, Math.round(minutes)));
}

/**
 * Next fire time strictly after `fromMs`, in local time (Date handles DST:
 * setHours on a shifted day resolves to the wall-clock hour).
 */
export function nextFireTime(schedule: RoutineSchedule, fromMs: number): number {
  switch (schedule.kind) {
    case "interval":
      return fromMs + clampInterval(schedule.minutes, intervalFloor(schedule)) * 60_000;
    case "once":
      return fromMs + clampOnce(schedule.minutes) * 60_000;
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
      const count = clampCount(schedule.count);
      const minutes = clampInterval(
        schedule.minutes,
        count === undefined ? MIN_INTERVAL_MINUTES : MIN_BOUNDED_INTERVAL_MINUTES,
      );
      let every: string;
      if (minutes % 60 === 0) {
        const hours = minutes / 60;
        every = hours === 1 ? "Every hour" : `Every ${hours} hours`;
      } else if (minutes === 1) {
        every = "Every minute";
      } else {
        every = `Every ${minutes} minutes`;
      }
      return count === undefined ? every : `${every}, ${count} times`;
    }
    case "once": {
      const minutes = clampOnce(schedule.minutes);
      return minutes === 1 ? "Once, in a minute" : `Once, in ${minutes} minutes`;
    }
    case "daily":
      return `Every day at ${clock(schedule.hour, schedule.minute)}`;
    case "weekly":
      return `Every ${WEEKDAYS[schedule.weekday] ?? "?"} at ${clock(schedule.hour, schedule.minute)}`;
  }
}

/** Day names indexed as `weekly.weekday` is (0 = Sunday). */
export const WEEKDAY_NAMES = WEEKDAYS;

/**
 * Lenient coerce for a model-written schedule (tool args or the schedule
 * round): a small model omits `minute` more often than it misfills it, so the
 * minute defaults to 0, an interval is clamped rather than rejected, and only
 * genuinely wrong fields (hour 25, a missing hour, junk kinds) return null —
 * the caller refuses with a message naming what a schedule needs. Strict
 * `parseSchedule` stays the gate for values read back from the store.
 */
export function coerceSchedule(value: unknown): RoutineSchedule | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const int = (key: string): number | null =>
    typeof raw[key] === "number" && Number.isFinite(raw[key] as number)
      ? Math.round(raw[key] as number)
      : null;
  const timeOfDay = (): { hour: number; minute: number } | null => {
    const hour = int("hour");
    if (hour === null || hour < 0 || hour > 23) {
      return null;
    }
    const minute = int("minute") ?? 0;
    return minute < 0 || minute > 59 ? null : { hour, minute };
  };
  switch (raw.kind) {
    case "interval": {
      const minutes = int("minutes");
      if (minutes === null) {
        return null;
      }
      const count = clampCount(raw.count);
      return {
        kind: "interval",
        minutes: clampInterval(
          minutes,
          count === undefined ? MIN_INTERVAL_MINUTES : MIN_BOUNDED_INTERVAL_MINUTES,
        ),
        ...(count === undefined ? {} : { count }),
      };
    }
    case "once": {
      const minutes = int("minutes");
      return minutes === null ? null : { kind: "once", minutes: clampOnce(minutes) };
    }
    case "daily": {
      const time = timeOfDay();
      return time === null ? null : { kind: "daily", hour: time.hour, minute: time.minute };
    }
    case "weekly": {
      const time = timeOfDay();
      const weekday = int("weekday");
      if (time === null || weekday === null || weekday < 0 || weekday > 6) {
        return null;
      }
      return { kind: "weekly", weekday, hour: time.hour, minute: time.minute };
    }
    default:
      return null;
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
      if (minutes === null) {
        return null;
      }
      const count = clampCount(raw.count);
      return {
        kind: "interval",
        minutes: clampInterval(
          minutes,
          count === undefined ? MIN_INTERVAL_MINUTES : MIN_BOUNDED_INTERVAL_MINUTES,
        ),
        ...(count === undefined ? {} : { count }),
      };
    }
    case "once": {
      const minutes = int("minutes");
      return minutes === null ? null : { kind: "once", minutes: clampOnce(minutes) };
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
