import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  composioAccounts,
  forgetComposioAccounts,
  setComposioToolkits,
  startComposioLink,
  waitForComposioLink,
} from "@/lib/composio";
import { rememberTinfoilWindows } from "@/lib/context-window";

/**
 * Stand in for the transport, so these tests exercise the parsing rather than
 * the network. The shapes below are real captures from
 * connect.composio.dev, trimmed — inventing them would test a fiction.
 */
const reply = vi.hoisted(() => ({ text: "", asked: [] as string[] }));
vi.mock("@/lib/composio-mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/composio-mcp")>()),
  callComposioTool: async (_name: string, args: Record<string, unknown>) => {
    const toolkits = (args.toolkits ?? []) as { name: string }[];
    reply.asked = toolkits.map((entry) => entry.name);
    return reply.text;
  },
}));

describe("composioAccounts", () => {
  beforeEach(() => {
    forgetComposioAccounts();
    setComposioToolkits([]);
  });

  it("asks about the whole catalog, not just the apps added in this app", async () => {
    // The bug this covers: the ask-list came from settings.plugins, so an app
    // connected on Composio's own site — or by a Blob calling
    // MANAGE_CONNECTIONS itself — was never asked about. Observed live with
    // four accounts active and two named: the Plugins tab showed two, the
    // prompt named two, and a Blob denied having Reddit while holding a
    // working Reddit tool.
    reply.text = "{}";
    setComposioToolkits([]);
    await composioAccounts();
    expect(reply.asked.length).toBeGreaterThan(100);
    expect(reply.asked).toContain("reddit");
    expect(reply.asked).toContain("gmail");
  });

  it("still asks about an app that settings knows and the catalog does not", async () => {
    // A slug can outlive its catalog entry, and dropping it would make a live
    // connection vanish from the tab that manages it.
    reply.text = "{}";
    setComposioToolkits(["some-private-toolkit"]);
    await composioAccounts();
    expect(reply.asked).toContain("some-private-toolkit");
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

describe("app tool results", () => {
  it("caps an oversized app result to what the model's window can hold", async () => {
    // The gap this closes, from a real run: GITHUB_SEARCH_REPOSITORIES answers
    // with tens of thousands of tokens. Every other tool output in the app was
    // bounded — web_fetch by window, local MCP at 3,000, read_file at 6,000 —
    // and this path had no cap at all, so a bulk search could hand a 16k local
    // window a megabyte and push the conversation out of it.
    const { makeComposioTools } = await import("@/lib/blob-tools");
    // Sized between the two budgets on purpose: far past a 16k window's share
    // and comfortably inside an enclave model's, so one payload proves both
    // that the cut happens and that it is not applied to a model with room.
    reply.text = JSON.stringify({ items: Array.from({ length: 200 }, () => "repo".repeat(50)) });
    expect(reply.text.length).toBeGreaterThan(30_000);
    expect(reply.text.length).toBeLessThan(60_000);

    const run = makeComposioTools("qwen3.5:9b").find((tool) => tool.name === "app_run_tool");
    const result = String(
      await run?.execute({ tool: "GITHUB_SEARCH_REPOSITORIES", arguments: "{}" }, {
        signal: new AbortController().signal,
      } as never),
    );

    // Small local window: the floor, plus the fence that always wraps app data.
    expect(result.length).toBeLessThan(5_000);
    expect(result).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    // Told, not silently trimmed — otherwise the Blob reports the first few
    // repos as the complete answer.
    expect(result).toContain("cut off");
    expect(result).toContain("fewer items");

    // An enclave model has room for the whole thing, so it gets it: the same
    // window-sized budget web_fetch already uses for a page.
    rememberTinfoilWindows([{ id: "wide", contextWindow: 1_000_000 }]);
    const wide = makeComposioTools("tinfoil:wide").find((tool) => tool.name === "app_run_tool");
    const full = String(
      await wide?.execute({ tool: "GITHUB_SEARCH_REPOSITORIES", arguments: "{}" }, {
        signal: new AbortController().signal,
      } as never),
    );
    expect(full).not.toContain("cut off");
    expect(full).toContain(reply.text);
  });
});
