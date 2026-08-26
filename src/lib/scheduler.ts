import type { Routine } from "@/data/agents";
import { nextFireTime, scheduleBudget } from "@/lib/schedule";
import { newlyArrived, parseTrigger, type TriggerEntry } from "@/lib/trigger";

/**
 * Fires scheduled and triggered routines while the app is open.
 *
 * Claim-before-run: a due routine's `nextRunAt` is advanced and persisted
 * BEFORE its turn runs, so a tick racing the startup scan (or a re-entrant
 * tick during a slow turn) can never fire the same instance twice — whoever
 * writes the claim first wins, the other sees a future `nextRunAt` and skips.
 * An event trigger claims the same way: the arrivals it is about to fire on
 * are written into `seen` first, so a second tick sees nothing new.
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
  /**
   * True while this Blob's own conversation is already running a turn.
   *
   * Per Blob, not app-wide: turns run in parallel across conversations, and a
   * routine writes into its Blob's own transcript — so an unrelated group
   * chat is no reason to skip it.
   */
  busy(blobId: string): boolean;
  /**
   * List one folder of a Blob's home, for file triggers. Rejects when the
   * folder does not exist — a trigger pointed at a missing folder waits for
   * it rather than failing the tick.
   */
  listFiles(blobId: string, folder: string): Promise<readonly TriggerEntry[]>;
  /**
   * Run the routine's instruction as a turn for its Blob. `arrived` carries
   * the names of files an event trigger fired on — names only: the Blob must
   * read a file through its own contained, traced tool if it wants content.
   */
  fire(
    blobId: string,
    routine: Routine,
    arrived?: readonly string[],
  ): Promise<"done" | "failed" | "cancelled">;
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
  for (const [blobId, routines] of host.routines()) {
    // Its own chat is mid-turn, so its routine waits for the next tick rather
    // than queueing behind work the user is watching.
    if (host.busy(blobId)) {
      continue;
    }
    for (const routine of routines) {
      if (!routine.active) {
        continue;
      }
      if (routine.schedule === undefined) {
        if (await fireTrigger(host, blobId, routine, now)) {
          return true;
        }
        continue;
      }
      const due = routine.nextRunAt;
      if (due === undefined || due > now) {
        // Still on the clock, but an event may have arrived meanwhile: a
        // routine may carry both, and the schedule is the slower of the two.
        if (await fireTrigger(host, blobId, routine, now)) {
          return true;
        }
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
 * Poll one routine's event trigger and fire it if something arrived.
 *
 * Returns true when it fired, so the caller can honour the one-fire-per-tick
 * rule. A listing that fails (folder not created yet, disk busy) is not an
 * error: the trigger simply has nothing to report this tick.
 */
async function fireTrigger(
  host: SchedulerHost,
  blobId: string,
  routine: Routine,
  now: number,
): Promise<boolean> {
  const trigger = parseTrigger(routine.trigger);
  if (trigger === null) {
    return false;
  }
  let entries: readonly TriggerEntry[];
  try {
    entries = await host.listFiles(blobId, trigger.folder);
  } catch {
    return false;
  }
  const { seen, arrived } = newlyArrived(routine.seen, entries);
  if (arrived.length === 0) {
    // Still record the listing: the first poll arms, and deletions prune so a
    // file delivered again counts as new. Length is enough to spot a change —
    // nothing arrived, so the only possible difference is a removal.
    if (seen.length !== (routine.seen?.length ?? -1)) {
      host.update(blobId, routine.id, { seen });
    }
    return false;
  }
  // The claim: the arrivals are marked seen BEFORE the turn runs, so a
  // re-entrant tick during a slow turn finds nothing new to fire on.
  host.update(blobId, routine.id, { seen });
  const status = await host.fire(blobId, { ...routine, seen }, arrived);
  host.update(blobId, routine.id, { lastRunAt: now, lastRunStatus: status });
  return true;
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
