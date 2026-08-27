import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { FRAME_INTERVAL_MS, MAX_DURATION_MS } from "@/lib/teach";

/** Every turn App asked for, so a test can read what it actually sent. */
let turns: { messages: { role: string; content: unknown }[] }[] = [];

vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  streamBlobTurn: vi.fn((options: { messages: { role: string; content: unknown }[] }) => {
    turns.push(options);
    return Promise.resolve("Learned it.");
  }),
}));

// The frames only reach the model when the selected model can see pictures;
// otherwise App sends the prompt as plain text (`src/App.tsx:1958`). The real
// check probes Ollama over HTTP, which is not this file's subject.
vi.mock("@/lib/model-vision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/model-vision")>()),
  modelSeesImages: vi.fn(() => Promise.resolve(true)),
}));

/** The image parts of the last turn's final user message. */
function sentImages(): { type: string; mediaType?: string; data?: string }[] {
  const last = turns[turns.length - 1];
  const content = last?.messages[last.messages.length - 1]?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return (content as { type: string; mediaType?: string; data?: string }[]).filter(
    (part) => part.type === "image",
  );
}

/**
 * Advance fake timers one frame at a time, each inside its own act() scope.
 *
 * The recorder ticks once per `FRAME_INTERVAL_MS` and re-renders the elapsed
 * pill each time, so advancing the clock drives React state from a timer
 * callback rather than an event handler. Without a scope React warns on every
 * one of those updates — 455 of them for the cap test alone, which advances a
 * full `MAX_DURATION_MS`.
 *
 * Stepping matters as much as the scope. Each tick fires `capture_take` and
 * appends the resolved frame, and the effect re-arms on the resulting state
 * change (`src/App.tsx:2652`). Advancing the whole span in one act() batches
 * those updates to the end, so no frame ever lands and the cap saves an empty
 * recording — `teach.stop` returns nothing to save when `frames` is empty.
 * A scope per frame reproduces what the real clock does.
 */
async function advanceWithin(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += FRAME_INTERVAL_MS) {
    const step = Math.min(FRAME_INTERVAL_MS, ms - elapsed);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
  }
}

/**
 * Teach by demonstration, end to end through the real app.
 *
 * `isTauri()` and `invoke` both read `window.__TAURI_INTERNALS__`, so standing
 * one up is what makes the desktop-only recorder reachable here — and it also
 * records every command the app fires, which is how these tests prove that a
 * discarded recording sends nothing.
 */
interface Call {
  command: string;
  args: Record<string, unknown>;
}

