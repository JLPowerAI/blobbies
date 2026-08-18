import { describe, expect, it } from "vitest";
import { openExternal } from "@/lib/tauri";

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
