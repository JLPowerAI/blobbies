// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/data/agents";
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
 *   - Settings edits (memory scope) landing in the next turn's system
 *     prompt, and the prompt dialog showing exactly what a turn sends;
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

/**
 * Who the group router picks, by name. Null lets every member through, which
 * is also what the real router falls back to when Ollama is unreachable.
 */
let responderPick: ((names: string[]) => string[]) | null = null;
vi.mock("@/lib/intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/intent")>()),
  pickResponders: vi.fn(async (options: { members: { name: string }[] }) => {
    const names = options.members.map((member) => member.name);
    return responderPick === null ? names : responderPick(names);
  }),
  // The classifier itself is covered in intent.test.ts against a faked
  // fetch; here it only has to be deterministic so the *wiring* — one call
  // per message, one shared write — is what is being measured.
  routeIntent: vi.fn(async (options: { messages: { content: unknown }[] }) => {
    const said = String(options.messages[options.messages.length - 1]?.content ?? "");
    return /remember I live in Lisbon/.test(said)
      ? { action: "save_fact", fact: "the user lives in Lisbon" }
      : { action: "none" };
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

/**
 * Two Blobs in one group, on disk, ready for mount — membership is the Blob's
 * `section`, and the group list carries the id its transcript is keyed by.
 */
const GROUP_ID = "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

async function seedGroup() {
  const member = (index: number, name: string): Agent => ({
    id: `61ec34f1-9ba5-4eff-b8e1-7acefb21${String(index).padStart(4, "0")}`,
    name,
    time: "Now",
    snippet: "New Blob. Say hello",
    tone: "blue",
    shape: "sphere",
    section: "Launch",
  });
  await store.flushRoster([member(1, "Researcher"), member(2, "Writer")]);
  store.saveGroups([{ id: GROUP_ID, name: "Launch" }]);
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
    responderPick = null;
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

  it("message_blob wakes the other Blob in its own conversation, fenced", async () => {
    const user = userEvent.setup();
    script = [
      (options) => {
        options.onSegment?.("Done.");
        return "Done.";
      },
      (options) => {
        options.onSegment?.("On it.");
        return "On it.";
      },
    ];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(await within(conversations).findByRole("button", { name: /Researcher/ }));
    await user.type(screen.getByLabelText("Message Researcher"), "hello{Enter}");
    await waitFor(() => expect(calls.length).toBe(1));

    expect(
      await callRosterTool("message_blob", { name: "Writer", message: "Draft the post" }),
    ).toBe("Sent to Writer. They will answer in their own conversation.");

    // The receiver wakes on its own turn — the sender does not wait for it,
    // and does not get the answer back inside its own turn.
    await waitFor(() => expect(calls.length).toBe(2));
    const woken = calls[1];
    expect(woken?.roster?.selfName).toBe("Writer");
    // Autonomous, so it gets the routine catalog rather than the tuned chat
    // path: there is no human in this turn to fill gaps.
    expect(woken?.scope).toBe("routine");
    // Another Blob's words are model output, so they arrive fenced as data.
    const prompt = String(woken?.messages[woken.messages.length - 1]?.content ?? "");
    expect(prompt).toContain('from="blob:Researcher"');
    expect(prompt).toContain("Draft the post");

    // And the hand-off is visible where the work landed, not only in logs.
    await user.click(within(conversations).getByRole("button", { name: /Writer/ }));
    expect(await screen.findByText("Researcher: Draft the post")).toBeInTheDocument();
  });

  it("Stop cancels a hand-off that has not started yet", async () => {
    const user = userEvent.setup();
    // The sender hands off and then holds the turn open, so Stop lands while
    // the receiver's turn is still queued behind it — which is the only
    // window in which cancelling it is a decision at all.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    script = [
      async (options) => {
        await callRosterTool("message_blob", { name: "Writer", message: "Draft the post" });
        options.onSegment?.("Handed it over.");
        await held;
        return "Handed it over.";
      },
      (options) => {
        options.onSegment?.("On it.");
        return "On it.";
      },
    ];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(await within(conversations).findByRole("button", { name: /Researcher/ }));
    await user.type(screen.getByLabelText("Message Researcher"), "hello{Enter}");
    await waitFor(() => expect(screen.getByText("Handed it over.")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Stop replying" }));
    release();
    // Waited out properly: the sender's turn has to finish and the queue drain
    // before "the receiver never ran" means anything.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop replying" })).not.toBeInTheDocument(),
    );
    // Stop means the whole exchange: another Blob must not pick up the work
    // the user just stopped, in a conversation they are not even looking at.
    expect(calls.length).toBe(1);
    expect(screen.queryByText("On it.")).not.toBeInTheDocument();
  });

  it("stops a hand-off chain before two Blobs pin the model forever", async () => {
    const user = userEvent.setup();
    const results: string[] = [];
    // Every woken Blob immediately hands the work back. Turns are serial
    // against one local model, so unchecked this never stops and Stop is the
    // user's only lever.
    script = Array.from({ length: 8 }, () => async (options: TurnOptions) => {
      const to = options.roster?.selfName === "Writer" ? "Researcher" : "Writer";
      results.push(await callRosterTool("message_blob", { name: to, message: "your turn" }));
      options.onSegment?.("Passed it on.");
      return "Passed it on.";
    });
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(await within(conversations).findByRole("button", { name: /Researcher/ }));
    await user.type(screen.getByLabelText("Message Researcher"), "hello{Enter}");

    // The chain runs to the cap and then refuses, rather than growing.
    await waitFor(() => expect(results.at(-1)).toContain("hand-offs in a row"));
    await waitFor(() => expect(calls.length).toBe(4));
    expect(calls.length).toBe(4);
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

  it("shows the system prompt a turn actually sends, not an approximation", async () => {
    // The dialog is the only place a user can check what their Blob was told,
    // so it is worth nothing if it renders a prompt built differently from
    // the real one — a preview that drifts is worse than none.
    const user = userEvent.setup();
    script = [() => "Done."];
    mountWithModel();
    await createFirstBlob(user, "Ken");
    await say(user, "hello");
    const sent = String(
      calls[0]?.messages.find((message) => message.role === "system")?.content ?? "",
    );
    expect(sent).not.toBe("");

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.click(screen.getByRole("button", { name: "System prompt" }));

    const dialog = screen.getByRole("dialog", { name: "Ken system prompt" });
    expect(dialog.textContent).toContain(sent);

    await user.click(within(dialog).getByRole("button", { name: "Close system prompt" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Ken system prompt" })).not.toBeInTheDocument(),
    );
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

  it("has a group answer in turn, each member reading the ones before it", async () => {
    const user = userEvent.setup();
    // Spoken as segments, the way a real turn emits them — a group reply has
    // no sidebar snippet to fall back on.
    script = [
      (options) => {
        options.onSegment?.("Sources gathered.");
        return "Sources gathered.";
      },
      (options) => {
        options.onSegment?.("Draft written.");
        return "Draft written.";
      },
    ];
    await seedGroup();
    mountWithModel();

    // The group's name in the sidebar is the door to its chat.
    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText("Message Launch"), "where are we?{Enter}");

    // Nobody was addressed, so both members answer — one turn each, in roster
    // order, not one turn on behalf of the group.
    await waitFor(() => expect(calls.length).toBe(2));
    await waitFor(() => expect(screen.getByText("Draft written.")).toBeInTheDocument());

    // Each reply is attributed, or a group transcript cannot be read at all.
    expect(screen.getByText("Sources gathered.").closest(".message-row")).toHaveTextContent(
      "Researcher",
    );

    const [first, second] = calls;
    // The system prompt tells each member who else is in the room.
    const prompt = String(first?.messages.find((entry) => entry.role === "system")?.content ?? "");
    expect(prompt).toContain("Group chat");
    expect(prompt).toContain("Writer");

    // The second member sees the first's line as somebody else's, labelled:
    // as an assistant message it would read as its own earlier answer.
    const seen = second?.messages.filter((entry) => entry.role !== "system") ?? [];
    const line = seen.find((entry) => String(entry.content).includes("Sources gathered."));
    expect(line?.role).toBe("user");
    expect(String(line?.content)).toContain("[Researcher]:");
    // A group is a conversation, so it stays the tuned chat path.
    expect(second?.scope ?? "chat").toBe("chat");
  });

  it("asks only the Blob the router picked, not the whole group", async () => {
    const user = userEvent.setup();
    // Nobody is @-mentioned, so the router decides — and a question that
    // concerns one member must not cost six turns and six near-identical
    // replies on one local model.
    responderPick = (names) => names.filter((name) => name === "Writer");
    script = [
      (options) => {
        options.onSegment?.("On it.");
        return "On it.";
      },
    ];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText(/^Message Launch/), "can someone draft the post{Enter}");

    await waitFor(() => expect(screen.getByText("On it.")).toBeInTheDocument());
    expect(calls.length).toBe(1);
    expect(calls[0]?.roster?.selfName).toBe("Writer");
  });

  it("a fact told to a group is saved once, shared, not per Blob", async () => {
    const user = userEvent.setup();
    // Both members answer, so a per-responder router would classify the same
    // sentence twice and write two private copies of it.
    responderPick = (names) => names;
    script = [
      (options) => {
        options.onSegment?.("Noted.");
        return "Noted.";
      },
      (options) => {
        options.onSegment?.("Same here.");
        return "Same here.";
      },
    ];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText(/^Message Launch/), "remember I live in Lisbon{Enter}");
    await waitFor(() => expect(screen.getByText("Same here.")).toBeInTheDocument());

    // One copy, in the scope every Blob reads — and none in either Blob's own
    // list, where two reconciles against two lists would drift apart.
    window.dispatchEvent(new Event("beforeunload"));
    expect((await store.loadUserMemories())?.map((memory) => memory.text)).toEqual([
      "the user lives in Lisbon",
    ]);
    for (const blob of (await store.loadRoster()) ?? []) {
      expect(blob.memories ?? []).toEqual([]);
    }
  });

  it("lets a Blob stay out, and shows nothing rather than the word PASS", async () => {
    const user = userEvent.setup();
    responderPick = (names) => names;
    script = [
      (options) => {
        options.onSegment?.("The 14th.");
        return "The 14th.";
      },
      // Nothing to add — a colleague already answered. Being picked is an
      // invitation, not an obligation.
      (options) => {
        options.onSegment?.("PASS");
        return "PASS";
      },
    ];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText(/^Message Launch/), "when is the venue booked{Enter}");

    await waitFor(() => expect(screen.getByText("The 14th.")).toBeInTheDocument());
    // Both were asked, so both ran — the second's bubble is taken back off
    // the screen rather than showing the user a bare "PASS".
    await waitFor(() => expect(calls.length).toBe(2));
    expect(screen.queryByText("PASS")).not.toBeInTheDocument();
    // But it must leave a trace: the thinking blob already appeared for it,
    // and vanishing without one is indistinguishable from a crash.
    expect(await screen.findByText(/Writer had nothing to add/)).toBeInTheDocument();
    window.dispatchEvent(new Event("beforeunload"));
    const saved = (await store.loadGroupTranscript(GROUP_ID)) ?? [];
    expect(
      saved.some((entry) => entry.kind === "text" && /PASS/.test(entry.segments[0]?.text ?? "")),
    ).toBe(false);
  });

  it("never lets a Blob the user named by name stay out", async () => {
    const user = userEvent.setup();
    script = [
      (options) => {
        options.onSegment?.("PASS");
        return "PASS";
      },
    ];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText(/^Message Launch/), "@Writer draft it{Enter}");

    // Being called on by name is an obligation. If the model emits the token
    // anyway, a stray "PASS" is better than a silent non-answer to a direct
    // question — the user would otherwise have no idea anything ran.
    expect(await screen.findByText("PASS")).toBeInTheDocument();
    expect(screen.queryByText(/No one here picked this up/)).not.toBeInTheDocument();
  });

  it("has every member answer @everyone — nobody may opt out", async () => {
    const user = userEvent.setup();
    // Both would rather stay out. They do not get to: the user addressed the
    // whole room, and a room that answers with silence is not an answer.
    script = [
      (options) => {
        options.onSegment?.("PASS");
        return "PASS";
      },
      (options) => {
        options.onSegment?.("PASS");
        return "PASS";
      },
    ];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText(/^Message Launch/), "@everyone hows everyone{Enter}");

    await waitFor(() => expect(calls.length).toBe(2));
    // Both replies stand. A stray "PASS" on screen is a prompt problem the
    // user can see; deleting it would hide that the Blob answered at all.
    await waitFor(() => expect(screen.getAllByText("PASS")).toHaveLength(2));
    expect(screen.queryByText(/No one here picked this up/)).not.toBeInTheDocument();
    expect(screen.queryByText(/had nothing to add/)).not.toBeInTheDocument();
  });

  it("drops a member removed from the group while the exchange is running", async () => {
    const user = userEvent.setup();
    responderPick = (names) => names;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    script = [
      async (options) => {
        // Held open so the roster can change while the second member is still
        // queued behind this one — an exchange runs several turns, and a Blob
        // can be dragged out, hidden or deleted in between.
        options.onSegment?.("Sources are in.");
        await held;
        return "Sources are in.";
      },
      (options) => {
        options.onSegment?.("Should never speak.");
        return "Should never speak.";
      },
    ];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText(/^Message Launch/), "where are we{Enter}");
    await waitFor(() => expect(screen.getByText("Sources are in.")).toBeInTheDocument());

    // Writer leaves the group mid-exchange. Hiding is the quickest real UI
    // path to it; dragging it out sets the same field.
    fireEvent.contextMenu(within(conversations).getByRole("button", { name: /Writer/ }));
    await user.click(await screen.findByText("Hide from sidebar"));
    release();

    // It must not speak on behalf of a group it is no longer in. Membership
    // is re-read per speaker, so only the first member's turn ever ran.
    await waitFor(() => expect(calls.length).toBe(1));
    expect(screen.queryByText("Should never speak.")).not.toBeInTheDocument();
    expect(calls.length).toBe(1);
  });

  it("names who stayed out when the whole room does", async () => {
    const user = userEvent.setup();
    responderPick = (names) => names;
    script = [
      (options) => {
        options.onSegment?.("PASS");
        return "PASS";
      },
      (options) => {
        options.onSegment?.("PASS");
        return "PASS";
      },
    ];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText(/^Message Launch/), "cheers all{Enter}");

    // An empty screen is indistinguishable from a broken app. Both thinking
    // blobs appeared, so both are accounted for by name — and the way out is
    // one @ away.
    expect(
      await screen.findByText(/Researcher and Writer had nothing to add \u2014 @ a Blob/),
    ).toBeInTheDocument();
  });

  it("flags a group unread when a reply lands while you are elsewhere", async () => {
    const user = userEvent.setup();
    responderPick = (names) => names.filter((name) => name === "Researcher");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    script = [
      async (options) => {
        // Held open so the user can switch away mid-exchange — which is the
        // whole case: a group runs several turns and they rarely watch it out.
        await held;
        options.onSegment?.("Sources are in.");
        return "Sources are in.";
      },
    ];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText(/^Message Launch/), "where are we{Enter}");
    await waitFor(() => expect(calls.length).toBe(1));

    await user.click(await within(conversations).findByRole("button", { name: /Researcher/ }));
    release();

    // The words land in the group's own transcript, so no member's unread dot
    // can stand in for this.
    const unread = await within(conversations).findByRole("button", {
      name: "Launch, unread messages",
    });

    // Reading it is what clears it — and it stays cleared across a reload.
    await user.click(unread);
    await waitFor(() =>
      expect(within(conversations).getByRole("button", { name: "Launch" })).toBeInTheDocument(),
    );
    window.dispatchEvent(new Event("beforeunload"));
    expect((await store.loadGroups())?.[0]?.unread).toBe(false);
  });

  it("says the model is missing once, not once per member", async () => {
    const user = userEvent.setup();
    await seedGroup();
    mountWithModel({ model: "" });

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText(/^Message Launch/), "hello{Enter}");

    // One app-level problem, said once — not shouted by every Blob in the room.
    expect(await screen.findAllByText(/pick one in Settings/)).toHaveLength(1);
  });

  it("says so when the router picks nobody, rather than going silent", async () => {
    const user = userEvent.setup();
    // Silence is a legitimate answer in a group, but an app that shows
    // nothing at all is indistinguishable from a broken one.
    responderPick = () => [];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText(/^Message Launch/), "thanks all{Enter}");

    expect(await screen.findByText(/No one here picked this up/)).toBeInTheDocument();
    expect(calls.length).toBe(0);
  });

  it("pulls in the teammate a responder hands the next step to, and only them", async () => {
    const user = userEvent.setup();
    responderPick = (names) => names.filter((name) => name === "Researcher");
    script = [
      (options) => {
        // A hand-off (sentence-opening) and a passing reference in the same
        // reply. Only the hand-off wakes anyone — sim:group caught a Blob
        // referring to two teammates and waking both to say nothing.
        options.onSegment?.("Sources are in. @Writer draft it, and tell @Researcher later.");
        return "handed over";
      },
      (options) => {
        options.onSegment?.("Drafting now.");
        return "Drafting now.";
      },
    ];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText(/^Message Launch/), "where are we{Enter}");

    await waitFor(() => expect(screen.getByText("Drafting now.")).toBeInTheDocument());
    // Two turns: the picked Blob, then the one it handed to. The Blob it only
    // referred to stays out, and a Blob that has spoken never speaks twice —
    // between them, an exchange always ends.
    expect(calls.length).toBe(2);
    expect(calls[1]?.roster?.selfName).toBe("Writer");
  });

  it("asks only the mentioned member of a group", async () => {
    const user = userEvent.setup();
    script = [
      (options) => {
        options.onSegment?.("On it.");
        return "On it.";
      },
    ];
    await seedGroup();
    mountWithModel();

    const conversations = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: "Launch" }));
    await user.type(screen.getByLabelText("Message Launch"), "@Writer draft it{Enter}");

    await waitFor(() => expect(screen.getByText("On it.")).toBeInTheDocument());
    // One turn, and it is the mentioned Blob's: the other member stays quiet.
    expect(calls.length).toBe(1);
    expect(calls[0]?.roster?.selfName).toBe("Writer");
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
