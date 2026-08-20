import { describe, expect, it } from "vitest";
import {
  coerceSchedule,
  describeSchedule,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  MIN_ONCE_MINUTES,
  nextFireTime,
  parseSchedule,
  WEEKDAY_NAMES,
} from "@/lib/schedule";

/** Local-time timestamp helper: 2026-03-02 is a Monday. */
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 2, day, hour, minute).getTime();

describe("nextFireTime", () => {
  it("interval fires N minutes later", () => {
    expect(nextFireTime({ kind: "interval", minutes: 30 }, at(2, 9))).toBe(at(2, 9, 30));
  });

  it("interval clamps below the floor and above the ceiling", () => {
    // A hand-edited store value must not produce a hot loop or a dead timer.
    expect(nextFireTime({ kind: "interval", minutes: 0 }, 0)).toBe(MIN_INTERVAL_MINUTES * 60_000);
    expect(nextFireTime({ kind: "interval", minutes: Number.NaN }, 0)).toBe(
      MAX_INTERVAL_MINUTES * 60_000,
    );
  });

  it("once fires N minutes from arming, with a 1-minute floor", () => {
    expect(nextFireTime({ kind: "once", minutes: 10 }, at(2, 9))).toBe(at(2, 9, 10));
    // No interval-style 5-minute floor: a one-shot fires once, so "in 1
    // minute" (the request that motivated the kind) must stay 1 minute.
    expect(nextFireTime({ kind: "once", minutes: 0 }, at(2, 9))).toBe(at(2, 9, MIN_ONCE_MINUTES));
  });

  it("a counted interval may run every minute — the burst shape", () => {
    // "Five tips, one a minute" is count-bounded, so the 5-minute floor
    // (an endless-loop guard) does not apply.
    expect(nextFireTime({ kind: "interval", minutes: 1, count: 5 }, at(2, 9))).toBe(at(2, 9, 1));
  });

  it("daily fires later today when the time is still ahead", () => {
    expect(nextFireTime({ kind: "daily", hour: 17, minute: 30 }, at(2, 9))).toBe(at(2, 17, 30));
  });

  it("daily rolls to tomorrow when the time already passed", () => {
    expect(nextFireTime({ kind: "daily", hour: 9, minute: 0 }, at(2, 9))).toBe(at(3, 9));
  });

  it("weekly fires on the next matching weekday", () => {
    // From Monday 09:00 to Wednesday (weekday 3) 08:00.
    expect(nextFireTime({ kind: "weekly", weekday: 3, hour: 8, minute: 0 }, at(2, 9))).toBe(
      at(4, 8),
    );
  });

  it("weekly rolls a full week when today's slot already passed", () => {
    expect(nextFireTime({ kind: "weekly", weekday: 1, hour: 8, minute: 0 }, at(2, 9))).toBe(
      at(9, 8),
    );
  });

  it("always returns a time strictly after `fromMs`", () => {
    const from = at(2, 9);
    const schedules = [
      { kind: "interval", minutes: 5 },
      { kind: "once", minutes: 1 },
      { kind: "daily", hour: 9, minute: 0 },
      { kind: "weekly", weekday: 1, hour: 9, minute: 0 },
    ] as const;
    for (const schedule of schedules) {
      expect(nextFireTime(schedule, from)).toBeGreaterThan(from);
    }
  });
});

describe("describeSchedule", () => {
  it("renders human lines", () => {
    expect(describeSchedule({ kind: "interval", minutes: 60 })).toBe("Every hour");
    expect(describeSchedule({ kind: "interval", minutes: 120 })).toBe("Every 2 hours");
    expect(describeSchedule({ kind: "interval", minutes: 45 })).toBe("Every 45 minutes");
    expect(describeSchedule({ kind: "interval", minutes: 30, count: 3 })).toBe(
      "Every 30 minutes, 3 times",
    );
    expect(describeSchedule({ kind: "interval", minutes: 1, count: 5 })).toBe(
      "Every minute, 5 times",
    );
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 5 })).toBe("Every day at 09:05");
    expect(describeSchedule({ kind: "weekly", weekday: 1, hour: 17, minute: 0 })).toBe(
      "Every Monday at 17:00",
    );
    expect(describeSchedule({ kind: "once", minutes: 1 })).toBe("Once, in a minute");
    expect(describeSchedule({ kind: "once", minutes: 10 })).toBe("Once, in 10 minutes");
  });
});

