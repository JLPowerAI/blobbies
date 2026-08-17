// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { streamBlobTurn as StreamBlobTurn } from "@/lib/ai";
import type { SchedulerHost } from "@/lib/scheduler";
import type { Settings } from "@/lib/store";

/**
 * The wiring around a turn: what App feeds into one, and what it does with
 * the result. `streamBlobTurn` is mocked, so a turn is a scripted outcome
 * rather than a model call.
 *
 * Everything here is only reachable *through* App, which is the point — the
 * unit tests cover each piece against fakes, and these cover the seams where
 * the real pieces meet:
 *   - roster tools driven against App's own `RosterAccess`, not a stub;
 *   - token accounting across an ask, the one place a run spans two turns;
 *   - Settings edits (instructions, memory scope) landing in the next
 *     turn's system prompt;
 *   - two roster writes inside one turn composing instead of clobbering;
 *   - a turn fired by the scheduler rather than by typing, which runs a
 *     different closure and so can read entirely different values.
 */

type TurnOptions = Parameters<typeof StreamBlobTurn>[0];

/** Scripted turns, consumed in order by the mocked streamBlobTurn. */
let script: ((options: TurnOptions) => Promise<string> | string)[] = [];
/** Every turn's options, so a test can assert what App passed in. */
let calls: TurnOptions[] = [];

vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  streamBlobTurn: vi.fn(async (options: TurnOptions) => {
    calls.push(options);
    const next = script.shift();
    return next === undefined ? "" : await next(options);
  }),
}));

const notify = vi.fn(async () => {});
vi.mock("@/lib/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify")>()),
  notify: (...args: unknown[]) => notify(...(args as [])),
}));

/**
 * The live scheduler host, captured at mount.
 *
 * The scheduler is started in a mount-once effect, so anything it calls runs
 * the *mount-render* closure. Firing through this host is the only way to
 * reach the code path a scheduled routine actually takes.
 */
let schedulerHost: SchedulerHost | null = null;
vi.mock("@/lib/scheduler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scheduler")>()),
  startScheduler: (host: SchedulerHost) => {
    schedulerHost = host;
    return () => {};
  },
}));

const { App } = await import("@/App");
const store = await import("@/lib/store");
const { makeRosterTools } = await import("@/lib/blob-tools");

const toolContext = { signal: new AbortController().signal, toolCallId: "t1" };

/**
 * Run a roster tool exactly as a routine turn would.
 *
 * Deliberately the REAL `makeRosterTools` against the REAL `RosterAccess`
 * App built — blob-tools.test.ts already covers the refusals against a fake
 * roster, so what is left to prove is that App's implementation actually
 * creates and deletes Blobs that persist.
 */
async function callRosterTool(name: string, args: Record<string, unknown>) {
  const roster = calls[calls.length - 1]?.roster;
  if (roster === undefined) {
    throw new Error("the turn was not given roster access");
  }
  const tool = makeRosterTools(roster.access, roster.selfName).find(
    (candidate) => candidate.name === name,
  );
  if (tool === undefined) {
    throw new Error(`no such tool: ${name}`);
  }
  return String(await tool.execute(args, toolContext));
}

/**
 * Seed a model, then mount.
 *
 * Without one, `requestReply` short-circuits with "pick one in Settings" and
 * never reaches the turn — so every assertion here would silently pass
 * against a code path that did nothing.
 */
function mountWithModel(extra: Partial<Settings> = {}) {
  store.saveSettings({
    userName: "Ken Kai",
    theme: "light",
    timezone: "Asia/Kuala_Lumpur",
    model: "llama3.2:latest",
    plugins: [],
    ...extra,
  });
  window.dispatchEvent(new Event("beforeunload"));
  render(<App />);
}

async function createFirstBlob(user: UserEvent, name = "Ken") {
  await user.type(screen.getByLabelText("Name"), name);
  await user.click(screen.getByRole("button", { name: "Get started" }));
}

