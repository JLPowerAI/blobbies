import { afterEach, describe, expect, it, vi } from "vitest";
import { type EventListener, parseListener } from "@/lib/trigger";
import { MAX_EVENTS_PER_POLL, pollListener } from "@/lib/trigger-poll";

const execute = vi.hoisted(() => vi.fn<(tool: string, args: string) => Promise<string>>());
vi.mock("@/lib/composio", () => ({ composioExecute: execute }));

afterEach(() => {
  execute.mockReset();
});

const repo = parseListener({
  type: "github",
  repo: "acme/app",
  events: ["pr-opened", "pr-merged", "ci-failed"],
  ciBranch: "main",
}) as EventListener;

const channel = parseListener({
  type: "slack",
  channel: "#ops",
  match: { kind: "message" },
}) as EventListener;

/** GitHub's feed shape, newest first, as the API returns it. */
function ghFeed(...events: Record<string, unknown>[]) {
  return JSON.stringify({ data: { events: [...events].reverse() } });
}

const prEvent = (id: string, action: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "PullRequestEvent",
  actor: { login: "sam" },
  payload: { action, pull_request: { title: "Fix it", user: { login: "ken" }, ...extra } },
});

describe("pollListener — arming", () => {
  it("arms on the first poll without firing about history", async () => {
    // A routine switched on beside a busy repo must not immediately fire about
    // everything that already happened.
    execute.mockResolvedValue(ghFeed(prEvent("1", "opened"), prEvent("2", "opened")));
    const first = await pollListener(repo, {});
    expect(first.events).toEqual([]);
    expect(first.cursor.since).toBe("2");

    // Now only what is genuinely new comes back.
    execute.mockResolvedValue(
      ghFeed(prEvent("1", "opened"), prEvent("2", "opened"), prEvent("3", "opened")),
    );
    const second = await pollListener(repo, first.cursor);
    expect(second.events.map((event) => event.id)).toEqual(["3"]);
    expect(second.cursor.since).toBe("3");
  });

  it("reports nothing twice", async () => {
    execute.mockResolvedValue(ghFeed(prEvent("1", "opened")));
    const armed = await pollListener(repo, {});
    const again = await pollListener(repo, armed.cursor);
    expect(again.events).toEqual([]);
  });
});

describe("pollListener — failure", () => {
  it("waits quietly when the call fails, keeping the cursor", async () => {
    // Composio answers a human sentence when an account is not connected;
    // that is not an error to throw on, it is "nothing this tick".
    execute.mockResolvedValue("Slack is not connected for this account.");
    const result = await pollListener(channel, { since: "111.0" });
    expect(result.events).toEqual([]);
    expect(result.cursor).toEqual({ since: "111.0" });
  });

  it("does not poll a platform it has no poller for", async () => {
    const sentry = parseListener({
      type: "sentry",
      event: { case: "issueAny" },
      projectIds: [],
    }) as EventListener;
    const result = await pollListener(sentry, {});
    expect(result.events).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("pollListener — GitHub translation", () => {
  it("tells a merge apart from a plain close", async () => {
    // GitHub reports both as `closed`; only one means the work landed, and a
    // routine watching for merges must not fire when a PR is abandoned.
    execute.mockResolvedValue(ghFeed(prEvent("1", "opened")));
    const armed = await pollListener(repo, {});

    execute.mockResolvedValue(
      ghFeed(
        prEvent("1", "opened"),
        prEvent("2", "closed", { merged: false }),
        prEvent("3", "closed", { merged: true }),
      ),
    );
    const result = await pollListener(repo, armed.cursor);
    expect(result.events.map((event) => event.kind)).toEqual(["pr-merged"]);
    expect(result.events[0]?.prOwner).toBe("ken");
  });

  it("carries the branch on a CI event, so a branch filter can be applied", async () => {
    execute.mockResolvedValue(ghFeed(prEvent("1", "opened")));
    const armed = await pollListener(repo, {});
    execute.mockResolvedValue(
      ghFeed(prEvent("1", "opened"), {
        id: "2",
        type: "WorkflowRunEvent",
        actor: { login: "ci" },
        payload: { workflow_run: { conclusion: "failure", head_branch: "main" } },
      }),
    );
    const result = await pollListener(repo, armed.cursor);
    expect(result.events[0]).toMatchObject({ kind: "ci-failed", branch: "main" });
  });
});

describe("pollListener — Slack translation", () => {
  it("spots a mention, and keeps the message text intact", async () => {
    execute.mockResolvedValue(JSON.stringify({ data: { messages: [{ ts: "1.0", text: "hi" }] } }));
    const armed = await pollListener(channel, {});
    execute.mockResolvedValue(
      JSON.stringify({
        data: {
          messages: [
            { ts: "2.0", text: "hey <@U123> deploy?", user: "sam" },
            { ts: "1.0", text: "hi" },
          ],
        },
      }),
    );
    const result = await pollListener(channel, armed.cursor);
    expect(result.events[0]).toMatchObject({
      source: "slack",
      channel: "#ops",
      sender: "sam",
      isMention: true,
    });
    expect(result.events[0]?.text).toBe("hey <@U123> deploy?");
  });
});

describe("pollListener — pacing", () => {
  it("caps one poll's events and takes the newest", async () => {
    execute.mockResolvedValue(ghFeed(prEvent("0", "opened")));
    const armed = await pollListener(repo, {});
    const many = Array.from({ length: MAX_EVENTS_PER_POLL + 4 }, (_, index) =>
      prEvent(String(index + 1), "opened"),
    );
    execute.mockResolvedValue(ghFeed(prEvent("0", "opened"), ...many));
    const result = await pollListener(repo, armed.cursor);
    expect(result.events).toHaveLength(MAX_EVENTS_PER_POLL);
    // The newest survive: a stale alert is worth less than a current one, and
    // the cursor still moves past everything so it cannot backlog forever.
    expect(result.events.at(-1)?.id).toBe(String(many.length));
    expect(result.cursor.since).toBe(String(many.length));
  });
});
