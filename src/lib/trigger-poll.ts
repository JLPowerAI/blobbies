/**
 * Delivery for event listeners: turning Composio calls into trigger events.
 *
 * **Why polling.** The reference implementation receives Slack and GitHub
 * events from a cloud relay it operates — a webhook endpoint per workspace,
 * fanned out to the right agent. This app has no server: Blobs run on the
 * user's machine, and the only route to those platforms is the Composio
 * connection the user already made. So the same listeners are satisfied by
 * asking, on the scheduler's tick, rather than by being told.
 *
 * That difference is visible in exactly two places and nowhere else:
 * latency is a tick rather than a second, and `platformMatched` is false —
 * this app sees raw events, so any filter the relay would have applied
 * upstream (a Teams regex, an unknown project id) has to be decided locally
 * or declined. The matchers in `trigger.ts` already take that flag.
 *
 * Everything returned here is untrusted: it is written by whoever sent the
 * message or opened the pull request. It is normalised into flat records,
 * never evaluated, and reaches a model only through `buildEventContext`.
 */

import { composioExecute } from "@/lib/composio";
import {
  type EventListener,
  type GithubListener,
  isCiEvent,
  type SlackListener,
  type TriggerEvent,
} from "@/lib/trigger";

/**
 * Most events to take from one listener on one tick.
 *
 * A busy channel between two ticks could hold hundreds; a routine that fires
 * on each would never catch up. The newest few are kept and the rest are
 * passed over — deliberately dropped, not queued, because a stale alert is
 * worth less than a current one and an unbounded backlog would pin the app.
 */
export const MAX_EVENTS_PER_POLL = 5;

/** Composio tool slugs. Named here so a poll is one lookup, not a search. */
const SLACK_HISTORY = "SLACK_FETCH_CONVERSATION_HISTORY";
const GITHUB_EVENTS = "GITHUB_LIST_REPOSITORY_EVENTS";

/**
 * What a listener has already seen, keyed by `listenerIdentity`.
 *
 * A cursor rather than a full id set: these feeds are ordered and append-only,
 * so remembering the newest handled item bounds the store no matter how busy
 * the channel gets.
 */
export interface PollCursor {
  /** Newest item already handled. Absent means "never polled". */
  since?: string;
}

/** GitHub's own event names, mapped onto the kinds a listener subscribes to. */
function githubKind(raw: Record<string, unknown>): string | null {
  const type = typeof raw.type === "string" ? raw.type : "";
  const payload = (raw.payload ?? {}) as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : "";
  if (type === "PullRequestEvent") {
    if (action === "opened" || action === "reopened") {
      return "pr-opened";
    }
    if (action === "synchronize") {
      return "pr-pushed";
    }
    if (action === "closed") {
      // GitHub reports a merge as a close with a flag; the two are different
      // events to a person, and only one of them means the work landed.
      const pr = (payload.pull_request ?? {}) as Record<string, unknown>;
      return pr.merged === true ? "pr-merged" : null;
    }
    if (action === "review_requested") {
      return "review-requested";
    }
    return null;
  }
  if (type === "PullRequestReviewEvent") {
    const review = (payload.review ?? {}) as Record<string, unknown>;
    const state = typeof review.state === "string" ? review.state.toLowerCase() : "";
    if (state === "approved") {
      return "review-approved";
    }
    if (state === "changes_requested") {
      return "review-changes-requested";
    }
    return "review-commented";
  }
  if (type === "PullRequestReviewCommentEvent") {
    return "inline-review-comment";
  }
  if (type === "IssueCommentEvent") {
    return "pr-comment";
  }
  if (type === "IssuesEvent") {
    return action === "assigned" ? "issue-assigned" : null;
  }
  if (type === "CheckSuiteEvent" || type === "WorkflowRunEvent") {
    const run = (payload.workflow_run ?? payload.check_suite ?? {}) as Record<string, unknown>;
    const conclusion = typeof run.conclusion === "string" ? run.conclusion : "";
    if (conclusion === "success") {
      return "ci-passed";
    }
    if (conclusion === "failure" || conclusion === "timed_out") {
      return "ci-failed";
    }
    return null;
  }
  return null;
}

