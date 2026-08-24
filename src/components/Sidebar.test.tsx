import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sidebar } from "@/components/Sidebar";
import type { Agent } from "@/data/agents";
import type { BlobActivity } from "@/lib/activity";

const ken: Agent = {
  id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
  name: "Ken",
  time: "Now",
  snippet: "Here are the three links.",
  tone: "blue",
  shape: "sphere",
};

/** The rail with everything not under test held constant. */
const rail = (activity?: Record<string, BlobActivity>, pinned = false) => (
  <Sidebar
    agents={[pinned ? { ...ken, pinned: true } : ken]}
    selectedId={ken.id}
    groups={[]}
    selectedGroupId={null}
    onSelectGroup={() => {}}
    onChangeGroups={() => {}}
    onRenameGroup={() => {}}
    composing={false}
    userName="Ken Kai"
    thinkingId={activity === undefined ? null : ken.id}
    {...(activity === undefined ? {} : { activity })}
    onSelect={() => {}}
    onStartCompose={() => {}}
    onOpenSettings={() => {}}
    onOpenPlugins={() => {}}
    onOpenSearch={() => {}}
    onUpdateBlob={() => {}}
    onEditProfile={() => {}}
    onDuplicate={() => {}}
    onDelete={() => {}}
  />
);

describe("a running Blob's row", () => {
  it("states what it is doing in place of its last message", () => {
    const { rerender } = render(rail());
    expect(screen.getByText("Here are the three links.")).toBeTruthy();

    // While the turn runs the snippet is stale by definition — it is the
    // message the Blob is busy replacing — so the live status takes its place.
    rerender(rail({ [ken.id]: "searching" }));
    expect(screen.getByText("Searching\u2026")).toBeTruthy();
    expect(screen.queryByText("Here are the three links.")).toBeNull();

    // Tracks the turn rather than saying "busy" for the whole of it.
    rerender(rail({ [ken.id]: "writing" }));
    expect(screen.getByText("Writing\u2026")).toBeTruthy();

    // Turn over: back to what the Blob actually said.
    rerender(rail());
    expect(screen.getByText("Here are the three links.")).toBeTruthy();
  });

  it("captions its pinned tile without hiding which Blob it is", () => {
    const { rerender } = render(rail(undefined, true));
    rerender(rail({ [ken.id]: "working" }, true));
    // A tile carries no other text, so the status goes UNDER the name rather
    // than over it — losing the name would leave the avatar as the only clue.
    expect(screen.getByText("Working\u2026")).toBeTruthy();
    expect(screen.getAllByText("Ken").length).toBeGreaterThan(0);
  });
});
