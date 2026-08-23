import { describe, expect, it } from "vitest";
import { matchWindow, type WindowInfo } from "@/lib/screenshot";

/**
 * Which window gets photographed.
 *
 * The rest of the tool is I/O — a Tauri command and an OCR call, both covered
 * where they live. This is the part that turns a model's guess at a name into
 * a picture of something, and capturing the wrong window is not a wrong answer
 * but the user's other app on screen.
 */

const windows: WindowInfo[] = [
  { id: 1, app: "Safari", title: "Hacker News" },
  { id: 2, app: "Notes", title: "Safari bookmarks to sort" },
  { id: 3, app: "Figma", title: "" },
  { id: 4, app: "Visual Studio Code", title: "App.tsx" },
];

describe("matchWindow", () => {
  it("prefers the app actually named over one merely mentioning it", () => {
    // "Safari" must not photograph the Notes window whose title says Safari.
    expect(matchWindow(windows, "Safari")?.id).toBe(1);
  });

  it("ignores case and surrounding space, as a model will produce both", () => {
    expect(matchWindow(windows, "  figma ")?.id).toBe(3);
  });

  it("matches an exact window title", () => {
    expect(matchWindow(windows, "Hacker News")?.id).toBe(1);
  });

  it("falls back to a partial name, which is how people refer to apps", () => {
    expect(matchWindow(windows, "code")?.id).toBe(4);
  });

  it("is undefined when nothing matches, rather than guessing", () => {
    // The caller turns this into a list of real windows for the model to pick
    // from. Returning "close enough" here would capture the wrong screen.
    expect(matchWindow(windows, "Photoshop")).toBeUndefined();
  });

  it("is undefined for an empty phrase, which means the whole screen", () => {
    expect(matchWindow(windows, "   ")).toBeUndefined();
  });
});
