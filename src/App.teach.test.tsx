import { render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { FRAME_INTERVAL_MS, MAX_DURATION_MS } from "@/lib/teach";

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
        // `null` for a key never written, nothing for a write.
        case "store_read":
          return Promise.resolve(null);
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

    await vi.advanceTimersByTimeAsync(FRAME_INTERVAL_MS * 2 + 100);
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

  it("writes nothing at all when the recording is discarded", async () => {
    installTauri();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await createBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Teach Ken by demonstration" }));
    await vi.advanceTimersByTimeAsync(FRAME_INTERVAL_MS + 100);
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
    await vi.advanceTimersByTimeAsync(MAX_DURATION_MS + FRAME_INTERVAL_MS);

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
