import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatPane } from "@/components/ChatPane";
import type { Agent, Message } from "@/data/agents";
import type { PickedFile } from "@/lib/attachments";

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
  withMessages: Message[] = [],
  onSend: (text: string, replyTo?: string, files?: readonly PickedFile[]) => void = () => {},
) => (
  <ChatPane
    agent={agent}
    messages={withMessages}
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
    render(pane(false, vi.fn(), messages));
    const [first, second] = screen
      .getAllByRole("toolbar", { name: "Message actions" })
      // The bar lives inside .message-line beside its bubble; the state it
      // asserts (message-row-stale) is on the row above that.
      .map((toolbar) => toolbar.closest(".message-row") as HTMLElement);
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

  it("marks the transcript with a time divider after a silence or a day change, not every message", () => {
    // 09:00, a reply seconds later, then 09:20 after a silence, then the next
    // day — the shape a real conversation takes.
    const day1 = new Date(2026, 7, 12, 9, 0).getTime();
    render(
      pane(false, vi.fn(), [
        {
          id: "t1",
          kind: "text",
          author: "user",
          segments: [{ text: "morning" }],
          timestampMs: day1,
        },
        {
          id: "t2",
          kind: "text",
          author: "agent",
          segments: [{ text: "hi" }],
          timestampMs: day1 + 4_000,
        },
        {
          id: "t3",
          kind: "text",
          author: "user",
          segments: [{ text: "back now" }],
          timestampMs: day1 + 20 * 60_000,
        },
        {
          id: "t4",
          kind: "text",
          author: "agent",
          segments: [{ text: "welcome back" }],
          timestampMs: day1 + 26 * 60 * 60_000,
        },
      ]),
    );
    const dividers = screen.getAllByText(/AM|PM|August|Wednesday/i, {
      selector: ".timestamp-divider",
    });
    // One above the first message, one after the 20-minute silence, one for
    // the new day — and none between the seconds-apart pair.
    expect(dividers).toHaveLength(3);
    expect(dividers[0]?.textContent).toMatch(/9:00/);
    expect(dividers[1]?.textContent).toMatch(/9:20/);
    expect(dividers[2]?.textContent).toMatch(/Wednesday|Thursday/);
  });

  it("attaches picked files to the next message, and lets one be removed", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(pane(false, vi.fn(), [], onSend));

    const keep = new File(["columns"], "data.csv", { type: "text/csv" });
    const drop = new File(["draft"], "notes.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("Attach files"), [keep, drop]);

    // Both chips show; removing one leaves the other attached.
    expect(screen.getByText("data.csv")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove notes.md" }));
    expect(screen.queryByText("notes.md")).not.toBeInTheDocument();

    // Files alone are a message: no typing needed for Send to appear.
    await user.click(screen.getByRole("button", { name: "Send message" }));
    // Sent clears the composer on the same frame, however long the thumbnails
    // take — so the next message cannot resend this file.
    expect(screen.queryByText("data.csv")).not.toBeInTheDocument();
    // The send waits for the thumbnail (jsdom renders none, so the file goes
    // on its own) and hands the file over with it, not bare.
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("", undefined, [{ file: keep }]));
  });

  it("gives a table its own bubble, so it is not squeezed by the prose around it", () => {
    const reply = [
      "Here you go:",
      "",
      "| Date | Model |",
      "| --- | --- |",
      "| Aug 14 | GLM-5.3 |",
      "",
      "Anything else?",
    ].join("\n");
    render(
      pane(false, vi.fn(), [
        { id: "t1", kind: "text", author: "agent", segments: [{ text: reply }] },
      ]),
    );

    // One message, three bubbles: prose, the table on its own, prose.
    const stack = document.querySelector(".bubble-stack") as HTMLElement;
    expect(stack.querySelectorAll(":scope > .bubble")).toHaveLength(3);
    expect(stack.querySelectorAll(".bubble-table")).toHaveLength(1);
    // The table bubble holds the table and nothing else.
    const table = stack.querySelector(".bubble-table") as HTMLElement;
    expect(within(table).getByRole("table")).toBeInTheDocument();
    expect(table.textContent).not.toMatch(/Anything else/);
  });

  it("leaves a reply without a table as a single bubble", () => {
    render(
      pane(false, vi.fn(), [
        { id: "t1", kind: "text", author: "agent", segments: [{ text: "Just words." }] },
      ]),
    );
    const stack = document.querySelector(".bubble-stack") as HTMLElement;
    expect(stack.querySelectorAll(":scope > .bubble")).toHaveLength(1);
    expect(stack.querySelector(".bubble-table")).toBeNull();
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
