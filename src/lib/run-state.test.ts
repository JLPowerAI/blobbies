import { describe, expect, it } from "vitest";
import { type ActiveRun, assertTransition, isTerminal, parseRun } from "@/lib/run-state";

describe("run transitions", () => {
  it("allows the documented lifecycle", () => {
    expect(assertTransition("queued", "running")).toBe("running");
    expect(assertTransition("running", "waiting_input")).toBe("waiting_input");
    expect(assertTransition("waiting_input", "running")).toBe("running");
    expect(assertTransition("running", "done")).toBe("done");
    expect(assertTransition("running", "failed")).toBe("failed");
    expect(assertTransition("waiting_input", "cancelled")).toBe("cancelled");
  });

  it("throws on illegal jumps so state bugs surface loudly", () => {
    expect(() => assertTransition("done", "running")).toThrow(/Illegal run transition/);
    expect(() => assertTransition("queued", "waiting_input")).toThrow(/Illegal run transition/);
    expect(() => assertTransition("cancelled", "done")).toThrow(/Illegal run transition/);
  });

  it("terminal states are exactly done/failed/cancelled", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("waiting_input")).toBe(false);
    expect(isTerminal("queued")).toBe(false);
  });
});

describe("parseRun", () => {
  const run: ActiveRun = {
    id: "run-1",
    blobId: "b1",
    trigger: "routine",
    prompt: "check the news",
    startedAt: 123,
    status: "waiting_input",
  };

  it("round-trips a valid record", () => {
    expect(parseRun(run)).toEqual(run);
  });

  it("keeps token counts, and loads runs stored before they existed", () => {
    // `run` above has neither field — records written by an older build must
    // still load rather than vanish from the sidebar.
    const counted = { ...run, inputTokens: 1200, outputTokens: 340 };
    expect(parseRun(counted)).toEqual(counted);
  });

  it("rejects malformed store values", () => {
    for (const value of [
      null,
      "run",
      { ...run, status: "exploded" },
      { ...run, trigger: "cron" },
      { ...run, startedAt: "yesterday" },
      { id: "x" },
    ]) {
      expect(parseRun(value)).toBeNull();
    }
  });
});
