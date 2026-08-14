import { render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "@/App";
import { flushRoster, loadRoster } from "@/lib/store";

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
      within(conversations).getByRole("button", { name: /New Blob\. Say hello/ }),
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
      within(log).getByText("New Blob. Say hello", { selector: ".bubble-quote" }),
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
