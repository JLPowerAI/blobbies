import { beforeEach, describe, expect, it, vi } from "vitest";
import { openExternal, runCommand } from "@/lib/tauri";

describe("openExternal", () => {
  it("refuses schemes that act on this machine", async () => {
    // These reach `openExternal` from agent markdown, which is remote text.
    // Handed to the *system* opener they run code, read files, or drive
    // another app; http(s) can only ever open a browser. Each must be refused
    // before the opener is called at all.
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "vscode://file/etc/passwd",
      "smb://server/share",
      "not a url",
    ]) {
      await expect(openExternal(url)).rejects.toThrow(/valid URL|web links/);
    }
  });

  it("lets any web link through the scheme guard", async () => {
    // An agent cites arbitrary sites, so a host allowlist here could only be
    // an incomplete list of dead links. Reaching the opener is success; what
    // it does next belongs to the desktop runtime, absent under test.
    for (const url of ["https://theverge.com/article", "http://example.com/page"]) {
      await expect(openExternal(url)).rejects.not.toThrow(/valid URL|web links/);
    }
  });
});

describe("runCommand", () => {
  const invoke = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // The IPC is stubbed at the window object rather than by mocking
    // `@tauri-apps/api/core`: the shared test setup imports `@/lib/store`,
    // which loads the real module before any per-file mock registers, so a
    // `vi.mock` here silently does nothing. `invoke()` delegates to this
    // property, and `isTauri()` reads the same marker — one stub covers both.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  });

  it("names the Blob whose home folder contains the call", async () => {
    // The id is the containment root Rust resolves every path argument
    // against (`shell.rs`). If it stopped being threaded through, the
    // file-reading programs would be refused for want of a sandbox —
    // fail-closed, but silently broken for every user.
    invoke.mockResolvedValueOnce({ stdout: "ok", stderr: "", code: 0 });
    await runCommand("cat", ["notes.md"], "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea");
    expect(invoke.mock.calls[0]?.[0]).toBe("shell_run");
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
      program: "cat",
      args: ["notes.md"],
    });
  });

  it("sends an explicit null when the caller has no home to offer", async () => {
    invoke.mockResolvedValueOnce({ stdout: "", stderr: "", code: 0 });
    await runCommand("composio", ["--version"]);
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      id: null,
      program: "composio",
      args: ["--version"],
    });
  });

  it("returns a refusal as text so a failed command never aborts the turn", async () => {
    invoke.mockRejectedValueOnce(new Error("`rg --pre` is not an allowed option"));
    const result = await runCommand("rg", ["--pre=/bin/sh", "x"], "blob");
    expect(result).toBe("`rg --pre` is not an allowed option");
  });
});
