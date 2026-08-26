import { describe, expect, it } from "vitest";
import { activityForTool, activityLabel } from "@/lib/activity";

describe("activityForTool", () => {
  it("names the tools whose work has an everyday word", () => {
    expect(activityForTool("web_search")).toBe("searching");
    expect(activityForTool("read_file")).toBe("reading");
  });

  it("falls back to working for anything else", () => {
    expect(activityForTool("GMAIL_FETCH_EMAILS")).toBe("working");
  });
});

describe("activityLabel", () => {
  it("is present tense and unfinished", () => {
    expect(activityLabel("searching")).toBe("Searching\u2026");
  });
});