/**
 * Type a message and wait for the turn it triggers.
 *
 * Waits for the call count to *grow*: a bare `> 0` would return instantly on
 * the second call and silently assert against the previous turn.
 */
async function say(user: UserEvent, text: string) {
  const before = calls.length;
  await user.type(screen.getByPlaceholderText("Message Ken"), `${text}{Enter}`);
  await waitFor(() => expect(calls.length).toBeGreaterThan(before));
}

describe("turn wiring", () => {
  beforeEach(() => {
    // Drain writes the previous test left queued, THEN wipe. Without the
    // flush their timers fire into the fresh store, and a leftover roster
    // means the next test never sees the first-run creator.
    window.dispatchEvent(new Event("beforeunload"));
    store.clearFallbackBackend();
    script = [];
    calls = [];
    schedulerHost = null;
    notify.mockClear();
  });

  it("stays silent for a message the user typed and is watching", async () => {
    const user = userEvent.setup();
    script = [() => "Done."];
    mountWithModel();
    await createFirstBlob(user, "Ken");
    await say(user, "hello");

    await waitFor(() => expect(screen.getByText("Done.")).toBeInTheDocument());
    // trigger "user" plus a focused window: two independent reasons not to.
    expect(notify).not.toHaveBeenCalled();
  });

  it("shows each completed speech segment as its own bubble", async () => {
    // A tool-using turn speaks before each tool call, then answers: every
    // segment arrives whole from the turn loop, and each must land as a
    // separate bubble — not one growing message patched in place.
    const segments = [
      "I'll look into that now.",
      "Ah, I've just found something interesting here.",
      "Here's the answer.",
    ];
    script = [
      (options) => {
        for (const segment of segments) {
          options.onSegment?.(segment);
        }
        return segments.join("\n\n");
      },
    ];
    const user = userEvent.setup();
    mountWithModel();
    await createFirstBlob(user, "Ken");
    await say(user, "look into it");

    await waitFor(() => expect(screen.getByText(segments[2] ?? "")).toBeInTheDocument());
    const bubbles = segments.map((segment) => screen.getByText(segment).closest(".bubble"));
    // One distinct bubble per segment, each holding only its own words.
    expect(new Set(bubbles).size).toBe(segments.length);
    for (const [index, bubble] of bubbles.entries()) {
      expect(bubble).toHaveTextContent(segments[index] ?? "");
      for (const other of segments.slice(0, index)) {
        expect(bubble).not.toHaveTextContent(other);
      }
    }
  });

  it("puts an attached file in the Blob's files and fences its text into the prompt", async () => {
    const user = userEvent.setup();
    script = [() => "Read it."];
    mountWithModel();
    await createFirstBlob(user, "Ken");

    await user.upload(screen.getByLabelText("Attach files"), [
      new File(["seat,price\n1,20"], "seats.csv", { type: "text/csv" }),
      // A zip underneath, and not something we can read: refused with a
      // reason, and it must not take the readable file (or the message) down
      // with it.
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00])], "report.docx"),
    ]);
    const before = calls.length;
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));

    expect(screen.getByText(/report.docx wasn't attached/)).toBeInTheDocument();
    const sent = calls[calls.length - 1]?.messages ?? [];
    const latest = String(sent[sent.length - 1]?.content ?? "");
    // The chat catalog has no file tool, so the text has to be inline — and
    // fenced, because a document is data and never an instruction.
    expect(latest).toContain("seat,price");
    expect(latest).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(latest).not.toContain("report.docx");

    // Saved, not just inlined: it shows up in the Blob's files, and opening
    // it shows the text — the only way to check what an extractor actually
    // got out of a PDF or an image.
    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    await waitFor(() =>
      expect(within(details).getByRole("button", { name: "Delete seats.csv" })).toBeInTheDocument(),
    );
    await user.click(within(details).getByRole("button", { name: "Open seats.csv" }));
    await waitFor(() => expect(within(details).getByText(/seat,price/)).toBeInTheDocument());
  });

  it("shows the sent message before its files have been read", async () => {
    const user = userEvent.setup();
    script = [() => "Read it."];
    mountWithModel();
    await createFirstBlob(user, "Ken");

    // Extraction that never settles: a PDF parse or an OCR pass takes seconds,
    // and the user's own message must not wait behind it.
    vi.spyOn(File.prototype, "arrayBuffer").mockReturnValue(new Promise<never>(() => {}));
    try {
      await user.upload(screen.getByLabelText("Attach files"), [
        new File(["seat,price"], "seats.csv", { type: "text/csv" }),
      ]);
      await user.click(screen.getByRole("button", { name: "Send message" }));

      // On screen immediately, with the file it carries and no size yet —
      // there is nothing to report until the read finishes.
      const chip = (await screen.findByText("reading…")).closest(".attachment-card");
      expect(chip).toHaveTextContent("seats.csv");
    } finally {
      // In a finally, or a failed assertion leaves every later test with a
      // File.arrayBuffer that never resolves.
      vi.restoreAllMocks();
    }
  });

  it("accumulates tokens across an ask instead of losing the first leg", async () => {
    const user = userEvent.setup();
    // Leg 1 parks on a question after spending 1000 tokens; the answer turn
    // spends 500 more. The run must end up holding all 1500 — the bug this
    // pins dropped everything before the ask.
    script = [
      (options) => {
        options.onUsage?.({ inputTokens: 900, outputTokens: 100 });
        options.onAsk?.({ question: "Which inbox?", kind: "question" });
        return "Which inbox?";
      },
      (options) => {
        options.onUsage?.({ inputTokens: 400, outputTokens: 100 });
        return "Done.";
      },
    ];
    mountWithModel();
    await createFirstBlob(user, "Ken");
    await say(user, "tidy my mail");
    await waitFor(() => expect(screen.getByText("Which inbox?")).toBeInTheDocument());

    // Answer the question: same run, second turn.
    await say(user, "the work one");
    await waitFor(() => expect(screen.getByText("Done.")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    // 1500 total, rendered as "1.5k", and one run — not two.
    await waitFor(() =>
      expect(within(details).getByText(/1\.5k .* over 1 runs/)).toBeInTheDocument(),
    );
  });

  it("spawn_blob creates a Blob that shows up in the sidebar and survives a reload", async () => {
    const user = userEvent.setup();
    script = [() => "Done."];
    mountWithModel();
    await createFirstBlob(user, "Ken");
    await say(user, "hello");

    expect(
      await callRosterTool("spawn_blob", {
        name: "Filer",
        title: "Files things",
        description: "Keeps the inbox tidy.",
      }),
    ).toBe("Created Filer.");

    // Visible to the user, not just in memory.
    await waitFor(() => expect(screen.getByRole("button", { name: /Filer/ })).toBeInTheDocument());
    // The spawning Blob keeps the view: a routine runs in the background and
    // must not yank the user out of the conversation they are reading.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ken");

    // Persisted immediately — the new id is referenced the moment the tool
    // returns, so this write cannot sit in the debounce queue.
    const filer = (await store.loadRoster())?.find((blob) => blob.name === "Filer");
    expect(filer?.title).toBe("Files things");
    // A real id, so the scheduler and per-Blob slices can address it.
    expect(filer?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a spawn mid-turn does not discard that turn's own token count", async () => {
    const user = userEvent.setup();
    // Both roster writes land inside one turn: spawn_blob while the turn is
    // running, then the usage patch when it settles. They must compose —
    // whichever writes second must build on the first, not on a stale copy.
    script = [
      async (options) => {
        await callRosterTool("spawn_blob", { name: "Filer", title: "t", description: "d" });
        options.onUsage?.({ inputTokens: 900, outputTokens: 100 });
        return "Done.";
      },
    ];
    mountWithModel();
    await createFirstBlob(user, "Ken");
    await say(user, "spawn me a filer");
    await waitFor(() => expect(screen.getByText("Done.")).toBeInTheDocument());

    // The spawned Blob survived the usage write...
    await waitFor(() => expect(screen.getByRole("button", { name: /Filer/ })).toBeInTheDocument());
    expect((await store.loadRoster())?.map((blob) => blob.name)).toContain("Filer");

    // ...and the usage write survived the spawn. Matches the lifetime tail
    // only: the "this run" prefix is a separate concern, tested above.
    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    await waitFor(() => expect(within(details).getByText(/1\.0k over 1 runs/)).toBeInTheDocument());
  });

  it("refuses a duplicate spawn, so a retried tool call cannot double the roster", async () => {
    const user = userEvent.setup();
    script = [() => "Done."];
    mountWithModel();
    await createFirstBlob(user, "Ken");
    await say(user, "hello");

    const args = { name: "Filer", title: "t", description: "d" };
    expect(await callRosterTool("spawn_blob", args)).toBe("Created Filer.");
    // Same call again, as a retry would: refused, and the roster is unchanged.
    expect(await callRosterTool("spawn_blob", args)).toContain("already exists");
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Filer/ })).toHaveLength(1));
    expect((await store.loadRoster())?.filter((blob) => blob.name === "Filer")).toHaveLength(1);

    // And still refused a whole turn later, after many renders have gone by:
    // the roster the tools read must never be walked backwards by a render.
    script = [() => "Done again."];
    await say(user, "again");
    await waitFor(() => expect(screen.getByText("Done again.")).toBeInTheDocument());
    expect(await callRosterTool("spawn_blob", args)).toContain("already exists");
    expect((await store.loadRoster())?.filter((blob) => blob.name === "Filer")).toHaveLength(1);
  });

  it("delete_blob removes another Blob but never the caller", async () => {
    const user = userEvent.setup();
    script = [() => "Done."];
    mountWithModel();
    await createFirstBlob(user, "Ken");
    await say(user, "hello");
    await callRosterTool("spawn_blob", { name: "Filer", title: "t", description: "d" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Filer/ })).toBeInTheDocument());

    // Self-deletion would leave the running turn with no Blob to reply as.
    expect(await callRosterTool("delete_blob", { name: "Ken", confirm_name: "Ken" })).toBe(
      "You cannot delete yourself.",
    );
    expect((await store.loadRoster())?.map((blob) => blob.name)).toContain("Ken");

    expect(await callRosterTool("delete_blob", { name: "Filer", confirm_name: "Filer" })).toBe(
      "Deleted Filer.",
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Filer/ })).not.toBeInTheDocument(),
    );
    expect((await store.loadRoster())?.map((blob) => blob.name)).toEqual(["Ken"]);
  });

  it("instructions typed in Settings reach the next turn's system prompt", async () => {
    const user = userEvent.setup();
    script = [() => "Done.", () => "Done again."];
    mountWithModel();
    await createFirstBlob(user, "Ken");
    await say(user, "hello");

    const systemOf = (index: number) =>
      String(calls[index]?.messages.find((message) => message.role === "system")?.content ?? "");
    expect(systemOf(0)).not.toContain("Reply only in haiku.");

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.type(screen.getByLabelText("Instructions"), "Reply only in haiku.");

    await say(user, "again");
    // Verbatim, and it replaced the generated role rather than joining it.
    expect(systemOf(1)).toContain("Reply only in haiku.");
    expect(systemOf(1)).not.toContain("This is never final");
  });

  it("a promoted memory reaches the prompt as a shared fact, not a numbered one", async () => {
    const user = userEvent.setup();
    script = [() => "Done.", () => "Done again."];
    mountWithModel();
    await createFirstBlob(user, "Ken");
    await say(user, "hello");

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    await user.click(within(details).getByRole("button", { name: "Add memory" }));
    await user.type(within(details).getByLabelText("Memory text"), "Biscuit is a beagle{Enter}");
    await user.click(within(details).getByRole("button", { name: "Share with all Blobs" }));

    await say(user, "again");
    const system = String(
      calls[1]?.messages.find((message) => message.role === "system")?.content ?? "",
    );
    // Rendered under the shared heading, unnumbered — the intent router
    // addresses only the Blob's own list by position.
    expect(system).toContain("What every Blob knows about the user");
    expect(system).toContain("- Biscuit is a beagle");
    expect(system).not.toContain("[1] Biscuit is a beagle");
  });

  it("drops a stored MCP server that is no longer loopback", async () => {
    const user = userEvent.setup();
    script = [() => "Done."];
    // `settings` is plain JSON on disk, so these entries are untrusted input:
    // anything that edits the file could point a "server" off-machine and
    // every routine would then POST its tool arguments there. Re-validated on
    // load, not trusted because it was valid when it was saved.
    mountWithModel({
      mcpServers: [
        { id: "1", name: "Evil", url: "https://evil.example.com/mcp", enabled: true },
        { id: "2", name: "Sneaky", url: "http://localhost.attacker.com:3000/mcp", enabled: true },
        { id: "3", name: "Fine", url: "http://127.0.0.1:39917/mcp", enabled: true },
      ],
    });
    await createFirstBlob(user, "Ken");
    await say(user, "hello");

    // Only the genuinely local one survives to the turn.
    expect(calls[0]?.mcpServers?.map((server) => server.name)).toEqual(["Fine"]);
  });

  it("a scheduled routine sees the same servers and shared facts as a chat turn", async () => {
    const user = userEvent.setup();
    script = [() => "Done.", () => "Routine done."];
    // Both of these hydrate from disk *after* mount, and the scheduler was
    // built at mount — so reading them from the render closure hands a
    // scheduled routine an empty list forever. MCP is routine-scope only, so
    // that path is the one that matters most.
    mountWithModel({
      mcpServers: [{ id: "1", name: "Fine", url: "http://127.0.0.1:39917/mcp", enabled: true }],
    });
    await createFirstBlob(user, "Ken");
    await say(user, "hello");

    // Add a shared fact through the UI, after mount, exactly as a user would.
    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    await user.click(within(details).getByRole("button", { name: "Add memory" }));
    await user.type(within(details).getByLabelText("Memory text"), "Biscuit is a beagle{Enter}");
    await user.click(within(details).getByRole("button", { name: "Share with all Blobs" }));

    // Fire through the scheduler's own host, not by typing a message.
    // Asserted first so a mock that never captured the host fails as
    // "scheduler never started" rather than as a confusing count mismatch.
    expect(schedulerHost, "scheduler was never started").not.toBeNull();
    const blobId = (await store.loadRoster())?.[0]?.id ?? "";
    const before = calls.length;
    await schedulerHost?.fire(blobId, {
      id: "r1",
      name: "Morning",
      instruction: "check the news",
      triggers: ["Every day at 08:00"],
      active: true,
      schedule: { kind: "daily", hour: 8, minute: 0 },
    });
    // That a turn ran at all is the `model` half of this: a stale closure
    // holds the mount-time "", so requestReply bails before streamBlobTurn
    // and scheduled routines never run.
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));

    const routineTurn = calls[calls.length - 1];
    expect(routineTurn?.scope).toBe("routine");
    expect(routineTurn?.mcpServers?.map((server) => server.name)).toEqual(["Fine"]);
    expect(
      String(routineTurn?.messages.find((message) => message.role === "system")?.content ?? ""),
    ).toContain("Biscuit is a beagle");
  });

  it("gives the turn its own identity, and no servers when none are configured", async () => {
    const user = userEvent.setup();
    script = [() => "Done."];
    mountWithModel();
    await createFirstBlob(user, "Ken");
    await say(user, "hello");

    // The roster tools need the caller's own name to refuse self-deletion.
    expect(calls[0]?.roster?.selfName).toBe("Ken");
    // Nothing configured, so a turn must not try to contact anything.
    expect(calls[0]?.mcpServers ?? []).toEqual([]);
    // A typed message is the tuned chat path, never the autonomous catalog.
    expect(calls[0]?.scope ?? "chat").toBe("chat");
  });
});
