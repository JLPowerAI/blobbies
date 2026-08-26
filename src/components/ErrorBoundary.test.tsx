import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { messageCard } from "@/components/cards/registry";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { Message } from "@/data/agents";

function Boom(): never {
  throw new Error("bubble exploded");
}

describe("ErrorBoundary", () => {
  it("shows the error instead of unmounting the tree, and offers it for copying", async () => {
    // React logs every caught error; the test asserts the surface, not the noise.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("bubble exploded");

    await userEvent.click(screen.getByRole("button", { name: "Copy error" }));
    // The component stack is the only thing naming WHICH view threw, and the
    // console it is logged to is exactly what a person reporting this cannot
    // reach — so it has to be in what the button hands them.
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("bubble exploded"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Component stack:"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Boom"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

    logged.mockRestore();
    vi.unstubAllGlobals();
  });

  it("renders the children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeInTheDocument();
  });
});

describe("messageCard", () => {
  it("loses only the one bad message, not the conversation around it", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // A card that throws while rendering: a hand-edited transcript, or a
    // shape from a newer build that this one's view cannot read.
    const cursed = {
      id: "m9",
      kind: "text",
      author: "agent",
      get segments(): never {
        throw new Error("card exploded");
      },
    } as unknown as Message;
    const fine: Message = {
      id: "m8",
      kind: "text",
      author: "agent",
      segments: [{ text: "still here" }],
    };
    render(
      <div>
        {messageCard(fine).node}
        {messageCard(cursed).node}
      </div>,
    );
    // The neighbour survived; only the broken line is replaced.
    expect(screen.getByText("still here")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("can't be shown in this version");
    logged.mockRestore();
  });

  it("places a message a newer build wrote instead of throwing", () => {
    // Exactly what a hand-edited transcript on disk can contain.
    const fromTheFuture = { id: "m1", kind: "hologram", text: "hi" } as unknown as Message;
    render(<div>{messageCard(fromTheFuture).node}</div>);
    // Says what happened without printing the raw type: this is a line in
    // someone's conversation, not a log.
    expect(screen.getByRole("note")).toHaveTextContent("can't be shown in this version");
  });

  it("renders a text message as its bubble", () => {
    const said: Message = { id: "m2", kind: "text", author: "agent", segments: [{ text: "yo" }] };
    render(<div>{messageCard(said).node}</div>);
    expect(screen.getByText("yo")).toBeInTheDocument();
  });
});
