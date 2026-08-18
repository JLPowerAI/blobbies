import { describe, expect, it } from "vitest";
import { waitForComposioLink } from "@/lib/composio";

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
