import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  composioAccounts,
  forgetComposioAccounts,
  setComposioToolkits,
  startComposioLink,
  waitForComposioLink,
} from "@/lib/composio";

/**
 * Stand in for the transport, so these tests exercise the parsing rather than
 * the network. The shapes below are real captures from
 * connect.composio.dev, trimmed — inventing them would test a fiction.
 */
const reply = vi.hoisted(() => ({ text: "" }));
vi.mock("@/lib/composio-mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/composio-mcp")>()),
  callComposioTool: async () => reply.text,
}));

describe("composioAccounts", () => {
  beforeEach(() => {
    forgetComposioAccounts();
    setComposioToolkits([]);
  });

  it("asks for nothing when the user has added no apps", async () => {
    // Composio's listing is per-toolkit and takes no wildcard: asking about
    // all 942 catalog entries to learn the user has none would be absurd.
    reply.text = "{}";
    await expect(composioAccounts()).resolves.toEqual([]);
  });

  it("reads accounts, and the identity that used to cost a call each", async () => {
    // The old CLI needed a separate 3.1s round trip per account to learn an
    // address; this listing carries user_info inline.
    reply.text = JSON.stringify({
      data: {
        results: {
          gmail: {
            toolkit: "gmail",
            status: "active",
            accounts: [
              {
                id: "gmail_casava-tst",
                status: "active",
                user_info: { emailAddress: "someone@example.com", messagesTotal: 8471 },
              },
            ],
          },
        },
      },
    });
    setComposioToolkits(["gmail"]);
    const [account] = await composioAccounts();
    expect(account).toMatchObject({
      toolkit: "gmail",
      id: "gmail_casava-tst",
      identity: "someone@example.com",
      active: true,
    });
  });

  it("takes whichever identity field the provider happens to use", async () => {
    // Each integration returns its own shape: GitHub has `login`, Slack has a
    // display name, and a provider with none must not break the row.
    reply.text = JSON.stringify({
      data: {
        results: {
          github: {
            toolkit: "github",
            accounts: [{ id: "gh_1", status: "active", user_info: { login: "octocat" } }],
          },
          notion: {
            toolkit: "notion",
            accounts: [{ id: "no_1", status: "active", user_info: { plan: "team" } }],
          },
        },
      },
    });
    setComposioToolkits(["github", "notion"]);
    const rows = await composioAccounts();
    expect(rows.find((row) => row.toolkit === "github")?.identity).toBe("octocat");
    // No usable field is "" — the caller falls back to the handle rather than
    // rendering `undefined`.
    expect(rows.find((row) => row.toolkit === "notion")?.identity).toBe("");
  });

  it("keeps a broken account, marked inactive", async () => {
    // Dropping these would make a expired connection look like no connection,
    // and the user would reconnect blind instead of seeing what failed.
    reply.text = JSON.stringify({
      data: {
        results: {
          slack: { toolkit: "slack", accounts: [{ id: "sl_1", status: "expired" }] },
        },
      },
    });
    setComposioToolkits(["slack"]);
    const [account] = await composioAccounts();
    expect(account).toMatchObject({ status: "expired", active: false });
  });

  it("answers [] rather than throwing when the reply is not JSON", async () => {
    // A transport error arrives here as its message text. The Plugins tab must
    // render an empty list, not crash on the way in.
    reply.text = "Composio rejected the key. Open Settings \u2192 Plugins and reconnect.";
    setComposioToolkits(["gmail"]);
    await expect(composioAccounts()).resolves.toEqual([]);
  });
});

describe("startComposioLink", () => {
  it("pulls the consent URL out of the surrounding JSON", async () => {
    // The link arrives embedded in a JSON blob, so the trailing quote must not
    // ride along into the browser.
    reply.text = JSON.stringify({
      data: { redirect_url: "https://backend.composio.dev/s/AbC123", status: "initiated" },
    });
    await expect(startComposioLink("gmail")).resolves.toBe("https://backend.composio.dev/s/AbC123");
  });

  it("refuses to open anything when no link came back", async () => {
    // Better a message than opening an unexpected page.
    reply.text = JSON.stringify({ data: {}, error: "toolkit not found" });
    await expect(startComposioLink("nope")).rejects.toThrow(/did not return a link/);
  });

  it("never returns a non-https link", async () => {
    // The result is handed straight to the OS opener, so a javascript: or
    // file: URL smuggled into the reply must not reach it.
    reply.text = JSON.stringify({ data: { redirect_url: "javascript:alert(1)" } });
    await expect(startComposioLink("gmail")).rejects.toThrow(/did not return a link/);
  });
});

/**
 * Outside Tauri `composioAccounts` answers `[]`, so the wait never sees a new
 * account — exactly the shape of the real complaint: the browser tab is
 * abandoned and nothing ever arrives. Without the signal the loop then holds
 * the row on "Waiting…" with nothing to press.
 *
 * Not covered here: expiry itself. `LINK_TIMEOUT_MS` is 90s and deliberately
 * not exported, so asserting it would mean either waiting out the window or
 * widening the module's surface for the test's benefit. The cancel path below
 * is the one a user actually hits; expiry needs a manual check — click
 * Connect, close the tab, wait 90s, expect the row to offer Connect again.
 */
describe("waitForComposioLink", () => {
  it("gives up as soon as the user cancels", async () => {
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    await expect(waitForComposioLink("gmail", [], controller.signal)).resolves.toBe(false);
    // The point is that it returned at all rather than sitting out the window;
    // one poll interval is 2s, so anything prompt proves the exit is taken.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("ends a wait cancelled while it is already sleeping", async () => {
    const controller = new AbortController();
    const waiting = waitForComposioLink("slack", [], controller.signal);
    // Mid-flight, which is when a user actually presses Cancel.
    setTimeout(() => controller.abort(), 50);

    const started = Date.now();
    await expect(waiting).resolves.toBe(false);
    // Sleeping through the abort would cost a full 2s poll interval.
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