describe("parseSchedule", () => {
  it("round-trips valid shapes", () => {
    for (const schedule of [
      { kind: "interval", minutes: 30 },
      { kind: "interval", minutes: 1, count: 5 },
      { kind: "once", minutes: 1 },
      { kind: "daily", hour: 0, minute: 0 },
      { kind: "weekly", weekday: 6, hour: 23, minute: 59 },
    ]) {
      expect(parseSchedule(schedule)).toEqual(schedule);
    }
  });

  it("rejects malformed store values instead of guessing", () => {
    for (const value of [
      null,
      "daily",
      { kind: "daily", hour: 24, minute: 0 },
      { kind: "daily", hour: 9.5, minute: 0 },
      { kind: "weekly", weekday: 7, hour: 9, minute: 0 },
      { kind: "monthly", day: 1 },
    ]) {
      expect(parseSchedule(value)).toBeNull();
    }
  });

  it("clamps interval minutes on the way in", () => {
    expect(parseSchedule({ kind: "interval", minutes: 1 })).toEqual({
      kind: "interval",
      minutes: MIN_INTERVAL_MINUTES,
    });
  });
});

describe("coerceSchedule", () => {
  it("defaults a missing minute to 0, the omission a small model makes", () => {
    expect(coerceSchedule({ kind: "daily", hour: 15 })).toEqual({
      kind: "daily",
      hour: 15,
      minute: 0,
    });
  });

  it("rounds and clamps an interval instead of rejecting it", () => {
    expect(coerceSchedule({ kind: "interval", minutes: 1 })).toEqual({
      kind: "interval",
      minutes: MIN_INTERVAL_MINUTES,
    });
    expect(coerceSchedule({ kind: "interval", minutes: 99.4 })).toEqual({
      kind: "interval",
      minutes: 99,
    });
  });

  it("clamps a run count, and only a usable count unlocks 1-minute steps", () => {
    expect(coerceSchedule({ kind: "interval", minutes: 1, count: 5 })).toEqual({
      kind: "interval",
      minutes: 1,
      count: 5,
    });
    expect(coerceSchedule({ kind: "interval", minutes: 1, count: 99 })).toEqual({
      kind: "interval",
      minutes: 1,
      count: 50,
    });
    expect(coerceSchedule({ kind: "interval", minutes: 1, count: 0 })).toEqual({
      kind: "interval",
      minutes: 1,
      count: 1,
    });
    // A junk count means unbounded, so the 5-minute floor returns.
    expect(coerceSchedule({ kind: "interval", minutes: 1, count: "5" })).toEqual({
      kind: "interval",
      minutes: MIN_INTERVAL_MINUTES,
    });
  });

  it("accepts a weekly schedule with a real weekday and time", () => {
    expect(coerceSchedule({ kind: "weekly", weekday: 5, hour: 16 })).toEqual({
      kind: "weekly",
      weekday: 5,
      hour: 16,
      minute: 0,
    });
  });

  it("accepts a one-shot delay, clamped to its own 1-minute floor", () => {
    expect(coerceSchedule({ kind: "once", minutes: 1 })).toEqual({
      kind: "once",
      minutes: 1,
    });
    expect(coerceSchedule({ kind: "once", minutes: 0 })).toEqual({
      kind: "once",
      minutes: MIN_ONCE_MINUTES,
    });
    // No minutes at all is a refusal: a one-shot without a delay is nothing.
    expect(coerceSchedule({ kind: "once" })).toBeNull();
  });

  it("refuses a schedule with no time of day — never guess one", () => {
    // The tool-refusal path: hour 25, a missing hour, or a junk kind must not
    // become a silently-armed 9am, which is the bug the old UI had.
    for (const value of [
      { kind: "daily", hour: 25 },
      { kind: "daily" },
      { kind: "daily", hour: 9, minute: 60 },
      { kind: "weekly", weekday: 7, hour: 9 },
      { kind: "monthly", day: 1 },
      null,
      "daily",
    ]) {
      expect(coerceSchedule(value)).toBeNull();
    }
  });

  it("exposes weekday names indexed as weekly.weekday is", () => {
    expect(WEEKDAY_NAMES).toHaveLength(7);
    expect(WEEKDAY_NAMES[0]).toBe("Sunday");
    expect(WEEKDAY_NAMES[5]).toBe("Friday");
  });
});
