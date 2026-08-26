/**
 * Teach by demonstration: record yourself doing something once, and let the
 * Blob write down how it is done.
 *
 * A recording is a strip of screen frames, not a video. Blobbies' vision path
 * takes images — a local model cannot read an MP4 — and frames reuse
 * `capture.rs` wholesale: the same OS consent gate, the same downscale, the
 * same home-folder budget, the same always-visible transcript entry. So this
 * file adds no new reach at all; it schedules captures the user already
 * consented to and decides when to stop.
 *
 * The state machine lives here, apart from React, because the rules that keep
 * it honest are the testable part: one recording at a time across the whole
 * app, a hard duration cap that stops and saves rather than running forever,
 * and a frame budget so a long demonstration cannot fill the home folder.
 */

export type TeachPhase = "idle" | "recording";

export interface TeachState {
  phase: TeachPhase;
  /** Which Blob is being taught; absent when idle. */
  blobId?: string;
  startedAt: number;
  /** Frame file names captured so far, in order. */
  frames: string[];
}

/** How often a frame is taken. Slow enough to be cheap, fast enough to follow. */
export const FRAME_INTERVAL_MS = 2_000;

/**
 * Hard stop. A recording that outlives the person who started it is the real
 * failure here, so reaching this saves what it has rather than discarding it —
 * an auto-stop that threw the demonstration away would be worse than useless.
 */
export const MAX_DURATION_MS = 5 * 60_000;

/**
 * Frame ceiling, sized to the cap above with room to spare. Belt and braces:
 * if a timer ever fired faster than intended, the home budget is still safe.
 */
export const MAX_FRAMES = Math.ceil(MAX_DURATION_MS / FRAME_INTERVAL_MS) + 10;

export const IDLE: TeachState = { phase: "idle", startedAt: 0, frames: [] };

/** Where one recording's frames live inside the Blob's home. */
export function frameName(index: number): string {
  return `demonstrations/frame-${String(index + 1).padStart(3, "0")}.png`;
}

/** "0:07" / "4:59" — elapsed time for the recording pill. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Begin recording, or refuse.
 *
 * One recording at a time across the whole app: a second arm returns the state
 * unchanged rather than replacing it, because the pill shows one timer and
 * silently switching what it refers to would be a lie about what is on screen.
 */
export function start(current: TeachState, blobId: string, now: number): TeachState {
  if (current.phase === "recording") {
    return current;
  }
  return { phase: "recording", blobId, startedAt: now, frames: [] };
}

/** Record one captured frame, ignoring anything past the budget. */
export function addFrame(current: TeachState, name: string): TeachState {
  if (current.phase !== "recording" || current.frames.length >= MAX_FRAMES) {
    return current;
  }
  return { ...current, frames: [...current.frames, name] };
}

/** Whether the hard duration cap has been reached. */
export function expired(current: TeachState, now: number): boolean {
  return current.phase === "recording" && now - current.startedAt >= MAX_DURATION_MS;
}

/** Whether another frame may still be taken. */
export function canCapture(current: TeachState, now: number): boolean {
  return (
    current.phase === "recording" && current.frames.length < MAX_FRAMES && !expired(current, now)
  );
}

/**
 * Finish a recording. `saved` carries the frames to learn from; discarding, or
 * stopping before any frame was taken, yields nothing to hand to the Blob.
 */
export function stop(
  current: TeachState,
  outcome: "save" | "discard",
): { state: TeachState; saved: { blobId: string; frames: string[] } | undefined } {
  if (current.phase !== "recording") {
    return { state: IDLE, saved: undefined };
  }
  const saved =
    outcome === "save" && current.frames.length > 0 && current.blobId !== undefined
      ? { blobId: current.blobId, frames: [...current.frames] }
      : undefined;
  return { state: IDLE, saved };
}

/**
 * The managed instruction that turns a demonstration into a skill.
 *
 * Frame names only, exactly like a file trigger: the pictures reach the model
 * as image blocks the app attaches, so nothing here carries content the user
 * did not knowingly record.
 */
export function demonstrationPrompt(frames: readonly string[]): string {
  return (
    `I just recorded a demonstration of a task — ${frames.length} screenshots ` +
    `taken every ${Math.round(FRAME_INTERVAL_MS / 1000)} seconds, in order, ` +
    `saved as ${frames[0]} through ${frames[frames.length - 1]}.\n\n` +
    "Look at the frames in order and work out what I was doing. Then call " +
    "save_skill with a short name, a description saying when to use it, and " +
    "a body giving the steps you would follow to do it yourself. Describe " +
    "what you actually saw — if the frames are unclear, say so and ask me " +
    "rather than inventing steps."
  );
}