function installTauri(): Call[] {
  const calls: Call[] = [];
  const internals = {
    invoke: (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      switch (command) {
        case "capture_take":
          return Promise.resolve({
            name: String(args.name),
            path: `/home/${String(args.name)}`,
            // A one-pixel PNG: real base64, small enough to keep in a test.
            png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          });
        case "skills_list":
          return Promise.resolve([]);
        // An empty store, answering the shape the real backend answers with:
        // `null` for a key never written, nothing for a write — except the
        // settings slice, which carries the model a turn needs to run at all.
        case "store_read":
          return Promise.resolve(
            args.key === "settings"
              ? { userName: "Ken Kai", theme: "light", model: "llama3.2:latest", plugins: [] }
              : null,
          );
        case "store_write":
          return Promise.resolve();
        default:
          // Nothing else is under test here, and every other caller already
          // copes with a backend that says no.
          return Promise.reject(new Error(`no stub for ${command}`));
      }
    },
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
  return calls;
}

beforeEach(() => {
  turns = [];
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.useRealTimers();
});

/** First-run creator, then open a Blob's chat pane. */
async function createBlob(user: UserEvent, name = "Ken") {
  await user.type(screen.getByLabelText("Name"), name);
  await user.click(screen.getByRole("button", { name: "Get started" }));
}

describe("teach by demonstration", () => {
  it("shows a pill for every second it records, then learns on save", async () => {
    const calls = installTauri();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await createBlob(user, "Ken");

    // Nothing is recording, so nothing claims to be.
    expect(screen.queryByRole("status", { name: "" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Recording for/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Teach Ken by demonstration" }));

    // The pill names the Blob and offers both ways out, from the first frame.
    const pill = await screen.findByText(/Recording for Ken/);
    expect(pill).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop & save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    // A second recording cannot be armed while this one runs.
    expect(screen.getByRole("button", { name: "Teach Ken by demonstration" })).toBeDisabled();

    await advanceWithin(FRAME_INTERVAL_MS * 2 + 100);
    await waitFor(() =>
      expect(calls.filter((call) => call.command === "capture_take").length).toBeGreaterThan(0),
    );
    // Frames land in the Blob's own home folder, under a contained name.
    const frame = calls.find((call) => call.command === "capture_take");
    expect(frame?.args.name).toMatch(/^demonstrations\/frame-\d{3}\.png$/);

    await user.click(screen.getByRole("button", { name: "Stop & save" }));

    // The recording is visible in the transcript, and the pill is gone.
    expect(await screen.findByText(/Demonstration recorded/)).toBeInTheDocument();
    expect(screen.queryByText(/Recording for/)).toBeNull();
  });

  it("sends the recorded frames to the model, not just their names", async () => {
    // The gap this closes: every other assertion here is satisfied by the
    // *names* of the frames — the capture_take calls, the transcript line, the
    // pill. None of them notices if the captured PNG bytes are dropped on the
    // way to the turn, which is the one thing a demonstration is for. A model
    // handed six filenames and no pictures learns nothing.
    const calls = installTauri();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await createBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Teach Ken by demonstration" }));
    await advanceWithin(FRAME_INTERVAL_MS * 3 + 100);
    await user.click(screen.getByRole("button", { name: "Stop & save" }));

    await waitFor(() => expect(turns.length).toBeGreaterThan(0));
    const images = sentImages();
    expect(images.length).toBeGreaterThan(0);
    // Real bytes, not a placeholder: the one-pixel PNG the capture stub hands
    // back has to survive the whole path into the payload.
    expect(images[0]?.mediaType).toBe("image/png");
    expect(images[0]?.data).toMatch(/^iVBORw0KGgo/);
    // One image part per frame the recorder captured.
    const captured = calls.filter((call) => call.command === "capture_take").length;
    expect(images).toHaveLength(captured);
  });

  it("writes nothing at all when the recording is discarded", async () => {
    installTauri();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await createBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Teach Ken by demonstration" }));
    await advanceWithin(FRAME_INTERVAL_MS + 100);
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.queryByText(/Recording for/)).toBeNull();
    // No event line, so no turn: a discarded demonstration teaches nothing.
    expect(screen.queryByText(/Demonstration recorded/)).toBeNull();
    // And the entry is armed again.
    expect(screen.getByRole("button", { name: "Teach Ken by demonstration" })).toBeEnabled();
  });

  it("stops itself at the cap rather than recording forever", async () => {
    installTauri();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await createBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Teach Ken by demonstration" }));
    await advanceWithin(MAX_DURATION_MS + FRAME_INTERVAL_MS);

    await waitFor(() => expect(screen.queryByText(/Recording for/)).toBeNull());
    // The cap SAVES: throwing away what someone just performed would be worse
    // than not stopping at all.
    expect(await screen.findByText(/Demonstration recorded/)).toBeInTheDocument();
  });

  it("hides the entry entirely where recording is impossible", async () => {
    // No Tauri internals: a web build has no capture and no skills folder, so
    // an entry that could never work is not offered at all.
    const user = userEvent.setup();
    render(<App />);
    await createBlob(user, "Ken");
    expect(screen.queryByRole("button", { name: /Teach Ken/ })).toBeNull();
  });

  it("keeps the pill while the user switches conversation", async () => {
    installTauri();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await createBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Teach Ken by demonstration" }));
    expect(await screen.findByText(/Recording for Ken/)).toBeInTheDocument();

    // Recording is app-wide, not a property of the open pane: navigating away
    // must not hide the one thing telling the user their screen is captured.
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.queryByRole("button", { name: /Teach Ken/ })).toBeNull();
    expect(screen.getByText(/Recording for Ken/)).toBeInTheDocument();
  });
});
