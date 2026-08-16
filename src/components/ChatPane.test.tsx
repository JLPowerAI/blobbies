import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatPane } from "@/components/ChatPane";
import type { Agent } from "@/data/agents";

const agent: Agent = {
  id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
  name: "Ken",
  time: "Now",
  snippet: "New Blob. Say hello",
  tone: "blue",
  shape: "sphere",
};

/** ChatPane with everything that is not under test held constant. */
const pane = (thinking: boolean, onStop: () => void) => (
  <ChatPane
    agent={agent}
    messages={[]}
    thinking={thinking}
    model=""
    onModelChange={() => {}}
    reasoning={false}
    onReasoningChange={() => {}}
    onSend={() => {}}
    onStop={onStop}
    detailOpen={false}
    onToggleDetail={() => {}}
    onOpenSettings={() => {}}
  />
);

describe("ChatPane", () => {
  it("turns the send circle into Stop while replying, and takes Escape", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const { rerender } = render(pane(false, onStop));

    // Idle: the circle sends or dictates, and nothing offers to stop.
    expect(screen.queryByRole("button", { name: "Stop replying" })).not.toBeInTheDocument();

    rerender(pane(true, onStop));
    // The thinking blob is a status only; the control lives in the composer,
    // where the same circle that started the turn now ends it.
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    const stop = screen.getByRole("button", { name: "Stop replying" });
    // The red styling hangs off this attribute, so it must be the string CSS
    // matches, not a dropped boolean.
    expect(stop).toHaveAttribute("data-stop", "true");
    await user.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    expect(onStop).toHaveBeenCalledTimes(2);

    // Unlistened once the reply lands: Escape belongs to the composer again.
    rerender(pane(false, onStop));
    await user.keyboard("{Escape}");
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("keeps Send reachable mid-reply, so a follow-up can steer the turn", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(pane(true, onStop));

    await user.type(screen.getByRole("textbox", { name: "Message Ken" }), "actually, in French");
    // A typed draft is a follow-up: the circle goes back to Send, never a
    // dead Stop that swallows the message the user just wrote.
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop replying" })).not.toBeInTheDocument();
  });
});
