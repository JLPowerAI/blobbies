import { describe, expect, it } from "vitest";
import { formatAgentTime } from "@/lib/time";

describe("formatAgentTime", () => {
  // Fixed reference: a Wednesday afternoon.
  const now = new Date(2026, 7, 12, 15, 0, 0).getTime();

  it("shows Now within the first minute", () => {
    expect(formatAgentTime(now - 30_000, now)).toBe("Now");
  });

  it("shows a clock time for earlier today", () => {
    const at = new Date(2026, 7, 12, 9, 5).getTime();
    expect(formatAgentTime(at, now)).toMatch(/9[:.]05/);
  });

  it("shows Yesterday for the previous day", () => {
    const at = new Date(2026, 7, 11, 23, 30).getTime();
    expect(formatAgentTime(at, now)).toBe("Yesterday");
  });

  it("shows a weekday within the last week", () => {
    const at = new Date(2026, 7, 8, 12, 0).getTime(); // Saturday, 4 days back
    expect(formatAgentTime(at, now)).toBe(
      new Date(at).toLocaleDateString(undefined, { weekday: "short" }),
    );
  });

  it("shows a date beyond a week", () => {
    const at = new Date(2026, 6, 1, 12, 0).getTime();
    expect(formatAgentTime(at, now)).toMatch(/\d/);
    expect(formatAgentTime(at, now)).not.toBe("Yesterday");
  });
});
