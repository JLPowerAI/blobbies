import { describe, expect, it } from "vitest";
import type { Routine } from "@/data/agents";
import { armRoutines, type SchedulerHost, tick } from "@/lib/scheduler";
import {
  type EventListener,
  listenerIdentity,
  parseListener,
  type TriggerEvent,
} from "@/lib/trigger";
import type { PollCursor } from "@/lib/trigger-poll";

/** In-memory host: synchronous updates, recorded fires. */
function makeHost(initial: Record<string, Routine[]>) {
  const routines = new Map<string, Routine[]>(Object.entries(initial));
  const fired: string[] = [];
  const arrivals: (TriggerEvent | undefined)[] = [];
  const seenAtFire: (Record<string, PollCursor> | undefined)[] = [];
  // Events a listener's platform will report, keyed by listener identity.
  const feeds = new Map<string, TriggerEvent[]>();
  let busy = false;
  let fireResult: "done" | "failed" | "cancelled" = "done";
  const host: SchedulerHost = {
    routines: () => routines,
    update: (blobId, routineId, patch) => {
      routines.set(
        blobId,
        (routines.get(blobId) ?? []).map((candidate) =>
          candidate.id === routineId ? ({ ...candidate, ...patch } as Routine) : candidate,
        ),
      );
    },
    busy: () => busy,
    poll: (listener, cursor) => {
      const queued = feeds.get(listenerIdentity(listener));
      // Absent = the platform call failed (not connected, rate limited),
      // which the poller surfaces by rejecting.
      if (queued === undefined) {
        return Promise.reject(new Error("not connected"));
      }
      const seen = cursor.since;
      const fresh =
        seen === undefined ? [] : queued.slice(queued.findIndex((e) => String(e.id) === seen) + 1);
      const newest = queued.at(-1);
      return Promise.resolve({
        events: fresh,
        cursor: newest === undefined ? cursor : { since: String(newest.id) },
      });
    },
    fire: (blobId, routine, event) => {
      fired.push(routine.id);
      arrivals.push(event);
      // What the STORE said at the instant the turn began. This is the only
      // way to prove claim-before-run: if the claim were written after the
      // fire instead, a re-entrant tick during a slow turn would still see
      // the old value here — and so would this snapshot.
      seenAtFire.push(
        routines.get(blobId)?.find((candidate) => candidate.id === routine.id)?.cursors,
      );
      return Promise.resolve(fireResult);
    },
  };
  return {
    host,
    fired,
    arrivals,
    seenAtFire,
    setFeed: (listener: EventListener, events: readonly TriggerEvent[]) => {
      feeds.set(listenerIdentity(listener), [...events]);
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
    setFireResult: (value: "done" | "failed" | "cancelled") => {
      fireResult = value;
    },
    get: (blobId: string, routineId: string) =>
      routines.get(blobId)?.find((candidate) => candidate.id === routineId),
  };
}

type RoutineOverrides = Omit<Partial<Routine>, "schedule" | "nextRunAt"> & {
  schedule?: Routine["schedule"] | undefined;
  nextRunAt?: number | undefined;
};

const routine = (overrides: RoutineOverrides): Routine => {
  const base: Routine = {
    id: "r1",
    name: "Daily check",
    instruction: "check things",
    triggers: [],
    active: true,
    schedule: { kind: "interval", minutes: 60 },
  };
  // Spread-with-undefined is exactly what we want in tests ("no schedule"),
  // but exactOptionalPropertyTypes forbids it on Routine — strip afterwards.
  const merged = { ...base, ...overrides };
  if (merged.schedule === undefined) {
    delete merged.schedule;
  }
  if (merged.nextRunAt === undefined) {
    delete merged.nextRunAt;
  }
  return merged as Routine;
};

const HOUR = 3_600_000;

describe("tick", () => {
  it("fires a due routine and advances nextRunAt past now (the claim)", async () => {
    const now = 10 * HOUR;
    const h = makeHost({ b1: [routine({ nextRunAt: now - 1 })] });
    expect(await tick(h.host, now)).toBe(true);
    expect(h.fired).toEqual(["r1"]);
    const after = h.get("b1", "r1");
    expect(after?.nextRunAt).toBeGreaterThan(now);
    expect(after?.lastRunAt).toBe(now);
    expect(after?.lastRunStatus).toBe("done");
  });

  it("fires a once routine one time and deactivates it — no re-arm, no second fire", async () => {
    const now = 10 * HOUR;
    const h = makeHost({
      b1: [
        routine({
          schedule: { kind: "once", minutes: 1 },
          nextRunAt: now - 1,
        }),
      ],
    });
    expect(await tick(h.host, now)).toBe(true);
    const after = h.get("b1", "r1");
    expect(after?.active).toBe(false);
    expect(after?.nextRunAt).toBeUndefined();
    // A later tick sees an inactive routine: nothing fires again.
    expect(await tick(h.host, now + HOUR)).toBe(false);
    expect(h.fired).toEqual(["r1"]);
  });

  it("a counted interval decrements runsLeft as its claim and stays armed", async () => {
    const now = 10 * HOUR;
    const h = makeHost({
      b1: [
        routine({
          schedule: { kind: "interval", minutes: 1, count: 3 },
          runsLeft: 3,
          nextRunAt: now - 1,
        }),
      ],
    });
    expect(await tick(h.host, now)).toBe(true);
    const after = h.get("b1", "r1");
    expect(after?.runsLeft).toBe(2);
    // The bounded floor applies — and the claim lands on due + 1 minute, the
    // schedule-aligned time, not now + 1 minute.
    expect(after?.nextRunAt).toBe(now - 1 + 60_000);
    expect(after?.active).toBe(true);
  });

  it("a counted interval retires after its final fire, like a one-shot", async () => {
    const now = 10 * HOUR;
    const h = makeHost({
      b1: [
        routine({
          schedule: { kind: "interval", minutes: 1, count: 2 },
          runsLeft: 1,
          nextRunAt: now - 1,
        }),
      ],
    });
    expect(await tick(h.host, now)).toBe(true);
    const after = h.get("b1", "r1");
    expect(after?.active).toBe(false);
    expect(after?.nextRunAt).toBeUndefined();
    expect(after?.runsLeft).toBe(0);
    expect(await tick(h.host, now + HOUR)).toBe(false);
    expect(h.fired).toEqual(["r1"]);
  });

  it("defaults runsLeft to the schedule's count when no arming path set it", async () => {
    const now = 10 * HOUR;
    const h = makeHost({
      b1: [routine({ schedule: { kind: "interval", minutes: 1, count: 2 }, nextRunAt: now - 1 })],
    });
    await tick(h.host, now);
    expect(h.get("b1", "r1")?.runsLeft).toBe(1);
  });

  it("claims before running, so a re-entrant tick cannot double-fire", async () => {
    // The fire callback itself runs a tick — the worst-case re-entrancy.
    const now = 10 * HOUR;
    const h = makeHost({ b1: [routine({ nextRunAt: now - 1 })] });
    const original = h.host.fire;
    h.host.fire = async (blobId, r) => {
      // The claim must already be visible here.
      expect(h.get("b1", "r1")?.nextRunAt).toBeGreaterThan(now);
      expect(await tick(h.host, now)).toBe(false);
      return original(blobId, r);
    };
    await tick(h.host, now);
    expect(h.fired).toEqual(["r1"]);
  });

  it("a long-overdue routine fires once, then lands on a future slot", async () => {
    // Closed laptop for a week: catch up exactly once, no burst of backfires.
    const now = 1000 * HOUR;
    const h = makeHost({ b1: [routine({ nextRunAt: now - 500 * HOUR })] });
    await tick(h.host, now);
    expect(h.fired).toEqual(["r1"]);
    expect(await tick(h.host, now)).toBe(false);
    expect(h.fired).toEqual(["r1"]);
  });

  it("skips inactive, unscheduled, unarmed and future routines", async () => {
    const now = 10 * HOUR;
    const h = makeHost({
      b1: [
        routine({ id: "off", active: false, nextRunAt: now - 1 }),
        routine({ id: "manual", schedule: undefined, nextRunAt: now - 1 }),
        routine({ id: "unarmed", nextRunAt: undefined }),
        routine({ id: "future", nextRunAt: now + HOUR }),
      ],
    });
    expect(await tick(h.host, now)).toBe(false);
    expect(h.fired).toEqual([]);
  });

  it("defers while a turn is running instead of queueing behind it", async () => {
    const now = 10 * HOUR;
    const h = makeHost({ b1: [routine({ nextRunAt: now - 1 })] });
    h.setBusy(true);
    expect(await tick(h.host, now)).toBe(false);
    // The claim was NOT taken: the routine is still due next tick.
    expect(h.get("b1", "r1")?.nextRunAt).toBe(now - 1);
  });

  it("records a failed fire in lastRunStatus", async () => {
    const now = 10 * HOUR;
    const h = makeHost({ b1: [routine({ nextRunAt: now - 1 })] });
    h.setFireResult("failed");
    await tick(h.host, now);
    expect(h.get("b1", "r1")?.lastRunStatus).toBe("failed");
  });

  it("fires at most one routine per tick", async () => {
    const now = 10 * HOUR;
    const h = makeHost({
      b1: [routine({ id: "a", nextRunAt: now - 1 }), routine({ id: "b", nextRunAt: now - 1 })],
    });
    await tick(h.host, now);
    expect(h.fired).toHaveLength(1);
    await tick(h.host, now);
    expect(h.fired).toHaveLength(2);
  });

  it("claims a listener's cursor before running it, and never fires twice", async () => {
    const now = 10 * HOUR;
    const listener = parseListener({
      type: "github",
      repo: "acme/app",
      events: ["pr-opened"],
    }) as EventListener;
    const h = makeHost({ b1: [routine({ schedule: undefined, listeners: [listener] })] });
    const old = { source: "github", id: "1", repo: "acme/app", kind: "pr-opened" };
    h.setFeed(listener, [old]);

    // First poll arms: what already happened is not news.
    expect(await tick(h.host, now)).toBe(false);
    expect(h.fired).toEqual([]);

    const fresh = { source: "github", id: "2", repo: "acme/app", kind: "pr-opened" };
    h.setFeed(listener, [old, fresh]);
    expect(await tick(h.host, now)).toBe(true);
    expect(h.fired).toEqual(["r1"]);
    expect(h.arrivals).toEqual([fresh]);
    // The ordering itself: the cursor had already moved past this event when
    // the turn began, so a tick re-entering during a slow turn finds nothing.
    expect(h.seenAtFire[0]?.[listenerIdentity(listener)]).toEqual({ since: "2" });
    expect(h.get("b1", "r1")?.lastRunAt).toBe(now);
    expect(await tick(h.host, now)).toBe(false);
    expect(h.fired).toHaveLength(1);
  });

  it("skips listeners while its Blob is busy, keeping the event", async () => {
    const now = 10 * HOUR;
    const listener = parseListener({
      type: "github",
      repo: "acme/app",
      events: ["pr-opened"],
    }) as EventListener;
    const key = listenerIdentity(listener);
    const h = makeHost({
      b1: [
        routine({ schedule: undefined, listeners: [listener], cursors: { [key]: { since: "1" } } }),
      ],
    });
    h.setFeed(listener, [
      { source: "github", id: "1", repo: "acme/app", kind: "pr-opened" },
      { source: "github", id: "2", repo: "acme/app", kind: "pr-opened" },
    ]);
    h.setBusy(true);
    expect(await tick(h.host, now)).toBe(false);
    expect(h.fired).toEqual([]);
    // Nothing was claimed, so the event still waits when the Blob frees up.
    expect(h.get("b1", "r1")?.cursors?.[key]).toEqual({ since: "1" });
    h.setBusy(false);
    expect(await tick(h.host, now)).toBe(true);
    expect(h.arrivals[0]?.id).toBe("2");
  });

  it("waits quietly when the account is not connected", async () => {
    const now = 10 * HOUR;
    const listener = parseListener({
      type: "slack",
      channel: "#ops",
      match: { kind: "mention" },
    }) as EventListener;
    // No feed registered = the platform call fails.
    const h = makeHost({ b1: [routine({ schedule: undefined, listeners: [listener] })] });
    expect(await tick(h.host, now)).toBe(false);
    expect(h.fired).toEqual([]);
    expect(h.get("b1", "r1")?.cursors).toBeUndefined();
  });

  it("advances past an event no listener wanted, rather than re-reading it", async () => {
    const now = 10 * HOUR;
    const listener = parseListener({
      type: "github",
      repo: "acme/app",
      events: ["pr-merged"],
    }) as EventListener;
    const key = listenerIdentity(listener);
    const h = makeHost({
      b1: [
        routine({ schedule: undefined, listeners: [listener], cursors: { [key]: { since: "1" } } }),
      ],
    });
    h.setFeed(listener, [
      { source: "github", id: "1", repo: "acme/app", kind: "pr-merged" },
      // Not subscribed to this kind.
      { source: "github", id: "2", repo: "acme/app", kind: "pr-opened" },
    ]);
    expect(await tick(h.host, now)).toBe(false);
    expect(h.fired).toEqual([]);
    // Handled, so the cursor moves on: otherwise it would be re-read forever.
    expect(h.get("b1", "r1")?.cursors?.[key]).toEqual({ since: "2" });
  });

  it("ignores a listener the store cannot vouch for", async () => {
    const now = 10 * HOUR;
    const h = makeHost({
      b1: [
        routine({
          schedule: undefined,
          // Not a real repo, so it never becomes a listener.
          listeners: [
            { type: "github", repo: "not-a-repo", events: ["pr-opened"] } as EventListener,
          ],
        }),
      ],
    });
    expect(await tick(h.host, now)).toBe(false);
    expect(h.fired).toEqual([]);
  });
});

describe("armRoutines", () => {
  it("arms scheduled routines that have no fire time yet", () => {
    const now = 10 * HOUR;
    const h = makeHost({ b1: [routine({ nextRunAt: undefined })] });
    expect(armRoutines(h.host, now)).toBe(1);
    expect(h.get("b1", "r1")?.nextRunAt).toBe(now + HOUR);
  });

  it("arms a counted interval with a fresh budget and the 1-minute floor", () => {
    const now = 10 * HOUR;
    const h = makeHost({
      b1: [
        routine({
          schedule: { kind: "interval", minutes: 1, count: 5 },
          nextRunAt: undefined,
        }),
      ],
    });
    expect(armRoutines(h.host, now)).toBe(1);
    expect(h.get("b1", "r1")?.nextRunAt).toBe(now + 60_000);
    expect(h.get("b1", "r1")?.runsLeft).toBe(5);
  });

  it("does not re-arm a fired one-shot at startup", () => {
    // The claim on a once routine deactivates it with no fire time; arming it
    // again would put a "next" line on a routine that can never fire again.
    const h = makeHost({
      b1: [
        routine({ active: false, schedule: { kind: "once", minutes: 5 }, nextRunAt: undefined }),
      ],
    });
    expect(armRoutines(h.host, 10 * HOUR)).toBe(0);
    expect(h.get("b1", "r1")?.nextRunAt).toBeUndefined();
  });

  it("clears a stale fire time when the schedule was removed", () => {
    const h = makeHost({ b1: [routine({ schedule: undefined, nextRunAt: 5 })] });
    expect(armRoutines(h.host, 10)).toBe(0);
    expect(h.get("b1", "r1")?.nextRunAt).toBeUndefined();
  });

  it("leaves already-armed routines alone (no drift on relaunch)", () => {
    const h = makeHost({ b1: [routine({ nextRunAt: 42 })] });
    expect(armRoutines(h.host, 10 * HOUR)).toBe(0);
    expect(h.get("b1", "r1")?.nextRunAt).toBe(42);
  });
});
