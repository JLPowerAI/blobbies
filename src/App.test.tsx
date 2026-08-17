import { render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { flushRoster, loadRoster, loadUserMemories, saveBlobTranscript } from "@/lib/store";

/** Completes the first-run creator with the given Blob name. */
async function createFirstBlob(user: UserEvent, name = "Ken") {
  await user.type(screen.getByLabelText("Name"), name);
  await user.click(screen.getByRole("button", { name: "Get started" }));
}

describe("App", () => {
  it("hydrates a persisted roster on startup", async () => {
    await flushRoster([
      {
        id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
        name: "Restored",
        time: "Now",
        snippet: "New Blob. Say hello",
        tone: "blue",
        shape: "sphere",
      },
    ]);
    render(<App />);

    // The persisted Blob replaces the empty first-run state.
    expect(await screen.findByRole("heading", { name: "Restored", level: 1 })).toBeInTheDocument();
  });

  it("restores the conversation of the Blob shown on startup", async () => {
    const id = "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea";
    await flushRoster([
      {
        id,
        name: "Ken",
        time: "Now",
        snippet: "Biscuit is a beagle",
        tone: "blue",
        shape: "sphere",
      },
    ]);
    saveBlobTranscript(id, [
      {
        id: "sent-1",
        kind: "text",
        author: "user",
        segments: [{ text: "My dog is called Biscuit." }],
      },
      {
        id: "agent-1",
        kind: "text",
        author: "agent",
        segments: [{ text: "Noted, Biscuit it is." }],
      },
    ]);
    // saveBlobTranscript is debounced; let the write land before mounting.
    await new Promise((resolve) => setTimeout(resolve, 400));

    render(<App />);

    // Nothing is clicked: the first Blob is shown by fallback, and its history
    // must load or the model is sent a conversation with no past turns.
    const log = await screen.findByRole("log");
    expect(await within(log).findByText("My dog is called Biscuit.")).toBeInTheDocument();
    expect(await within(log).findByText("Noted, Biscuit it is.")).toBeInTheDocument();
  });

  it("clears the draft when switching Blobs without remounting the pane", async () => {
    await flushRoster([
      {
        id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
        name: "Ken",
        time: "Now",
        snippet: "New Blob. Say hello",
        tone: "red",
        shape: "cloud",
      },
      {
        id: "7c1f34f1-9ba5-4eff-b8e1-7acefb2148eb",
        name: "Bob",
        time: "Now",
        snippet: "New Blob. Say hello",
        tone: "blue",
        shape: "sphere",
      },
    ]);
    const user = userEvent.setup();
    render(<App />);

    const composer = await screen.findByLabelText("Message Ken");
    await user.type(composer, "draft for ken");

    const conversations = screen.getByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: /Bob/ }));

    // Same pane, new conversation: title and placeholder switch, the
    // per-conversation draft resets (ChatPane resets state on agent.id
    // change instead of being remounted via a key).
    expect(screen.getByRole("heading", { name: "Bob", level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText("Message Bob")).toHaveValue("");
  });

  it("shows the first-run creator when no Blobs exist", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "New Blob", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Create your first Blob")).toBeInTheDocument();
    expect(screen.getByText("No Blobs yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get started" })).toBeDisabled();
  });

  it("creates the first Blob, opens its conversation and persists the roster", async () => {
    const user = userEvent.setup();
    render(<App />);

    await createFirstBlob(user, "Ken");

    // Creation flushes the roster to the store immediately (not debounced),
    // with a UUID id the Rust store will accept.
    const roster = await loadRoster();
    expect(roster).toHaveLength(1);
    expect(roster?.[0]?.name).toBe("Ken");
    expect(roster?.[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    expect(screen.getByRole("heading", { name: "Ken", level: 1 })).toBeInTheDocument();
    const conversations = screen.getByRole("navigation", { name: "Conversations" });
    // "Ken" the Blob row, not the "Ken Kai" account row in the footer.
    expect(
      within(conversations).getByRole("button", { name: /What do you need me to do\?/ }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Message Ken")).toBeInTheDocument();
  });

  it("caps Blob names at the maximum length", async () => {
    const user = userEvent.setup();
    render(<App />);

    const longName = "A".repeat(40);
    await user.type(screen.getByLabelText("Name"), longName);

    const field = screen.getByLabelText("Name") as HTMLInputElement;
    expect(field.value).toHaveLength(24);
    expect(screen.getByText("24/24")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("heading", { name: "A".repeat(24), level: 1 })).toBeInTheDocument();
  });

  it("prefills the creator from a suggestion card", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Writer Blob/ }));
    expect(screen.getByLabelText("Name")).toHaveValue("Writer Blob");

    await user.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("heading", { name: "Writer Blob", level: 1 })).toBeInTheDocument();
  });

  it("sends on Enter and inserts a newline on Shift+Enter", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user);

    const composer = screen.getByLabelText("Message Ken");
    await user.type(composer, "line one{Shift>}{Enter}{/Shift}line two");
    expect(composer).toHaveValue("line one\nline two");

    await user.type(composer, "{Enter}");
    expect(composer).toHaveValue("");
    expect(within(screen.getByRole("log")).getByText(/line one/)).toBeInTheDocument();
  });

  it("answers a sent message with the no-model fallback when none is chosen", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user);

    await user.type(screen.getByLabelText("Message Ken"), "hello{Enter}");

    // No model configured: the Blob must still respond, pointing at Settings.
    expect(
      await within(screen.getByRole("log")).findByText(/pick one in Settings/),
    ).toBeInTheDocument();
  });

  it("replies to a message via the hover actions", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user);

    const replyButtons = screen.getAllByRole("button", { name: "Reply" });
    await user.click(replyButtons[0] as HTMLElement);
    expect(screen.getByPlaceholderText("Reply...")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Message Ken"), "On it{Enter}");

    const log = screen.getByRole("log");
    expect(within(log).getByText("On it")).toBeInTheDocument();
    expect(
      within(log).getByText("What do you need me to do?", { selector: ".bubble-quote" }),
    ).toBeInTheDocument();
  });

  it("reacts to a message from the picker", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user);

    const reactButtons = screen.getAllByRole("button", { name: "React" });
    await user.click(reactButtons[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "React with thumbs up" }));

    expect(screen.getByLabelText(/Reacted with/)).toBeInTheDocument();
  });

  it("routes palette creation through the creator with the query prefilled", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "New Blob" }));
    const toField = screen.getByLabelText("Search or create Blobs");
    expect(toField).toHaveFocus();

    await user.type(toField, "Zed");
    await user.click(screen.getByRole("button", { name: 'Create new Blob "Zed"' }));

    // Creator opens prefilled; finishing it lands in the new chat.
    expect(screen.getByLabelText("Name")).toHaveValue("Zed");
    await user.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("heading", { name: "Zed", level: 1 })).toBeInTheDocument();
  });

  it("opens an existing Blob from the palette and dismisses on Escape", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "New Blob" }));
    const palette = screen.getByRole("region", { name: "New Blob" });
    await user.click(within(palette).getByRole("button", { name: /Ken/ }));
    expect(screen.getByRole("heading", { name: "Ken", level: 1 })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New Blob" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Search or create Blobs")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ken", level: 1 })).toBeInTheDocument();
  });

  it("searches across Blobs and jumps to the one it finds", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");
    // A second Blob, so picking one is a real choice rather than the only row.
    await user.click(screen.getByRole("button", { name: "New Blob" }));
    await user.type(screen.getByLabelText("Search or create Blobs"), "Zed");
    await user.click(screen.getByRole("button", { name: 'Create new Blob "Zed"' }));
    await user.click(screen.getByRole("button", { name: "Get started" }));

    await user.click(screen.getByRole("button", { name: "Search" }));
    const palette = screen.getByRole("dialog", { name: "Search" });
    await user.type(within(palette).getByRole("textbox", { name: "Search" }), "ken");
    await user.click(await within(palette).findByRole("button", { name: /Ken/ }));

    // Picking a row closes the palette and opens that conversation.
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ken", level: 1 })).toBeInTheDocument();
  });

  it("opens Settings on the tab the palette asked for", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByRole("button", { name: /Settings: Updates/ }));

    // Straight to Updates, not the General tab the dialog otherwise opens on.
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("button", { name: "Check for Updates" })).toBeInTheDocument();
  });

  it("opens Blob settings from the chat header identity", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Ken settings" }));

    const panel = screen.getByRole("complementary", { name: "Ken settings" });
    expect(within(panel).getByLabelText("Name")).toHaveValue("Ken");

    // Renaming updates the chat header and sidebar live.
    await user.clear(within(panel).getByLabelText("Name"));
    await user.type(within(panel).getByLabelText("Name"), "Kenji");
    expect(screen.getByRole("heading", { name: "Kenji", level: 1 })).toBeInTheDocument();

    // Notifications toggle flips.
    const toggle = within(panel).getByRole("switch", { name: "Notifications" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();

    // Back returns to the info view.
    await user.click(within(panel).getByRole("button", { name: "Back" }));
    expect(screen.getByRole("complementary", { name: "Kenji details" })).toBeInTheDocument();
  });

  it("opens app settings from the account menu and edits preferences", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Ken Kai/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Ken Kai");

    // Rename updates the footer account row live.
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "Kenny");
    expect(screen.getByRole("button", { name: /Kenny/ })).toBeInTheDocument();

    // Theme switch applies to the document root.
    await user.selectOptions(within(dialog).getByLabelText("Theme"), "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    // Timezone select defaults to auto-detect.
    expect(within(dialog).getByLabelText("Timezone")).toHaveValue("auto");

    // Updates tab is Blobbies-branded.
    await user.click(within(dialog).getByRole("button", { name: "Updates" }));
    expect(within(dialog).getByText(/Blobbies 0\.1\.0/)).toBeInTheDocument();
    expect(within(dialog).getByText(/You're up to date/)).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists downloaded Ollama models and frees the outgoing one on switch", async () => {
    // Deterministic local server: version probe succeeds, two models pulled.
    const unloads: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/version")) {
          return new Response(JSON.stringify({ version: "0.5.0" }));
        }
        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: "llama3.2:latest",
                  size: 2_000_000_000,
                  details: { parameter_size: "3.2B" },
                },
                {
                  name: "qwen3.5:9b",
                  size: 6_600_000_000,
                  details: { parameter_size: "9B" },
                },
              ],
            }),
          );
        }
        if (url.endsWith("/api/chat")) {
          // The only /api/chat traffic settings may produce is the unload.
          unloads.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ done: true }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    try {
      const user = userEvent.setup();
      render(<App />);

      await user.click(screen.getByRole("button", { name: /Ken Kai/ }));
      await user.click(screen.getByRole("menuitem", { name: "Settings" }));
      const dialog = screen.getByRole("dialog", { name: "Settings" });
      await user.click(within(dialog).getByRole("button", { name: "Model" }));

      // Section 1: install/server status.
      expect(await within(dialog).findByText(/Running v0\.5\.0/)).toBeInTheDocument();

      // Section 2: choosing between the downloaded models.
      const select = within(dialog).getByLabelText("Chat model");
      await user.selectOptions(select, "llama3.2:latest");
      expect(select).toHaveValue("llama3.2:latest");
      // First pick came from "no model": nothing to free yet.
      expect(unloads).toEqual([]);

      // Switching models must release the outgoing one immediately —
      // keep_alive: 0 — or it idles in RAM beside the new model for 30m.
      await user.selectOptions(select, "qwen3.5:9b");
      expect(unloads).toEqual([{ model: "llama3.2:latest", messages: [], keep_alive: 0 }]);
    } finally {
      vi.unstubAllGlobals();
      // This test persists a model choice; later tests assume none is set.
      // (When jsdom lacks localStorage, writePreference already no-oped and
      // there is nothing to clean.)
      try {
        window.localStorage.removeItem("pref:model");
      } catch {
        // Storage unavailable: the preference never stuck.
      }
    }
  });

  it("collapses and expands the sidebar via the resize splitter", async () => {
    const user = userEvent.setup();
    render(<App />);

    const splitter = screen.getByRole("separator", { name: "Resize sidebar" });
    const sidebar = screen.getByRole("navigation", { name: "Conversations" });

    splitter.focus();
    await user.keyboard("{Enter}");
    expect(sidebar.className).toContain("sidebar-collapsed");

    await user.keyboard("{ArrowRight}");
    expect(sidebar.className).not.toContain("sidebar-collapsed");
  });

  it("creates a routine from the empty state and lists it afterwards", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    expect(
      within(details).getByText(/Routines are recurring tasks this agent runs on a schedule/),
    ).toBeInTheDocument();

    await user.click(within(details).getByRole("button", { name: "Create Routine" }));

    // Editor opens; fill it in and add a schedule trigger.
    const editor = screen.getByRole("complementary", { name: "Routine" });
    await user.type(within(editor).getByLabelText("Name"), "Test routine");
    await user.click(within(editor).getByRole("button", { name: "Add trigger" }));
    await user.click(within(editor).getByRole("menuitem", { name: "On a schedule" }));
    await user.click(within(editor).getByRole("menuitem", { name: "Every hour" }));
    expect(within(editor).getByText("Every hour")).toBeInTheDocument();

    // Back shows the routine listed with its trigger.
    await user.click(within(editor).getByRole("button", { name: "Back" }));
    const list = screen.getByRole("complementary", { name: "Ken details" });
    expect(within(list).getByRole("button", { name: /Test routine/ })).toBeInTheDocument();
    expect(within(list).getByText("Every hour")).toBeInTheDocument();
  });

  it("browses, adds and uninstalls a plugin from the Plugins modal", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Plugins" }));
    const dialog = screen.getByRole("dialog", { name: "Plugins" });

    // Search narrows the marketplace; Add flips the row to Added.
    await user.type(within(dialog).getByLabelText("Search plugins"), "gmail");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(within(dialog).getByText("Added")).toBeInTheDocument();

    // The Yours tab lists it; opening the row shows the detail view.
    await user.clear(within(dialog).getByLabelText("Search plugins"));
    await user.click(within(dialog).getByRole("tab", { name: "Yours" }));
    await user.click(within(dialog).getByRole("button", { name: /Gmail/ }));
    expect(within(dialog).getByText(/Needs auth/)).toBeInTheDocument();

    // Uninstall, then Escape steps back to the list before closing.
    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    await user.keyboard("{Escape}");
    expect(within(dialog).getByRole("tab", { name: "Yours" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Plugins" })).not.toBeInTheDocument();
  });

  it("adds a memory and promotes it from this Blob to all Blobs", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });

    await user.click(within(details).getByRole("button", { name: "Add memory" }));
    await user.type(within(details).getByLabelText("Memory text"), "Biscuit is a beagle{Enter}");

    // Numbered to match renderMemories, so "forget 1" in chat means this row.
    expect(within(details).getByText(/\[1\] Biscuit is a beagle/)).toBeInTheDocument();
    expect(within(details).getByText("This Blob")).toBeInTheDocument();
    expect(await loadUserMemories()).toBeNull();

    // Promote: the fact leaves the Blob's config for the shared `user` slice.
    await user.click(within(details).getByRole("button", { name: "Share with all Blobs" }));
    expect(within(details).getByText("All Blobs")).toBeInTheDocument();
    expect(within(details).queryByText(/\[1\]/)).not.toBeInTheDocument();

    window.dispatchEvent(new Event("beforeunload"));
    expect(await loadUserMemories()).toEqual([
      expect.objectContaining({ text: "Biscuit is a beagle" }),
    ]);
    const roster = await loadRoster();
    expect(roster?.[0]?.memories ?? []).toEqual([]);

    // And back again, so the toggle is not one-way.
    await user.click(within(details).getByRole("button", { name: "Keep to this Blob only" }));
    expect(within(details).getByText("This Blob")).toBeInTheDocument();
  });

  it("deletes a memory from the details panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    await user.click(within(details).getByRole("button", { name: "Add memory" }));
    await user.type(within(details).getByLabelText("Memory text"), "Temporary{Enter}");

    await user.click(within(details).getByRole("button", { name: "Delete memory: Temporary" }));
    expect(within(details).queryByText(/Temporary/)).not.toBeInTheDocument();
    expect(
      within(details).getByText(/Facts this Blob has learned about you show up here/),
    ).toBeInTheDocument();
  });

  it("keeps the details panel hidden until opened from the chat header", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    // Hidden by default; only the monitor button reveals it.
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    expect(screen.getByRole("complementary", { name: "Ken details" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide details panel" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});
