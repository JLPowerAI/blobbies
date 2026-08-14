import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";

const { greet, openExternal } = vi.hoisted(() => ({
  greet: vi.fn<(name: string) => Promise<string>>(),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock("@/lib/tauri", () => ({ greet, openExternal }));

describe("App", () => {
  beforeEach(() => {
    greet.mockReset();
    openExternal.mockReset();
    openExternal.mockResolvedValue();
  });

  it("shows the greeting returned by the Rust backend", async () => {
    greet.mockResolvedValue("Hello, Ada!");
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.click(screen.getByRole("button", { name: "Greet" }));

    expect(greet).toHaveBeenCalledWith("Ada");
    await expect(screen.findByRole("status")).resolves.toHaveTextContent("Hello, Ada!");
  });

  it("shows the validation message a Rust command rejects with", async () => {
    // Tauri rejects with the serialized error value, not an `Error` instance.
    greet.mockRejectedValue("input must not be empty");
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Greet" }));

    await expect(screen.findByRole("alert")).resolves.toHaveTextContent("input must not be empty");
  });

  it("falls back to a generic message when the IPC transport itself fails", async () => {
    greet.mockRejectedValue(new Error("connection closed"));
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Greet" }));

    await expect(screen.findByRole("alert")).resolves.toHaveTextContent("connection closed");
  });

  it("opens external links in the system browser, not the webview", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByAltText("Tauri logo"));

    expect(openExternal).toHaveBeenCalledWith("https://tauri.app/");
  });
});
