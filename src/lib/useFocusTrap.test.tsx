import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ModalShell } from "@/components/ModalShell";

function Harness({ open }: { open: boolean }) {
  return (
    <>
      <button type="button">Behind the dialog</button>
      {open ? (
        <ModalShell title="Memories" ariaLabel="Memories" onClose={() => {}}>
          <button type="button">First</button>
          <button type="button">Second</button>
        </ModalShell>
      ) : null}
    </>
  );
}

describe("useFocusTrap", () => {
  it("cycles Tab inside the dialog instead of walking out behind it", async () => {
    const user = userEvent.setup();
    render(<Harness open />);

    const close = screen.getByRole("button", { name: "Close memories" });
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Second" });
    const outside = screen.getByRole("button", { name: "Behind the dialog" });

    // From the dialog itself (where focus lands on open) forward through it.
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab();
    expect(last).toHaveFocus();

    // The edge: past the last stop is the first one, never the page behind.
    await user.tab();
    expect(last).not.toHaveFocus();
    expect(outside).not.toHaveFocus();
    expect(close).toHaveFocus();

    // And backwards off the first stop wraps to the last, the same way.
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab({ shift: true });
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    expect(outside).not.toHaveFocus();
  });

  it("gives focus back to whatever opened it", () => {
    const { rerender } = render(<Harness open={false} />);
    const opener = screen.getByRole("button", { name: "Behind the dialog" });
    opener.focus();

    rerender(<Harness open />);
    expect(opener).not.toHaveFocus();

    rerender(<Harness open={false} />);
    expect(opener).toHaveFocus();
  });
});
