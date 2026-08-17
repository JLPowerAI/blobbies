import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchModal } from "@/components/SearchModal";
import type { Agent, Message, Routine } from "@/data/agents";
import * as store from "@/lib/store";

// The palette reads whatever the app has not hydrated; stubbing the loaders is
// what proves it goes looking at all.
vi.mock("@/lib/home", () => ({ homeFor: () => ({ list: async () => [] }) }));
vi.spyOn(store, "loadBlobTranscript");
vi.spyOn(store, "loadBlobRoutines");

const nightly: Routine = {
  id: "r1",
  name: "Nightly digest",
  instruction: "Summarise the day",
  triggers: ["Every day at 9pm"],
  active: true,
};

const ken: Agent = {
  id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
  name: "Ken",
  time: "Now",
  snippet: "New Blob. Say hello",
  tone: "blue",
  shape: "sphere",
  lastActivityAt: 1_000,
};

const say = (id: string, text: string): Message => ({
  id,
  kind: "text",
  author: "agent",
  segments: [{ text }],
  timestampMs: 1_000,
});

const palette = (
  onSelect: (result: unknown) => void = () => {},
  transcripts: Record<string, Message[]> = {},
  groups: { id: string; name: string; memberNames: string[] }[] = [],
) => (
  <SearchModal
    agents={[ken]}
    groups={groups}
    transcripts={transcripts}
    routines={{}}
    hasChat={true}
    onSelect={onSelect as never}
    onClose={() => {}}
  />
);

const rows = () => screen.getAllByRole("button").filter((node) => node.dataset.row !== undefined);

describe("SearchModal", () => {
  beforeEach(() => {
    vi.mocked(store.loadBlobTranscript).mockReset().mockResolvedValue(null);
    vi.mocked(store.loadBlobRoutines).mockReset().mockResolvedValue(null);
  });

  it("finds the routines of a Blob the app never opened", async () => {
    // The app hydrates routines for the open Blob only, so anything else has
    // to come off disk or the tab would quietly under-report.
    const user = userEvent.setup();
    vi.mocked(store.loadBlobRoutines).mockResolvedValue([nightly]);
    render(palette());

    await user.click(screen.getByRole("button", { name: "Routines" }));
    expect(await screen.findByText("Nightly digest")).toBeInTheDocument();
    expect(screen.getByText("Every day at 9pm · Ken")).toBeInTheDocument();
  });

  it("opens on the Blobs and actions it can show without reading anything", () => {
    render(palette());

    expect(screen.getByText("Ken")).toBeInTheDocument();
    expect(screen.getByText("Chat Settings")).toBeInTheDocument();
    expect(screen.getByText("Plugins")).toBeInTheDocument();
    // Nothing was read to render those, so nothing was asked for.
    expect(store.loadBlobTranscript).not.toHaveBeenCalled();
    expect(store.loadBlobRoutines).not.toHaveBeenCalled();
  });

  it("says what is missing per tab, with the same shape everywhere", async () => {
    const user = userEvent.setup();
    render(palette());

    await user.click(screen.getByRole("button", { name: "Groups" }));
    expect(screen.getByText("No group chats yet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Routines" }));
    expect(await screen.findByText("No routines yet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Links" }));
    expect(await screen.findByText("No links yet")).toBeInTheDocument();
  });

  it("switches to a group chat from the Groups tab", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(palette(onSelect, {}, [{ id: "g1", name: "Launch", memberNames: ["Ken", "Zed"] }]));

    await user.click(screen.getByRole("button", { name: "Groups" }));
    // The row says who is in the group — the name alone rarely identifies it.
    expect(screen.getByText("Ken, Zed")).toBeInTheDocument();

    await user.click(screen.getByText("Launch"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "group", groupId: "g1" }),
    );
  });

  it("searches the messages of every Blob", async () => {
    const user = userEvent.setup();
    render(palette(() => {}, { [ken.id]: [say("m1", "AMYERA sunscreen, SPF50")] }));

    await user.click(screen.getByRole("button", { name: "Messages" }));
    await user.keyboard("sunscreen");

    expect(await screen.findByText(/AMYERA sunscreen/)).toBeInTheDocument();
  });

  it("shows one page at a time and loads the next on scroll", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 60 }, (_, position) =>
      say(`m${position}`, `message ${position}`),
    );
    render(palette(() => {}, { [ken.id]: many }));

    await user.click(screen.getByRole("button", { name: "Messages" }));
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("button")).toHaveLength(25);

    // jsdom reports zero heights, so any scroll counts as "near the end" —
    // which is exactly the condition the handler is checking.
    act(() => {
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(within(list).getAllByRole("button")).toHaveLength(50);
  });

  it("activates the highlighted row with Enter and the numbered rows with ⌘", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(palette(onSelect));

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: "action" }));

    onSelect.mockClear();
    await user.keyboard("{Meta>}1{/Meta}");
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "blob", blobId: ken.id }),
    );
  });

  it("keeps typing in the field after a tab is clicked", async () => {
    const user = userEvent.setup();
    render(palette());

    await user.click(screen.getByRole("button", { name: "Files" }));
    await user.keyboard("ken");
    expect(screen.getByRole("textbox", { name: "Search" })).toHaveValue("ken");
  });

  it("leaves the first row highlighted so Enter always has a target", () => {
    render(palette());
    expect(rows()[0]).toHaveAttribute("aria-current", "true");
  });
});
