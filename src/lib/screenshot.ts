/**
 * Letting a Blob look at something on screen — a web page, an app window, or
 * the whole display.
 *
 * The interesting part is not the capture (that is `capture.rs`); it is what
 * happens to the picture afterwards, which depends entirely on the model:
 *
 * - **A vision model gets the image.** It is sent as a real image block, which
 *   is the only way a chart, a layout or a screenshot of a broken UI survives
 *   the trip.
 * - **A text-only model gets OCR text**, through the same on-device engine
 *   that reads attached images, plus a line saying what it is looking at.
 *
 * Sending an image to a text-only model is not a degraded experience, it is a
 * rejected request — so `modelSeesImages` decides, and it fails closed.
 *
 * Capture reach and its limits are documented on the Rust side; the short
 * version is that macOS Screen Recording consent is the real gate, and every
 * capture appears in the transcript so it cannot happen quietly.
 */
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { z } from "zod";
import { modelSeesImages } from "@/lib/model-vision";
import { ocrImage } from "@/lib/ocr";
import { isTauri } from "@/lib/tauri";
import { wrapUntrusted } from "@/lib/untrusted";

/** One window offered to the model for discovery. */
export interface WindowInfo {
  id: number;
  app: string;
  title: string;
}

/** A finished capture, as it crosses back from Rust. */
export interface Capture {
  name: string;
  /** Absolute path to the saved PNG, for revealing it on click. */
  path: string;
  /** Base64 PNG — a picture is not UTF-8, so it cannot ride the text path. */
  png: string;
  width: number;
  height: number;
}

/**
 * Whether this build can capture at all.
 *
 * Desktop only, and not Linux: capture there would mean shipping pipewire as a
 * system requirement for every user (see `src-tauri/Cargo.toml`), so those
 * builds leave it out and the commands report themselves unsupported. Telling
 * a model about a tool it cannot call is the misfire the prompt's tool list
 * exists to avoid, so the same answer gates both the catalog and the prompt.
 */
export function canCapture(): boolean {
  return isTauri() && !navigator.userAgent.includes("Linux");
}

/** How much OCR text one capture may return to a text-only model. */
const OCR_LIMIT = 6_000;

/**
 * Longest window list handed to a model. A busy Mac has hundreds of windows;
 * the whole list would crowd out the conversation to no purpose.
 */
const MAX_WINDOWS = 40;

/**
 * Pick the window a phrase refers to.
 *
 * Exact app name first, then a case-insensitive substring of app or title, so
 * "Safari" beats a window merely mentioning Safari in its title. Exported for
 * its own test: this is the part that decides what gets photographed, and
 * quietly matching the wrong window is the failure that matters here.
 */
export function matchWindow(windows: WindowInfo[], phrase: string): WindowInfo | undefined {
  const wanted = phrase.trim().toLowerCase();
  if (wanted === "") {
    return undefined;
  }
  return (
    windows.find((window) => window.app.toLowerCase() === wanted) ??
    windows.find((window) => window.title.toLowerCase() === wanted) ??
    windows.find(
      (window) =>
        window.app.toLowerCase().includes(wanted) || window.title.toLowerCase().includes(wanted),
    )
  );
}

/** "Safari — Hacker News" / "Safari" when the window has no title. */
function describeWindow(window: WindowInfo): string {
  return window.title === "" ? window.app : `${window.app} — ${window.title}`;
}

/**
 * The `take_screenshot` tool, plus the hook the UI uses to show the picture.
 *
 * `onCapture` is called with every successful capture so the caller can put it
 * in the transcript. That is not a display nicety: a capture the user cannot
 * see is the one thing this feature must never do.
 */
export function makeScreenshotTool(options: {
  blobId?: string;
  model: string;
  onCapture: (capture: Capture, caption: string) => void;
}): AgentTool {
  const parameters = z.object({
    target: z
      .string()
      .optional()
      .describe(
        'Which window to capture, by app or title, e.g. "Safari" or "Figma". ' +
          "Omit to capture the whole screen.",
      ),
  });
  const tool: AgentTool<typeof parameters> = {
    name: "take_screenshot",
    description:
      "Look at what is on the user's screen right now — a web page, an app " +
      "window, or the whole display. Use when the user refers to something " +
      "they can see ('what does this error say', 'is this layout right') " +
      "rather than something you could fetch or read from a file. Name the " +
      "app to capture just its window; omit the name for the whole screen. " +
      "The user sees every screenshot you take.",
    parameters,
    // Sequential: each capture writes a file into the home folder, and two
    // running at once would race on both the name and the home size budget.
    executionMode: "sequential",
    execute: async (args) => {
      if (!canCapture()) {
        return "Screenshots aren't available in this build — tell the user what you were about to look at and ask them to describe it.";
      }
      const { invoke } = await import("@tauri-apps/api/core");
      let target: WindowInfo | undefined;
      if (args.target !== undefined && args.target.trim() !== "") {
        let windows: WindowInfo[];
        try {
          windows = await invoke<WindowInfo[]>("capture_list_windows");
        } catch (error) {
          return describeError(error);
        }
        target = matchWindow(windows, args.target);
        if (target === undefined) {
          // The model guessed a name; give it the real list rather than a
          // dead end, so it can retry in the same turn.
          const options = windows
            .slice(0, MAX_WINDOWS)
            .map((window) => `- ${describeWindow(window)}`)
            .join("\n");
          return options === ""
            ? "No windows are open to capture. macOS needs Screen Recording access for this app before it can see any window (System Settings → Privacy & Security → Screen Recording)."
            : `No window matches "${args.target}". Open windows:\n${options}`;
        }
      }

      // Named by content, not by a counter: two captures of the same window in
      // one conversation should overwrite rather than accumulate, and the home
      // folder has a size budget to respect.
      const name = `screenshots/${slug(target === undefined ? "screen" : target.app)}.png`;
      let capture: Capture;
      try {
        capture = await invoke<Capture>("capture_take", {
          id: options.blobId ?? null,
          name,
          windowId: target?.id ?? null,
        });
      } catch (error) {
        return describeError(error);
      }

      const caption = target === undefined ? "Screen" : describeWindow(target);
      options.onCapture(capture, caption);

      // A vision model reads the picture; a text-only one would reject the
      // request outright, so it gets the text instead.
      if (await modelSeesImages(options.model)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Screenshot of ${caption}, saved as ${capture.name}.`,
            },
            { type: "image" as const, mediaType: "image/png", data: capture.png },
          ],
        };
      }
      let text: string;
      try {
        text = await ocrImage(decodePng(capture.png));
      } catch (error) {
        return `Captured ${caption} (saved as ${capture.name}), but its text could not be read (${describeError(error)}). Tell the user what you captured and ask them what it says.`;
      }
      if (text.trim() === "") {
        return `Captured ${caption}, saved as ${capture.name}. No readable text was found in it, so there is nothing to quote — say what you captured rather than guessing at its contents.`;
      }
      const clipped = text.length > OCR_LIMIT ? `${text.slice(0, OCR_LIMIT)}\n[truncated]` : text;
      // Whatever is on screen is not the user talking: a web page, someone
      // else's email, a chat window. Same containment as fetched page text.
      return `Screenshot of ${caption}, saved as ${capture.name}. Text read from it:\n${wrapUntrusted(clipped, caption)}`;
    },
  };
  return tool;
}

/** Base64 PNG back to bytes, for the OCR engine. */
function decodePng(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** A file name safe for the home sandbox, whatever the window is called. */
function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "window" : cleaned.slice(0, 40);
}

function describeError(error: unknown): string {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "The screenshot failed.";
}
