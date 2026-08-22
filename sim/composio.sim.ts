/**
 * Live check of the Composio MCP transport that replaced the CLI.
 *
 * This talks to Composio's real hosted endpoint, so it needs a key and is
 * skipped without one:
 *
 * ```
 * COMPOSIO_API_KEY=ck_... pnpm sim:composio
 * ```
 *
 * Worth running live rather than mocking: the failure that made this rewrite
 * necessary was a transport assumption (the CLI does not exist on Windows),
 * and the second one was a header name — `x-api-key` returns 401 here, only
 * `x-consumer-api-key` works. Neither shows up against a fake server.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

/** Stand in for the OS keychain, which needs Tauri IPC that vitest has not. */
let storedKey = "";
vi.mock("@/lib/secrets", () => ({
  getSecret: async () => storedKey,
}));

import {
  ComposioError,
  callComposioTool,
  composioReachable,
  forgetComposioSession,
} from "@/lib/composio-mcp";

const KEY = process.env.COMPOSIO_API_KEY ?? "";
const LIVE = KEY !== "";

beforeAll(() => {
  storedKey = KEY;
  forgetComposioSession();
});

describe.skipIf(!LIVE)("composio over MCP", () => {
  it("handshakes with the pinned endpoint", async () => {
    expect(await composioReachable()).toBe(true);
  }, 90_000);

  it("finds tools for a task, the way app_find_tool does", async () => {
    const out = await callComposioTool("COMPOSIO_SEARCH_TOOLS", {
      use_case: "send an email with gmail",
    });
    console.log(`   search -> ${out.replace(/\s+/g, " ").slice(0, 180)}`);
    expect(out.length).toBeGreaterThan(50);
    expect(out.toUpperCase()).toContain("GMAIL");
  }, 90_000);

  it("returns a tool schema, the way app_tool_schema does", async () => {
    const out = await callComposioTool("COMPOSIO_GET_TOOL_SCHEMAS", {
      tool_slugs: ["GMAIL_FETCH_EMAILS"],
    });
    console.log(`   schema -> ${out.replace(/\s+/g, " ").slice(0, 180)}`);
    expect(out.toUpperCase()).toContain("GMAIL_FETCH_EMAILS");
  }, 90_000);

  it("lists connections, the way the Plugins tab does", async () => {
    const out = await callComposioTool("COMPOSIO_MANAGE_CONNECTIONS", { action: "list" });
    console.log(`   connections -> ${out.replace(/\s+/g, " ").slice(0, 180)}`);
    expect(typeof out).toBe("string");
  }, 90_000);

  it("refuses Composio's remote sandbox tools", async () => {
    // The allowlist is the whole reason a Blob cannot be talked into running
    // COMPOSIO_REMOTE_BASH_TOOL, which would execute in Composio's cloud
    // against uploaded files — off-device processing this app exists to avoid.
    for (const banned of ["COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_REMOTE_WORKBENCH"]) {
      await expect(callComposioTool(banned, {})).rejects.toBeInstanceOf(ComposioError);
    }
  });

  it("reports a bad key as something a person can act on", async () => {
    storedKey = "ck_definitely_not_valid";
    forgetComposioSession();
    await expect(callComposioTool("COMPOSIO_SEARCH_TOOLS", { use_case: "x" })).rejects.toThrow(
      /reconnect|rejected/i,
    );
    storedKey = KEY;
    forgetComposioSession();
  }, 90_000);
});
