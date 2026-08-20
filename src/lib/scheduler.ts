import type { Routine } from "@/data/agents";
import { nextFireTime, scheduleBudget } from "@/lib/schedule";

/**
 * Fires scheduled routines while the app is open.
 *
 * Claim-before-run: a due routine's `nextRunAt` is advanced and persisted
 * BEFORE its turn runs, so a tick racing the startup scan (or a re-entrant
 * tick during a slow turn) can never fire the same instance twice — whoever
 * writes the claim first wins, the other sees a future `nextRunAt` and skips.
 *
 * Missed-while-closed policy: a routine whose `nextRunAt` is already in the
 * past fires once (catch-up), then advances to the next scheduled time.
 */

export interface SchedulerHost {
  /** Current routines per Blob id. Read fresh every tick. */
  routines(): ReadonlyMap<string, readonly Routine[]>;
  /**
   * Persist a claim or a result stamp. Must apply synchronously to
   * `routines()`. An explicit `nextRunAt: undefined` clears the fire time.
   */
  update(
    blobId: string,
    routineId: string,
    patch: Omit<Partial<Routine>, "nextRunAt"> & { nextRunAt?: number | undefined },
  ): void;
  /** True while any turn is running app-wide (one model, serial turns). */
  busy(): boolean;
  /** Run the routine's instruction as a turn for its Blob. */
  fire(blobId: string, routine: Routine): Promise<"done" | "failed" | "cancelled">;
}

/** How often the scheduler looks for due routines. */
export const TICK_MS = 30_000;

/**
 * One pass over every routine: claim and fire the first due one.
 *
 * At most one fire per tick, by design — turns are serial (one local model),
 * so claiming several at once would just park them in a queue where a crash
 * loses the claim. The next tick picks up the next due routine.
 */
export async function tick(host: SchedulerHost, now: number = Date.now()): Promise<boolean> {
  if (host.busy()) {
    return false;
  }
  for (const [blobId, routines] of host.routines()) {
    for (const routine of routines) {
      if (!routine.active || routine.schedule === undefined) {
        continue;
      }
      const due = routine.nextRunAt;
      if (due === undefined || due > now) {
        continue;
      }
      // Claim: advance nextRunAt past now before running. Computed from the
      // due time so a long outage still lands on schedule-aligned times.
      if (routine.schedule.kind === "once") {
        // A one-shot claims by deactivating: there is no next fire to advance
        // to, and the routine stays in the panel (paused) as its own record.
        host.update(blobId, routine.id, { active: false, nextRunAt: undefined });
        const status = await host.fire(blobId, routine);
        host.update(blobId, routine.id, { lastRunAt: now, lastRunStatus: status });
        return true;
      }
      // A counted interval tracks its budget in runsLeft, defaulting to the
      // schedule's count (armed paths set it; this also covers older data).
      const budget = routine.schedule.kind === "interval" ? routine.schedule.count : undefined;
      const runsLeft = budget === undefined ? undefined : Math.max(0, routine.runsLeft ?? budget);
      if (runsLeft !== undefined && runsLeft <= 1) {
        // The burst's final fire claims like a one-shot: deactivate with no
        // next time. Re-enabling the routine re-arms a fresh budget.
        host.update(blobId, routine.id, { active: false, nextRunAt: undefined, runsLeft: 0 });
        const status = await host.fire(blobId, routine);
        host.update(blobId, routine.id, { lastRunAt: now, lastRunStatus: status });
        return true;
      }
      let next = nextFireTime(routine.schedule, due);
      while (next <= now) {
        next = nextFireTime(routine.schedule, next);
      }
      host.update(
        blobId,
        routine.id,
        runsLeft === undefined ? { nextRunAt: next } : { nextRunAt: next, runsLeft: runsLeft - 1 },
      );
      const status = await host.fire(blobId, { ...routine, nextRunAt: next });
      host.update(blobId, routine.id, { lastRunAt: now, lastRunStatus: status });
      return true;
    }
  }
  return false;
}

/**
 * Arm `nextRunAt` for routines that have a schedule but no pending fire time
 * (just created, just edited, or loaded from an older store version).
 * Returns the number of routines armed.
 */
export function armRoutines(host: SchedulerHost, now: number = Date.now()): number {
  let armed = 0;
  for (const [blobId, routines] of host.routines()) {
    for (const routine of routines) {
      if (routine.schedule === undefined) {
        // Schedule removed: clear a stale fire time so it can never fire.
        if (routine.nextRunAt !== undefined) {
          host.update(blobId, routine.id, { nextRunAt: undefined });
        }
        continue;
      }
      if (!routine.active && routine.nextRunAt === undefined) {
        // Inactive with nothing pending (e.g. a fired one-shot): leave it —
        // arming it would put a "next" line on a routine that never fires.
        continue;
      }
      if (routine.nextRunAt === undefined) {
        // Arming a counted interval resets its budget: a fresh arm means "run
        // it count times from now", whether it just fired out or was edited.
        const budget = scheduleBudget(routine.schedule);
        host.update(
          blobId,
          routine.id,
          budget === undefined
            ? { nextRunAt: nextFireTime(routine.schedule, now) }
            : { nextRunAt: nextFireTime(routine.schedule, now), runsLeft: budget },
        );
        armed += 1;
      }
    }
  }
  return armed;
}

/** Start the interval loop. Returns a stop function. */
export function startScheduler(host: SchedulerHost): () => void {
  armRoutines(host);
  // Startup catch-up runs on the first tick, not immediately: hydration may
  // still be filling `routines()` when this is called.
  const interval = setInterval(() => {
    void tick(host);
  }, TICK_MS);
  return () => clearInterval(interval);
}
