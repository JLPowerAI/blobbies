import { render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { App } from "@/App";
import { type Agent, MAX_BLOBS } from "@/data/agents";
import { readPreference } from "@/lib/preferences";
import { getSecret } from "@/lib/secrets";
import {
  flushRoster,
  loadBlobRoutines,
  loadRoster,
  loadUserMemories,
  saveBlobRoutines,
  saveBlobTranscript,
} from "@/lib/store";

/** Completes the first-run creator with the given Blob name. */
async function createFirstBlob(user: UserEvent, name = "Ken") {
  await user.type(screen.getByLabelText("Name"), name);
  await user.click(screen.getByRole("button", { name: "Get started" }));
}

/** Roster row with a store-legal id, numbered so ids stay unique. */
function seedBlob(index: number, name: string, extra: Partial<Agent> = {}): Agent {
  return {
    id: `61ec34f1-9ba5-4eff-b8e1-7acefb21${String(index).padStart(4, "0")}`,
    name,
    time: "Now",
    snippet: "New Blob. Say hello",
    tone: "blue",
    shape: "sphere",
    ...extra,
  };
}

/** Open a sidebar row's context menu. */
async function openRowMenu(user: UserEvent, name: RegExp) {
  const conversations = screen.getByRole("navigation", { name: "Conversations" });
  await user.pointer({
    keys: "[MouseRight]",
    target: within(conversations).getByRole("button", { name }),
  });
}

/** Let the store's debounced writes land. */
async function flushWrites() {
  window.dispatchEvent(new Event("beforeunload"));
  await new Promise((resolve) => setTimeout(resolve, 0));
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

    await user.click(screen.getByRole("button", { name: "New chat" }));
    const toField = screen.getByLabelText("Search or create Blobs");
    expect(toField).toHaveFocus();

    await user.type(toField, "Zed");
    await user.click(screen.getByRole("button", { name: 'Create new Blob "Zed"' }));

    // Creator opens prefilled; finishing it lands in the new chat.
    expect(screen.getByLabelText("Name")).toHaveValue("Zed");
    await user.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("heading", { name: "Zed", level: 1 })).toBeInTheDocument();
  });

  it("starts a group chat from the palette, and drops the old empty section", async () => {
    // A leftover "New section" from the sidebar's removed add button: empty
    // scaffolding, so the migration must not seed a placeholder group with it.
    // Seeded onboarded: this stub replaces the setup file's preference store,
    // and without the flag the first-run flow covers the app.
    const store = new Map<string, string>([
      ["pref:onboarded", "true"],
      ["pref:sections", JSON.stringify(["New section"])],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    try {
      const user = userEvent.setup();
      render(<App />);
      await createFirstBlob(user, "Ken");

      await user.click(screen.getByRole("button", { name: "New chat" }));
      await user.type(screen.getByLabelText("Search or create Blobs"), "Launch");
      await user.click(screen.getByRole("button", { name: 'New group chat "Launch"' }));

      // The group opens on creation, named as typed and empty until Blobs are
      // dragged in — which the empty state has to say, since nothing else does.
      expect(screen.getByLabelText("Group name")).toHaveValue("Launch");
      const conversations = screen.getByRole("navigation", { name: "Conversations" });
      expect(within(conversations).getByText("Drag Blobs here to add them")).toBeInTheDocument();
      expect(within(conversations).queryByText("New section")).not.toBeInTheDocument();

      // A second group asking for the same name gets a suffix instead. The
      // name IS the membership key (a Blob's `section`), so two groups
      // sharing one would each claim the other's Blobs.
      await user.click(screen.getByRole("button", { name: "New chat" }));
      await user.type(screen.getByLabelText("Search or create Blobs"), "launch");
      await user.click(screen.getByRole("button", { name: 'New group chat "launch"' }));
      expect(screen.getByLabelText("Group name")).toHaveValue("launch 2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens an existing Blob from the palette and dismisses on Escape", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "New chat" }));
    const palette = screen.getByRole("region", { name: "New chat" });
    await user.click(within(palette).getByRole("button", { name: /Ken/ }));
    expect(screen.getByRole("heading", { name: "Ken", level: 1 })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New chat" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Search or create Blobs")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ken", level: 1 })).toBeInTheDocument();
  });

  it("searches across Blobs and jumps to the one it finds", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");
    // A second Blob, so picking one is a real choice rather than the only row.
    await user.click(screen.getByRole("button", { name: "New chat" }));
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

  it("never lets two Blobs answer to the same name", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Scout");

    // `@Scout` resolves to the first match, so a second one would be
    // permanently unmentionable and the user could not say which they meant.
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await user.type(screen.getByLabelText("Search or create Blobs"), "scout");
    await user.click(screen.getByRole("button", { name: 'Create new Blob "scout"' }));
    await user.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("heading", { name: "scout 2", level: 1 })).toBeInTheDocument();

    // Renaming onto a taken name is refused the same way — the settings
    // field is the only rename UI, so this is the other half of the rule.
    await user.click(screen.getByRole("button", { name: "scout 2 settings" }));
    const panel = screen.getByRole("complementary", { name: "scout 2 settings" });
    const field = within(panel).getByLabelText("Name");
    await user.clear(field);
    // Typed in full first: settling per keystroke would fight the user — this
    // name passes the taken "Scout" on its way to "Scout Two".
    await user.type(field, "Scout Two");
    expect(field).toHaveValue("Scout Two");
    await user.tab();
    expect(screen.getByRole("heading", { name: "Scout Two", level: 1 })).toBeInTheDocument();

    // But landing on the taken name itself is still refused.
    await user.clear(field);
    await user.type(field, "Scout");
    await user.tab();
    expect(screen.getByRole("heading", { name: "Scout 2", level: 1 })).toBeInTheDocument();
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

  it("shows the Composio CLI as missing in the Plugins tab and never asks for a key", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Ken Kai/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("button", { name: "Plugins" }));

    // Outside Tauri the CLI probe reports absent, which must read as missing
    // rather than as a silent success.
    expect(await within(dialog).findByText(/Not installed/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Install" })).toBeInTheDocument();

    // The credential belongs to Composio's own CLI. If a key field ever comes
    // back here, it means the app started keeping a second copy.
    expect(within(dialog).queryByLabelText(/API key/)).not.toBeInTheDocument();

    // Skills read from disk, which jsdom has none of — the empty state must
    // say where to put one rather than showing a blank card.
    expect(within(dialog).getByText("Skills")).toBeInTheDocument();
    expect(await within(dialog).findByText(/No skills yet/)).toBeInTheDocument();
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

  it("browses plugins and reports why a connect failed, on the row that failed", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Plugins" }));
    const dialog = screen.getByRole("dialog", { name: "Plugins" });

    // Search narrows the marketplace. Connecting runs through Composio, so
    // outside Tauri nothing can be connected — and a tile must never read
    // "Connected" unless Composio said so.
    await user.type(within(dialog).getByLabelText("Search plugins"), "gmail");
    expect(within(dialog).queryByText("Connected")).not.toBeInTheDocument();

    // A failed connect explains itself on the row that was clicked. Without
    // this, a missing CLI and an abandoned browser tab are both just a button
    // that appeared to do nothing.
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByText(/only works in the desktop app/)).toBeInTheDocument();
    expect(within(dialog).queryByText("Connected")).not.toBeInTheDocument();

    // The detail view lists real accounts. With none connected it says so
    // rather than inventing a "Default" row that was never real.
    await user.clear(within(dialog).getByLabelText("Search plugins"));
    await user.click(within(dialog).getByRole("button", { name: /Gmail/ }));
    expect(within(dialog).getByText(/No account connected yet/)).toBeInTheDocument();

    // Naming a second account comes before the browser opens, because the CLI
    // requires an alias to tell two accounts on one app apart.
    await user.click(within(dialog).getByRole("button", { name: /Add Another Account/ }));
    expect(within(dialog).getByLabelText("Name for the new account")).toBeInTheDocument();

    // No "View Source" here: a link to someone else's repo answers a question
    // nobody asked while connecting an app. (`ExternalLink`'s navigation-
    // cancelling behaviour is covered by its own test.)
    expect(within(dialog).queryByRole("link", { name: /View Source/ })).not.toBeInTheDocument();

    // No per-account "Reconnect" either: `composio link` only creates, and
    // demands a new alias once an account exists, so the button added a row
    // instead of repairing one.
    expect(within(dialog).queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();

    // Nothing is stated before it is known. The panel used to render "Connect"
    // and a "Disconnected account" row while the probe was still out, then
    // correct itself — a label that changes under the user reads as a bug even
    // when the final state is right. Outside Tauri the probe resolves to
    // nothing, so the settled state is the empty one.
    expect(await within(dialog).findByText(/No account connected yet/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Disconnected account/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/gmail_/)).not.toBeInTheDocument();

    // Escape steps back to the list before closing.
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

  it("hides a Blob from the sidebar and brings it back", async () => {
    await flushRoster([seedBlob(1, "Ken"), seedBlob(2, "Bob")]);
    const user = userEvent.setup();
    render(<App />);
    const conversations = await screen.findByRole("navigation", { name: "Conversations" });

    await openRowMenu(user, /Bob/);
    await user.click(screen.getByRole("menuitem", { name: "Hide from sidebar" }));
    expect(within(conversations).queryByRole("button", { name: /Bob/ })).not.toBeInTheDocument();

    // A hidden Blob must stay reachable, or it is gone from the UI forever.
    await user.click(within(conversations).getByRole("button", { name: /Show hidden chats/ }));
    await openRowMenu(user, /Bob/);
    await user.click(screen.getByRole("menuitem", { name: "Unhide" }));

    expect(within(conversations).getByRole("button", { name: /Bob/ })).toBeInTheDocument();
    expect(
      within(conversations).queryByRole("button", { name: /Show hidden chats/ }),
    ).not.toBeInTheDocument();
  });

  it("duplicates a Blob's profile and routines, but not its memories", async () => {
    const source = seedBlob(1, "Ken", {
      tone: "pink",
      shape: "cloud",
      title: "Inbox triage",
      description: "Reads the inbox every morning",
      instructions: "Be terse",
      memories: [{ id: "m1", text: "Biscuit is a beagle", createdAt: 1 }],
      usage: { inputTokens: 100, outputTokens: 20, runs: 3 },
    });
    await flushRoster([source]);
    saveBlobRoutines(source.id, [
      {
        id: "routine-1",
        name: "Morning sweep",
        instruction: "Check the inbox",
        triggers: ["Every hour"],
        active: true,
        schedule: { kind: "interval", minutes: 60 },
        nextRunAt: 1,
        lastRunAt: 1,
        lastRunStatus: "done",
      },
    ]);
    await flushWrites();

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Ken", level: 1 });

    // By snippet: "Ken" alone also matches the "Ken Kai" account row.
    await openRowMenu(user, /Say hello/);
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));

    // The copy lands in Edit Profile, so it is renamed before anything fires.
    expect(
      await screen.findByRole("complementary", { name: "Ken copy settings" }),
    ).toBeInTheDocument();

    const roster = await loadRoster();
    const copy = roster?.find((row) => row.name === "Ken copy");
    expect(copy).toMatchObject({
      tone: "pink",
      shape: "cloud",
      title: "Inbox triage",
      description: "Reads the inbox every morning",
      instructions: "Be terse",
    });
    // Learned memory and lifetime usage belong to the original.
    expect(copy?.memories).toBeUndefined();
    expect(copy?.usage).toBeUndefined();

    await flushWrites();
    const copied = await loadBlobRoutines(copy?.id ?? "");
    expect(copied).toHaveLength(1);
    expect(copied?.[0]).toMatchObject({ name: "Morning sweep", active: true });
    expect(copied?.[0]?.id).not.toBe("routine-1");
    expect(copied?.[0]?.lastRunAt).toBeUndefined();
    expect(copied?.[0]?.lastRunStatus).toBeUndefined();
    // Re-armed: armRoutines only runs at startup, so a stale nextRunAt would
    // mean the copy's routine never fires.
    expect(copied?.[0]?.nextRunAt ?? 0).toBeGreaterThan(Date.now());
  });

  it("refuses to create or duplicate past the Blob cap", async () => {
    await flushRoster(
      Array.from({ length: MAX_BLOBS }, (_, index) => seedBlob(index, `Blob${index}`)),
    );
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Blob0", level: 1 });

    // Duplicate is not offered: the copy would silently never appear.
    await openRowMenu(user, /Blob0/);
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "New chat" }));
    await user.type(screen.getByLabelText("Search or create Blobs"), "Zed");
    await user.click(screen.getByRole("button", { name: 'Create new Blob "Zed"' }));

    expect(screen.getByRole("button", { name: "Get started" })).toBeDisabled();
    expect(
      screen.getByText(`You have the maximum of ${MAX_BLOBS} Blobs. Delete one to make room.`),
    ).toBeInTheDocument();
    expect((await loadRoster())?.length).toBe(MAX_BLOBS);
  });

  it("collapses a group and keeps its Blobs out of the list", async () => {
    // Seeded as a pre-group-chat "section" — which also proves the migration
    // into real groups keeps the Blobs that were in it.
    // Preferences live in localStorage, which this jsdom build does not provide.
    const store = new Map<string, string>([
      ["pref:onboarded", "true"],
      ["pref:sections", JSON.stringify(["Work"])],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    try {
      await flushRoster([seedBlob(1, "Ken", { section: "Work" })]);
      const user = userEvent.setup();
      render(<App />);
      const conversations = await screen.findByRole("navigation", { name: "Conversations" });

      // The rows animate shut rather than unmounting — the group has to stay a
      // drop target — so `inert` is what takes them off the tab order.
      const rows = () =>
        conversations.querySelector('[data-drop="section:Work"] .agent-group-rows');
      // The name opens the group's chat now; collapsing is the chevron beside it.
      const toggle = within(conversations).getByRole("button", {
        name: /^(Collapse|Expand) Work$/,
      });
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(rows()).not.toHaveAttribute("inert");

      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(rows()).toHaveAttribute("inert");
      expect(store.get("pref:sectionsCollapsed")).toBe('["Work"]');

      await user.click(toggle);
      expect(rows()).not.toHaveAttribute("inert");
      expect(within(conversations).getByRole("button", { name: /Say hello/ })).toBeVisible();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens the compose palette on Cmd+N", async () => {
    await flushRoster([seedBlob(1, "Ken")]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Ken", level: 1 });

    await user.keyboard("{Meta>}n{/Meta}");
    expect(screen.getByLabelText("Search or create Blobs")).toBeInTheDocument();
  });

  it("changes a Blob's avatar from Edit Profile", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Ken settings" }));
    const panel = screen.getByRole("complementary", { name: "Ken settings" });
    await user.click(within(panel).getByRole("radio", { name: "red" }));
    await user.click(within(panel).getByRole("radio", { name: "egg" }));

    await flushWrites();
    const roster = await loadRoster();
    expect(roster?.[0]).toMatchObject({ tone: "red", shape: "egg" });
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

describe("onboarding", () => {
  it("is off by default, so the rest of the suite sees the app", () => {
    // The setup file seeds this through localStorage. CI's jsdom provides one
    // and the local build does not, and a shim that skipped the provided one
    // seeded a Map nothing read: green locally, every other test drowned in
    // the onboarding overlay on CI.
    expect(readPreference("pref:onboarded", "false")).toBe("true");
  });

  /** Undo the suite default: this describe is about the un-onboarded app. */
  function clearOnboarded() {
    window.localStorage.removeItem("pref:onboarded");
    window.localStorage.removeItem("pref:forceOnboarding");
    window.localStorage.removeItem("pref:plugins");
  }

  it("walks a first run through to the app's own Blob creator", async () => {
    const user = userEvent.setup();
    clearOnboarded();
    render(<App />);

    // Scoped to the flow throughout: the app it covers has a creator pane
    // carrying some of the same labels.
    const flow = () => within(screen.getByRole("dialog", { name: "Welcome to Blobbies" }));
    await user.click(flow().getByRole("button", { name: /Get started/ }));

    // What a Blob is, then permissions: notifications are never requested on
    // render, only from Allow.
    expect(flow().getByRole("heading", { name: "Every Blob gets one job" })).toBeInTheDocument();
    await user.click(flow().getByRole("button", { name: "Next" }));
    expect(flow().getByRole("heading", { name: "A few things to settle" })).toBeInTheDocument();
    await user.click(flow().getByRole("button", { name: "Next" }));

    // Tinfoil is optional, but only through Skip. Next is not a second way
    // past an empty field: someone who pressed it would believe they had set
    // something up, and find out at the first model that will not answer.
    expect(flow().getByLabelText("API key")).toHaveValue("");
    expect(flow().getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(flow().getByRole("button", { name: /Skip, I'll use the local model/ }));
    expect(await getSecret("tinfoil-api-key")).toBeNull();

    // Composio is optional in the same way. It asks for no key at all — the
    // CLI owns that credential — so the only way past an unsigned-in state is
    // Skip, and Next stays shut.
    expect(flow().queryByLabelText(/API key/)).not.toBeInTheDocument();
    expect(flow().getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(flow().getByRole("button", { name: /Skip, I'll connect my apps later/ }));

    // Plugins picked here are the app's installed list, not a separate one.
    const gmail = flow().getByRole("button", { name: /Gmail/ });
    expect(gmail).toHaveAttribute("aria-pressed", "false");
    await user.click(gmail);
    expect(gmail).toHaveAttribute("aria-pressed", "true");

    // The last step hands over to the real creator rather than carrying a
    // second copy of it, so the Blob is made by the same code every other
    // path uses.
    await user.click(flow().getByRole("button", { name: "Make your first Blob" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const creator = screen.getByRole("region", { name: "New Blob" });

    await user.type(within(creator).getByLabelText("Name"), "Ken");
    await user.click(within(creator).getByRole("button", { name: "Get started" }));
    expect(await screen.findByRole("heading", { name: "Ken", level: 1 })).toBeInTheDocument();

    await flushWrites();
    expect((await loadRoster())?.[0]).toMatchObject({ name: "Ken" });
    // Completed once is completed for good.
    expect(window.localStorage.getItem("pref:onboarded")).toBe("true");
  });

  it("refuses a malformed Tinfoil key instead of storing it", async () => {
    const user = userEvent.setup();
    clearOnboarded();
    render(<App />);

    const flow = () => within(screen.getByRole("dialog", { name: "Welcome to Blobbies" }));
    await user.click(flow().getByRole("button", { name: /Get started/ }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: "Next" }));

    // What a fumbled paste looks like: the env-var name dragged along with
    // the value. Nothing may reach the keychain.
    await user.type(flow().getByLabelText("API key"), "TINFOIL_API_KEY=tk_abc");
    await user.click(flow().getByRole("button", { name: "Save" }));
    expect(await getSecret("tinfoil-api-key")).toBeNull();
    expect(flow().getByRole("status")).toHaveTextContent(/does not look like a key/);

    // A clean key is accepted and kept.
    await user.clear(flow().getByLabelText("API key"));
    await user.type(flow().getByLabelText("API key"), "tk_abcdefghijklmnop");
    await user.click(flow().getByRole("button", { name: "Save" }));
    expect(await getSecret("tinfoil-api-key")).toBe("tk_abcdefghijklmnop");
  });

  it("steps back to the previous screen", async () => {
    const user = userEvent.setup();
    clearOnboarded();
    render(<App />);

    const flow = () => within(screen.getByRole("dialog", { name: "Welcome to Blobbies" }));
    await user.click(flow().getByRole("button", { name: /Get started/ }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    expect(flow().getByRole("heading", { name: "A few things to settle" })).toBeInTheDocument();

    await user.click(flow().getByRole("button", { name: "Back" }));
    expect(flow().getByRole("heading", { name: "Every Blob gets one job" })).toBeInTheDocument();
  });

  it("opens the creator on a replay, where a roster already exists", async () => {
    // The dev toggle replays the flow with Blobs already on disk, so its exit
    // cannot rely on the empty-roster fallback that renders the creator.
    await flushRoster([seedBlob(1, "Ken")]);
    const user = userEvent.setup();
    clearOnboarded();
    render(<App />);

    const flow = () => within(screen.getByRole("dialog", { name: "Welcome to Blobbies" }));
    await user.click(flow().getByRole("button", { name: /Get started/ }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: /Skip, I'll use the local model/ }));
    await user.click(flow().getByRole("button", { name: /Skip, I'll connect my apps later/ }));
    await user.click(flow().getByRole("button", { name: "Make your first Blob" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "New Blob" })).toBeInTheDocument();
  });

  it("replays for VITE_ONBOARDING without writing a preference", () => {
    // Registered before the stub: a failed assertion below must not leave
    // the flag set for every test that follows.
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    // The dev flag behind `VITE_ONBOARDING=1 pnpm tauri dev`, which is how
    // the flow is reopened in the Tauri window (no editable URL there).
    vi.stubEnv("VITE_ONBOARDING", "1");
    // The suite default marks the app onboarded; the flag must win.
    render(<App />);

    expect(screen.getByRole("dialog", { name: "Welcome to Blobbies" })).toBeInTheDocument();
    // Replaying is not completing: neither preference is touched.
    expect(window.localStorage.getItem("pref:forceOnboarding")).toBeNull();
    expect(window.localStorage.getItem("pref:onboarded")).toBe("true");
  });

  it("is skipped once completed, and replayed by the dev toggle", async () => {
    const user = userEvent.setup();
    // The suite default marks the app onboarded.
    const { unmount } = render(<App />);
    expect(screen.queryByRole("dialog", { name: "Welcome to Blobbies" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Ken Kai/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    await user.click(screen.getByRole("switch", { name: "Show onboarding" }));

    // Visible where it was switched on, and again on the next launch.
    expect(screen.getByRole("dialog", { name: "Welcome to Blobbies" })).toBeInTheDocument();
    unmount();
    render(<App />);
    expect(screen.getByRole("dialog", { name: "Welcome to Blobbies" })).toBeInTheDocument();
  });
});
