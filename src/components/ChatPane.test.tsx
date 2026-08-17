import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatPane } from "@/components/ChatPane";
import type { Agent, Message } from "@/data/agents";

const agent: Agent = {
  id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
  name: "Ken",
  time: "Now",
  snippet: "New Blob. Say hello",
  tone: "blue",
  shape: "sphere",
};

const messages: Message[] = [
  { id: "m1", kind: "text", author: "user", segments: [{ text: "So what can you do" }] },
  { id: "m2", kind: "text", author: "agent", segments: [{ text: "Plenty." }] },
];

/** ChatPane with everything that is not under test held constant. */
const pane = (
  thinking: boolean,
  onStop: () => void,
  withMessages = false,
  onSend: (text: string, replyTo?: string, files?: readonly File[]) => void = () => {},
) => (
  <ChatPane
    agent={agent}
    messages={withMessages ? messages : []}
    thinking={thinking}
    model=""
    onModelChange={() => {}}
    reasoning={false}
    onReasoningChange={() => {}}
    onSend={onSend}
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

  it("suppresses the latched hover on every row the cursor has left", () => {
    render(pane(false, vi.fn(), true));
    const [first, second] = screen
      .getAllByRole("toolbar", { name: "Message actions" })
      .map((toolbar) => toolbar.parentElement as HTMLElement);
    const move = (over: HTMLElement) => fireEvent.pointerOver(over, { bubbles: true });

    // Before the cursor has entered anything, nothing is suppressed: plain
    // :hover still reveals, so this can never subtract the actions entirely.
    expect(first).not.toHaveClass("message-row-stale");
    expect(second).not.toHaveClass("message-row-stale");

    move(first as HTMLElement);
    expect(first).not.toHaveClass("message-row-stale");
    expect(second).toHaveClass("message-row-stale");

    // Cursor moves on: the row left behind is suppressed even though no leave
    // event ever fired for it, so two bars can't show at once.
    move(second as HTMLElement);
    expect(first).toHaveClass("message-row-stale");
    expect(second).not.toHaveClass("message-row-stale");

    // Off the rows entirely (another pane fires nothing on the row at all).
    move(document.body);
    expect(second).toHaveClass("message-row-stale");

    // Cursor leaves the window — no move event lands anywhere.
    move(second as HTMLElement);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(second).toHaveClass("message-row-stale");
  });

  it("attaches picked files to the next message, and lets one be removed", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(pane(false, vi.fn(), false, onSend));

    const keep = new File(["columns"], "data.csv", { type: "text/csv" });
    const drop = new File(["draft"], "notes.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("Attach files"), [keep, drop]);

    // Both chips show; removing one leaves the other attached.
    expect(screen.getByText("data.csv")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove notes.md" }));
    expect(screen.queryByText("notes.md")).not.toBeInTheDocument();

    // Files alone are a message: no typing needed for Send to appear.
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("", undefined, [keep]);
    // Sent means gone from the composer, so the next message can't resend it.
    expect(screen.queryByText("data.csv")).not.toBeInTheDocument();
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