/** Flatten one GitHub API event into the record the matchers read. */
function githubEvent(listener: GithubListener, raw: Record<string, unknown>): TriggerEvent | null {
  const kind = githubKind(raw);
  if (kind === null) {
    return null;
  }
  const payload = (raw.payload ?? {}) as Record<string, unknown>;
  const pr = (payload.pull_request ?? payload.issue ?? {}) as Record<string, unknown>;
  const actorRecord = (raw.actor ?? {}) as Record<string, unknown>;
  const ownerRecord = (pr.user ?? {}) as Record<string, unknown>;
  const run = (payload.workflow_run ?? payload.check_suite ?? {}) as Record<string, unknown>;
  return {
    source: "github",
    id: typeof raw.id === "string" ? raw.id : "",
    repo: listener.repo,
    kind,
    actor: typeof actorRecord.login === "string" ? actorRecord.login : undefined,
    prOwner: typeof ownerRecord.login === "string" ? ownerRecord.login : undefined,
    title: typeof pr.title === "string" ? pr.title : "",
    url: typeof pr.html_url === "string" ? pr.html_url : "",
    ...(isCiEvent(kind) && typeof run.head_branch === "string" ? { branch: run.head_branch } : {}),
  };
}

/** Flatten one Slack message into the record the matchers read. */
function slackEvent(listener: SlackListener, raw: Record<string, unknown>): TriggerEvent | null {
  const ts = typeof raw.ts === "string" ? raw.ts : "";
  if (ts === "") {
    return null;
  }
  const text = typeof raw.text === "string" ? raw.text : "";
  return {
    source: "slack",
    id: ts,
    channel: listener.channel,
    sender: typeof raw.user === "string" ? raw.user : "someone",
    text,
    // Slack renders a mention as `<@U123>`; without knowing our own id the
    // honest reading is "somebody was mentioned".
    isMention: /<@[A-Z0-9]+>/.test(text),
  };
}

/** Parse a Composio tool result, which arrives as JSON text. */
function decode(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Composio returns a human sentence when a call fails (not connected, rate
    // limited). That is not an error to throw on: the listener simply has
    // nothing this tick.
    return null;
  }
}

/** Dig out the array a Composio response wraps its items in. */
function itemsOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const data = (body.data ?? body) as Record<string, unknown>;
  for (const key of ["messages", "events", "items", "results"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      return value.filter(
        (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
      );
    }
  }
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

/**
 * Ask one listener's platform what has happened since the cursor.
 *
 * Returns the events *and* the cursor to store. A failed call yields no events
 * and an unchanged cursor, so a disconnected account waits rather than firing.
 * The first poll of a listener arms without firing, exactly like a schedule
 * being set: a routine switched on beside a busy channel must not immediately
 * fire about its history.
 */
export async function pollListener(
  listener: EventListener,
  cursor: PollCursor,
): Promise<{ events: TriggerEvent[]; cursor: PollCursor }> {
  if (listener.type !== "slack" && listener.type !== "github") {
    // Parsed and describable, but nothing polls it here — see LISTENER_PLATFORMS.
    return { events: [], cursor };
  }
  const raw =
    listener.type === "slack"
      ? await composioExecute(
          SLACK_HISTORY,
          JSON.stringify({
            channel: listener.channel.replace(/^#/, ""),
            limit: MAX_EVENTS_PER_POLL * 4,
            ...(cursor.since === undefined ? {} : { oldest: cursor.since }),
          }),
        )
      : await composioExecute(
          GITHUB_EVENTS,
          JSON.stringify({
            owner: listener.repo.split("/")[0] ?? "",
            repo: listener.repo.split("/")[1] ?? "",
            per_page: MAX_EVENTS_PER_POLL * 4,
          }),
        );

  const body = decode(raw);
  if (body === null) {
    return { events: [], cursor };
  }

  const flattened = itemsOf(body)
    .map((entry) =>
      listener.type === "slack" ? slackEvent(listener, entry) : githubEvent(listener, entry),
    )
    .filter((event): event is TriggerEvent => event !== null);

  // Feeds arrive newest-first; oldest-first is the order things happened, and
  // the order a person expects to be told about them.
  const ordered = [...flattened].reverse();
  const newest = ordered.at(-1);
  const next: PollCursor = newest === undefined ? cursor : { since: String(newest.id) };

  if (cursor.since === undefined) {
    // Arm quietly.
    return { events: [], cursor: next };
  }
  const seen = ordered.findIndex((event) => String(event.id) === cursor.since);
  const fresh = seen === -1 ? ordered : ordered.slice(seen + 1);
  return { events: fresh.slice(-MAX_EVENTS_PER_POLL), cursor: next };
}
