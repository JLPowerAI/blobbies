/**
 * Routine event triggers: what makes a routine fire other than the clock.
 *
 * One shape today — a file arriving in a folder of the Blob's own home. It is
 * the only event blobbies can observe without a credential, a relay or a
 * second process: the scheduler already ticks every 30s, so a trigger is a
 * folder listing folded against the listing from the tick before.
 *
 * The fold is pure and lives here (the `schedule.ts` pattern) so the "fires
 * once, never twice" rule is testable without a scheduler, a Blob or a disk.
 */

/** One row of a folder listing, as much of it as a trigger reads. */
export interface TriggerEntry {
  name: string;
  isDir: boolean;
}

export type RoutineTrigger = { kind: "file"; folder: string };

/** Longest watched folder path; far above any real one, bounds store growth. */
export const MAX_FOLDER_LENGTH = 120;

/**
 * How many arrivals one fire may name. A folder emptied into by a sync client
 * must not produce a prompt listing 900 files — the rest stay unseen and
 * surface on later ticks, so nothing is dropped, only paced.
 */
export const MAX_ARRIVALS_PER_FIRE = 5;

/**
 * Ceiling on the remembered listing.
 *
 * simplification: a watched folder holding more than this many files stops
 * triggering reliably — names past the cap are neither remembered nor fired,
 * because remembering them all would grow the routine's store row without
 * bound. Upgrade path: track a modified-time watermark instead of a name set.
 */
export const MAX_TRACKED_FILES = 200;

/**
 * Clean a user-typed folder into a home-relative path; null when it cannot be
 * one. The Rust side contains every path again (`resolve_in_home`) — this is
 * the gate that stops a traversal being *stored* on a routine in the first
 * place.
 */
export function normalizeFolder(value: string): string | null {
  if (value.length > MAX_FOLDER_LENGTH) {
    return null;
  }
  const parts = value.split("/").filter((part) => part !== "" && part !== ".");
  // Backslashes and control characters never belong in a folder a human
  // typed, and both are the raw material of a path that means one thing here
  // and another to the filesystem.
  const suspect = (part: string) =>
    part === ".." ||
    part.includes("\\") ||
    [...part].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
  if (parts.some(suspect)) {
    return null;
  }
  // No parts left means the home folder itself, which is a legitimate choice.
  return parts.join("/");
}

/** Validate a value read from the store; null when it is not a trigger. */
export function parseTrigger(value: unknown): RoutineTrigger | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "file" || typeof raw.folder !== "string") {
    return null;
  }
  const folder = normalizeFolder(raw.folder);
  return folder === null ? null : { kind: "file", folder };
}

/** Human line for the routine list, e.g. "When a file arrives in inbox". */
export function describeTrigger(trigger: RoutineTrigger): string {
  return trigger.folder === ""
    ? "When a file arrives in the home folder"
    : `When a file arrives in ${trigger.folder}`;
}

/**
 * Fold one folder listing against the previous one.
 *
 * `seen` is what the routine should remember; `arrived` is what it should fire
 * about. Rules, all of them load-bearing:
 *
 * - No previous listing means this is the first poll: arm, fire nothing. A
 *   routine switched on beside a full folder must not immediately fire about
 *   files that were already there.
 * - Directories are not arrivals — a folder appearing is not a delivery, and
 *   the Blob cannot read one anyway.
 * - Deletions prune `seen`, so a file removed and delivered again is new
 *   again, which is what "a file arrived" means to the person watching.
 * - At most `MAX_ARRIVALS_PER_FIRE` names per fire; the remainder stay out of
 *   `seen` so the next tick picks them up.
 */
export function newlyArrived(
  previous: readonly string[] | undefined,
  entries: readonly TriggerEntry[],
): { seen: string[]; arrived: string[] } {
  const files = entries
    .filter((entry) => !entry.isDir && typeof entry.name === "string" && entry.name !== "")
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_TRACKED_FILES);
  // Junk in the store (hand-edited, or an older version) reads as "never
  // polled": arm quietly rather than firing about a folder full of history.
  const known = Array.isArray(previous)
    ? previous.filter((name): name is string => typeof name === "string")
    : undefined;
  if (known === undefined) {
    return { seen: files, arrived: [] };
  }
  const before = new Set(known);
  const arrived = files.filter((name) => !before.has(name)).slice(0, MAX_ARRIVALS_PER_FIRE);
  const reported = new Set(arrived);
  return {
    seen: files.filter((name) => before.has(name) || reported.has(name)),
    arrived,
  };
}
