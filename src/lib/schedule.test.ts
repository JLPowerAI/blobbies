import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  nextFireTime,
  parseSchedule,
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
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 5 })).toBe("Every day at 09:05");
    expect(describeSchedule({ kind: "weekly", weekday: 1, hour: 17, minute: 0 })).toBe(
      "Every Monday at 17:00",
    );
  });
});

describe("parseSchedule", () => {
  it("round-trips valid shapes", () => {
    for (const schedule of [
      { kind: "interval", minutes: 30 },
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
