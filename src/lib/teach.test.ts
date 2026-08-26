import { describe, expect, it } from "vitest";
import {
  addFrame,
  canCapture,
  demonstrationPrompt,
  expired,
  formatElapsed,
  frameName,
  IDLE,
  MAX_DURATION_MS,
  MAX_FRAMES,
  start,
  stop,
} from "@/lib/teach";

/** A recording with `count` frames already taken, started at t=0. */
function recording(count: number) {
  let state = start(IDLE, "b1", 0);
  for (let index = 0; index < count; index++) {
    state = addFrame(state, frameName(index));
  }
  return state;
}

describe("start", () => {
  it("refuses a second recording while one is running", () => {
    // One pill, one timer: silently re-pointing it at another Blob would be a
    // lie about what is being recorded.
    const first = start(IDLE, "b1", 1_000);
    const second = start(first, "b2", 2_000);
    expect(second).toBe(first);
    expect(second.blobId).toBe("b1");
  });

  it("starts again once the first one stopped", () => {
    const { state } = stop(start(IDLE, "b1", 0), "discard");
    expect(start(state, "b2", 5_000).blobId).toBe("b2");
  });
});

describe("stop", () => {
  it("hands over the frames on save", () => {
    const { state, saved } = stop(recording(3), "save");
    expect(saved).toEqual({ blobId: "b1", frames: [frameName(0), frameName(1), frameName(2)] });
    expect(state).toEqual(IDLE);
  });

  it("writes nothing on discard", () => {
    const { state, saved } = stop(recording(3), "discard");
    expect(saved).toBeUndefined();
    expect(state).toEqual(IDLE);
  });

  it("has nothing to learn from when no frame was captured", () => {
    expect(stop(recording(0), "save").saved).toBeUndefined();
  });
});

describe("the duration cap", () => {
  it("expires exactly at the cap, so the recording stops and saves itself", () => {
    const state = recording(2);
    expect(expired(state, MAX_DURATION_MS - 1)).toBe(false);
    expect(expired(state, MAX_DURATION_MS)).toBe(true);
    // Auto-stop saves: throwing away the demonstration someone just performed
    // would be worse than not stopping at all.
    expect(stop(state, "save").saved?.frames).toHaveLength(2);
  });

  it("takes no further frames once expired", () => {
    expect(canCapture(recording(1), MAX_DURATION_MS)).toBe(false);
    expect(canCapture(recording(1), 1_000)).toBe(true);
  });

  it("never expires while idle", () => {
    expect(expired(IDLE, MAX_DURATION_MS * 10)).toBe(false);
    expect(canCapture(IDLE, 0)).toBe(false);
  });
});

describe("the frame budget", () => {
  it("stops accepting frames at the ceiling", () => {
    const full = recording(MAX_FRAMES + 5);
    expect(full.frames).toHaveLength(MAX_FRAMES);
    expect(canCapture(full, 1_000)).toBe(false);
  });

  it("ignores a frame arriving after the stop", () => {
    const { state } = stop(recording(1), "save");
    expect(addFrame(state, frameName(9)).frames).toEqual([]);
  });
});

describe("formatElapsed", () => {
  it("reads as a stopwatch", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_400)).toBe("0:07");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(MAX_DURATION_MS)).toBe("5:00");
    // A clock that ran backwards would render "-1:-1" rather than clamp.
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});

describe("frameName", () => {
  it("names frames so they sort in the order they were taken", () => {
    const names = [frameName(0), frameName(8), frameName(9), frameName(99)];
    expect([...names].sort()).toEqual(names);
    expect(names[0]).toBe("demonstrations/frame-001.png");
  });
});

describe("demonstrationPrompt", () => {
  it("names the frames and asks for a skill, without inventing content", () => {
    const prompt = demonstrationPrompt([frameName(0), frameName(1)]);
    expect(prompt).toContain("demonstrations/frame-001.png");
    expect(prompt).toContain("demonstrations/frame-002.png");
    expect(prompt).toContain("save_skill");
    expect(prompt).toContain("rather than inventing steps");
  });
});
