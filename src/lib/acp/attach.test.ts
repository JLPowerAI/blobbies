import { describe, expect, it } from "vitest";
import { initializeClientName } from "@/lib/acp/attach";

/**
 * The client's name decides whether a connection skips the pairing prompt, and
 * it arrives from a process that was unauthenticated a moment earlier — so
 * these are the rules that keep it a label rather than a way in.
 */
describe("initializeClientName", () => {
  it("reads the name an editor gives", () => {
    expect(
      initializeClientName(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "Zed" } },
        }),
      ),
    ).toBe("Zed");
  });

  it("ignores frames that are not an initialize", () => {
    expect(initializeClientName(JSON.stringify({ method: "session/prompt" }))).toBeUndefined();
    expect(initializeClientName("not json")).toBeUndefined();
    expect(initializeClientName("[]")).toBeUndefined();
  });

  it("gives a nameless client a placeholder, never an identity", () => {
    const anonymous = JSON.stringify({ method: "initialize", params: {} });
    expect(initializeClientName(anonymous)).toBe("Unknown editor");
    expect(
      initializeClientName(
        JSON.stringify({ method: "initialize", params: { clientInfo: { name: 42 } } }),
      ),
    ).toBe("Unknown editor");
  });

  it("strips control characters, so a name cannot fake dialog copy", () => {
    const name = "Zed\n\nAlready approved by you\u0007";
    expect(
      initializeClientName(
        JSON.stringify({ method: "initialize", params: { clientInfo: { name } } }),
      ),
    ).toBe("ZedAlready approved by you");
  });

  it("clips a name long enough to run off the dialog", () => {
    const name = "A".repeat(500);
    const read = initializeClientName(
      JSON.stringify({ method: "initialize", params: { clientInfo: { name } } }),
    );
    expect(read).toHaveLength(64);
  });

  it("treats an all-whitespace name as nameless", () => {
    expect(
      initializeClientName(
        JSON.stringify({ method: "initialize", params: { clientInfo: { name: "   " } } }),
      ),
    ).toBe("Unknown editor");
  });
});
