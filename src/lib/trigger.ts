/**
 * Routine event listeners: what fires a routine other than the clock.
 *
 * The taxonomy here mirrors the one the reference implementation uses, because
 * that is the shape real integrations take: a listener names a *scope* (a
 * channel, a repo, a project) and a *match* within it, and a routine may hold
 * several at once. A schedule is the seventh member of that family; this repo
 * keeps it in `Routine.schedule` (see `schedule.ts`), so this module covers the
 * event members only and `TRIGGER_MAX_LISTENERS` counts those.
 *
 * Three layers live here, all pure and all testable without a network:
 *
 * - **Parse/serialize.** Everything arriving from the store is re-validated
 *   with hard caps; a listener that does not survive is dropped rather than
 *   repaired, so a hand-edited file cannot widen a scope.
 * - **Match.** Given a normalised event, decide whether a listener wanted it.
 *   This is where scope, allowlists and CI branches are enforced.
 * - **Describe.** Say in words what will fire it, so the routine list can be
 *   read without opening an editor.
 *
 * Delivery is not here: `trigger-poll.ts` turns Composio calls into the flat
 * event records the matchers take.
 */

import { wrapUntrusted } from "@/lib/untrusted";

/** A scope that matches anything of its kind, e.g. any Slack channel. */
export const ANY_SCOPE = "*";

/**
 * GitHub events a listener can subscribe to. A fixed set, because each one has
 * to be recognised by the poller and phrased for the user.
 */
export const GITHUB_EVENT_KINDS = [
  "pr-opened",
  "pr-pushed",
  "pr-merged",
  "review-requested",
  "review-approved",
  "review-changes-requested",
  "review-commented",
  "pr-comment",
  "inline-review-comment",
  "review-thread-resolved",
  "review-thread-unresolved",
  "issue-assigned",
  "ci-passed",
  "ci-failed",
] as const;

export const LINEAR_EVENT_CASES = ["issueCreated", "statusChanged", "endOfCycle"] as const;
export const SENTRY_EVENT_CASES = [
  "issueCreated",
  "issueResolved",
  "issueAssigned",
  "issueArchived",
  "issueUnresolved",
  "issueAny",
] as const;
export const PAGERDUTY_EVENT_CASES = [
  "incidentTriggered",
  "incidentAcknowledged",
  "incidentResolved",
  "incidentEscalated",
  "incidentAny",
] as const;

/**
 * The platforms this app can actually deliver events for today.
 *
 * The other listener kinds parse, match and describe — so a routine synced
 * from elsewhere keeps its meaning rather than being silently dropped — but
 * only these two have a poller, and only these two are offered in the UI.
 */
export const LISTENER_PLATFORMS = ["slack", "github"] as const;

/** Ceiling on listeners per routine. Beyond this a routine is unreadable. */
export const TRIGGER_MAX_LISTENERS = 8;
export const MAX_REACTION_EMOJI = 8;
export const MAX_CHANNEL_LENGTH = 80;
export const MAX_KEYWORD_LENGTH = 120;
export const MAX_REPO_LENGTH = 140;
export const MAX_BRANCH_LENGTH = 200;
export const MAX_ALLOWLIST_LOGINS = 50;
export const MAX_LOGIN_LENGTH = 80;
export const MAX_ID_LENGTH = 200;
export const MAX_FILTER_IDS = 50;

/** Shortcode form, colons already stripped: `+1`, `white_check_mark`. */
const EMOJI_SHORTCODE = /^[a-z0-9_+-]+$/;

export type SlackMatch =
  | { kind: "mention" }
  | { kind: "message" }
  | { kind: "keyword"; keyword: string }
  | { kind: "reaction"; emoji?: string[]; bySelf?: boolean };

export interface SlackListener {
  type: "slack";
  channel: string;
  match: SlackMatch;
}

export interface GithubListener {
  type: "github";
  repo: string;
  events: string[];
  ciBranch?: string;
  userAllowlist?: string[];
}

export interface TeamsListener {
  type: "microsoftTeams";
  tenantId: string;
  teamIds: string[];
  channelIds: string[];
  messageContains: string;
  messageContainsIsRegex: boolean;
}

export interface LinearListener {
  type: "linear";
  event:
    | { case: "issueCreated" }
    | { case: "statusChanged"; statusIds: string[] }
    | { case: "endOfCycle"; cycleIds: string[] };
  projectIds: string[];
  teamIds: string[];
}

export interface SentryListener {
  type: "sentry";
  event: { case: string };
  projectIds: string[];
}

export interface PagerDutyListener {
  type: "pagerduty";
  event: { case: string };
  serviceIds: string[];
}

export type EventListener =
  | SlackListener
  | GithubListener
  | TeamsListener
  | LinearListener
  | SentryListener
  | PagerDutyListener;

/** A platform with a poller, i.e. one this app can actually deliver. */
export type ListenerPlatform = (typeof LISTENER_PLATFORMS)[number];

/**
 * One event, flattened. The poller produces these and the matchers read them;
 * keeping it a plain record means a new platform needs no change here.
 */
export type TriggerEvent = Record<string, unknown>;

export function isListenerPlatform(value: string): value is ListenerPlatform {
  return (LISTENER_PLATFORMS as readonly string[]).includes(value);
}

/** CI events carry a branch, and are the only ones a branch filter applies to. */
export function isCiEvent(kind: string): boolean {
  return kind === "ci-passed" || kind === "ci-failed";
}

/** `:+1::skin-tone-2:` and `+1` are the same reaction to a person. */
export function normalizeEmoji(raw: string): string {
  const bare = raw.trim().replace(/^:+|:+$/g, "");
  return (bare.split("::")[0] ?? bare).trim().toLowerCase();
}

/** `owner/name`, with no spaces and exactly one slash. */
export function isValidRepo(repo: string): boolean {
  return /^[^\s/]+\/[^\s/]+$/.test(repo);
}

/**
 * Git's own ref rules, the subset that matters: no whitespace or the special
 * characters Git reserves, no leading dash or slash, no trailing slash, no
 * `..` and no `@{`. A branch that fails this cannot name a real ref, so
 * storing it would create a filter that silently never matches.
 */
export function isValidBranch(branch: string): boolean {
  return branch.length > 0 && !/[\s~^:?*[\\]|^[-/]|\/$|\.\.|@\{/.test(branch);
}

// ---------------------------------------------------------------- parsing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One line of text, capped. Newlines collapse to spaces: a listener's scope is
 * rendered into prompts and into the routine list, and a value smuggling a
 * line break could forge a line in either.
 */
function token(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, max);
  return value === "" ? null : value;
}

/** A capped list of distinct ids, dropping anything unusable. */
function idList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of raw) {
    const value = token(entry, MAX_ID_LENGTH);
    if (value !== null && !result.includes(value)) {
      result.push(value);
    }
    if (result.length >= MAX_FILTER_IDS) {
      break;
    }
  }
  return result;
}

function parseEmojiList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const value = normalizeEmoji(entry);
    if (EMOJI_SHORTCODE.test(value) && !result.includes(value)) {
      result.push(value);
    }
    if (result.length >= MAX_REACTION_EMOJI) {
      break;
    }
  }
  return result;
}

function parseSlack(value: Record<string, unknown>): SlackListener | null {
  const channel = token(value.channel, MAX_CHANNEL_LENGTH);
  const raw = isRecord(value.match) ? value.match : null;
  if (channel === null || raw === null) {
    return null;
  }
  if (raw.kind === "mention" || raw.kind === "message") {
    return { type: "slack", channel, match: { kind: raw.kind } };
  }
  if (raw.kind === "keyword") {
    const keyword = token(raw.keyword, MAX_KEYWORD_LENGTH);
    return keyword === null
      ? null
      : { type: "slack", channel, match: { kind: "keyword", keyword } };
  }
  if (raw.kind === "reaction") {
    const emoji = parseEmojiList(raw.emoji);
    return {
      type: "slack",
      channel,
      match: {
        kind: "reaction",
        ...(emoji.length > 0 ? { emoji } : {}),
        ...(raw.bySelf === true ? { bySelf: true } : {}),
      },
    };
  }
  return null;
}

function parseAllowlist(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const result: string[] = [];
  for (const entry of raw) {
    const login = token(entry, MAX_LOGIN_LENGTH)?.replace(/^@+/, "");
    // GitHub logins are case-insensitive, so a list holding both spellings
    // would look like two people and read as noise in the description.
    if (login && !result.some((seen) => seen.toLowerCase() === login.toLowerCase())) {
      result.push(login);
    }
    if (result.length >= MAX_ALLOWLIST_LOGINS) {
      break;
    }
  }
  return result.length > 0 ? result : undefined;
}

function parseGithub(value: Record<string, unknown>): GithubListener | null {
  const repo = token(value.repo, MAX_REPO_LENGTH);
  if (repo === null || !isValidRepo(repo)) {
    return null;
  }
  const known: string[] = [];
  for (const entry of Array.isArray(value.events) ? value.events : []) {
    if (
      typeof entry === "string" &&
      (GITHUB_EVENT_KINDS as readonly string[]).includes(entry) &&
      !known.includes(entry)
    ) {
      known.push(entry);
    }
  }
  const branch = token(value.ciBranch, MAX_BRANCH_LENGTH);
  const ciBranch = branch !== null && isValidBranch(branch) ? branch : undefined;
  // A CI subscription without a usable branch is dropped rather than widened
  // to every branch: "tell me when CI fails" across a busy repo is a firehose
  // nobody asked for.
  const events = ciBranch === undefined ? known.filter((kind) => !isCiEvent(kind)) : known;
  if (events.length === 0) {
    return null;
  }
  const userAllowlist = parseAllowlist(value.userAllowlist);
  return {
    type: "github",
    repo,
    events,
    ...(userAllowlist ? { userAllowlist } : {}),
    ...(ciBranch !== undefined && events.some(isCiEvent) ? { ciBranch } : {}),
  };
}

function parseCases(value: Record<string, unknown>): EventListener | null {
  if (!isRecord(value.event) || typeof value.event.case !== "string") {
    return null;
  }
  const kind = value.event.case;
  if (value.type === "linear") {
    const event =
      kind === "issueCreated"
        ? ({ case: "issueCreated" } as const)
        : kind === "statusChanged"
          ? ({ case: "statusChanged", statusIds: idList(value.event.statusIds) } as const)
          : kind === "endOfCycle"
            ? ({ case: "endOfCycle", cycleIds: idList(value.event.cycleIds) } as const)
            : null;
    return event === null
      ? null
      : {
          type: "linear",
          event,
          projectIds: idList(value.projectIds),
          teamIds: idList(value.teamIds),
        };
  }
  if (value.type === "sentry") {
    return (SENTRY_EVENT_CASES as readonly string[]).includes(kind)
      ? { type: "sentry", event: { case: kind }, projectIds: idList(value.projectIds) }
      : null;
  }
  return (PAGERDUTY_EVENT_CASES as readonly string[]).includes(kind)
    ? { type: "pagerduty", event: { case: kind }, serviceIds: idList(value.serviceIds) }
    : null;
}

/** Validate one stored listener; null when it is not one. */
export function parseListener(value: unknown): EventListener | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.type === "slack") {
    return parseSlack(value);
  }
  if (value.type === "github") {
    return parseGithub(value);
  }
  if (value.type === "microsoftTeams") {
    const tenantId = token(value.tenantId, MAX_ID_LENGTH);
    const teamIds = idList(value.teamIds);
    if (tenantId === null || teamIds.length === 0) {
      return null;
    }
    return {
      type: "microsoftTeams",
      tenantId,
      teamIds,
      channelIds: idList(value.channelIds),
      messageContains: token(value.messageContains, MAX_KEYWORD_LENGTH) ?? "",
      messageContainsIsRegex: value.messageContainsIsRegex === true,
    };
  }
  if (value.type === "linear" || value.type === "sentry" || value.type === "pagerduty") {
    return parseCases(value);
  }
  return null;
}

/** Validate a stored listener array, capped. Invalid entries are dropped. */
export function parseListeners(value: unknown): EventListener[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const listeners: EventListener[] = [];
  for (const entry of value) {
    const listener = parseListener(entry);
    if (listener !== null) {
      listeners.push(listener);
    }
    if (listeners.length >= TRIGGER_MAX_LISTENERS) {
      break;
    }
  }
  return listeners;
}

/**
 * A stable identity for one listener, for de-duping and for keying a poll
 * cursor. Field order is fixed by construction, so equal listeners key alike.
 */
export function listenerIdentity(listener: EventListener): string {
  if (listener.type === "slack") {
    return `slack:${listener.channel}:${JSON.stringify(listener.match)}`;
  }
  if (listener.type === "github") {
    return `github:${listener.repo}:${[...listener.events].sort().join(",")}:${listener.ciBranch ?? ""}`;
  }
  return `${listener.type}:${JSON.stringify(listener)}`;
}

// --------------------------------------------------------------- matching

function scopeParts(value: string): { sigil: string; name: string } {
  const sigil = value.startsWith("#") || value.startsWith("@") ? (value[0] ?? "") : "";
  return { sigil, name: value.slice(sigil.length).toLowerCase() };
}

/**
 * Does a stored channel scope name the channel an event came from?
 *
 * `#ops` and `ops` are the same channel typed two ways, so the sigil only
 * decides when both sides carry one — otherwise a user typing the `#` would
 * silently never match.
 */
export function slackScopeMatches(scope: string, actual: string): boolean {
  if (scope === ANY_SCOPE) {
    return true;
  }
  const wanted = scopeParts(scope);
  const got = scopeParts(actual);
  if (wanted.sigil !== "" && got.sigil !== "" && wanted.sigil !== got.sigil) {
    return false;
  }
  return wanted.name === got.name;
}

export function slackListenerMatches(listener: SlackListener, event: TriggerEvent): boolean {
  if (typeof event.channel !== "string" || !slackScopeMatches(listener.channel, event.channel)) {
    return false;
  }
  const isReaction = event.reactionEmoji != null;
  if (listener.match.kind === "reaction") {
    if (!isReaction || (listener.match.bySelf === true && event.isSelf !== true)) {
      return false;
    }
    const wanted = listener.match.emoji ?? [];
    // No emoji named means any reaction counts.
    return (
      wanted.length === 0 ||
      (typeof event.reactionEmoji === "string" &&
        wanted.includes(normalizeEmoji(event.reactionEmoji)))
    );
  }
  // A reaction is not a message: a keyword listener must not fire because
  // someone reacted to a post containing the word.
  if (isReaction) {
    return false;
  }
  if (listener.match.kind === "mention") {
    return event.isMention === true;
  }
  if (listener.match.kind === "message") {
    return true;
  }
  return (
    typeof event.text === "string" &&
    event.text.toLowerCase().includes(listener.match.keyword.toLowerCase())
  );
}

/** Is `subject` on the allowlist? An absent subject falls back to `ifMissing`. */
function allows(logins: readonly string[], subject: unknown, ifMissing: boolean): boolean {
  return typeof subject !== "string"
    ? ifMissing
    : logins.some((login) => login.toLowerCase() === subject.toLowerCase());
}

export function githubListenerMatches(
  listener: GithubListener,
  event: TriggerEvent,
  options: { admitMissingSubject?: boolean } = {},
): boolean {
  if (
    typeof event.repo !== "string" ||
    listener.repo.toLowerCase() !== event.repo.toLowerCase() ||
    typeof event.kind !== "string" ||
    !listener.events.includes(event.kind)
  ) {
    return false;
  }
  const ifMissing = options.admitMissingSubject ?? false;
  if (isCiEvent(event.kind)) {
    if (listener.ciBranch === undefined) {
      return false;
    }
    if (typeof event.branch !== "string") {
      return ifMissing;
    }
    if (event.branch !== listener.ciBranch) {
      return false;
    }
  }
  const logins = listener.userAllowlist ?? [];
  // CI has no author to filter by; an allowlist would silence it entirely.
  if (logins.length === 0 || isCiEvent(event.kind)) {
    return true;
  }
  // Events *about* a PR are filtered by whose PR it is...
  if (
    ["pr-opened", "pr-pushed", "pr-merged", "pr-comment", "inline-review-comment"].includes(
      event.kind,
    )
  ) {
    return allows(logins, event.prOwner, ifMissing);
  }
  // ...review traffic needs both ends on the list, so an allowlisted reviewer
  // commenting on a stranger's PR does not wake the routine.
  if (
    [
      "review-approved",
      "review-changes-requested",
      "review-commented",
      "review-thread-resolved",
      "review-thread-unresolved",
      "review-requested",
    ].includes(event.kind)
  ) {
    return allows(logins, event.actor, ifMissing) && allows(logins, event.prOwner, ifMissing);
  }
  return allows(logins, event.actor, ifMissing);
}

/** An empty filter means "any"; an unknown value defers to `ifUnknown`. */
function filterAllows(values: readonly string[], actual: unknown, ifUnknown: boolean): boolean {
  if (values.length === 0) {
    return true;
  }
  return typeof actual !== "string" ? ifUnknown : values.includes(actual);
}

export function listenerMatchesEvent(
  listener: EventListener,
  event: TriggerEvent,
  options: { platformMatched?: boolean; admitMissingSubject?: boolean } = {},
): boolean {
  const platform = options.platformMatched ?? false;
  if (listener.type === "slack") {
    return event.source === "slack" && slackListenerMatches(listener, event);
  }
  if (listener.type === "github") {
    return event.source === "github" && githubListenerMatches(listener, event, options);
  }
  if (event.source !== listener.type) {
    return false;
  }
  if (listener.type === "microsoftTeams") {
    if (
      listener.tenantId !== event.tenantId ||
      !listener.teamIds.includes(event.teamId as string)
    ) {
      return false;
    }
    if (
      listener.channelIds.length > 0 &&
      !listener.channelIds.includes(event.channelId as string)
    ) {
      return false;
    }
    if (listener.messageContains === "") {
      return true;
    }
    // A regex written by a user is not run here: an untrusted pattern against
    // untrusted text is a catastrophic-backtracking hazard. The platform side
    // is expected to have applied it.
    return listener.messageContainsIsRegex
      ? platform
      : typeof event.text === "string" &&
          event.text.toLowerCase().includes(listener.messageContains.toLowerCase());
  }
  if (listener.type === "linear") {
    if (
      listener.event.case !== event.event ||
      !filterAllows(listener.projectIds, event.projectId, platform) ||
      !filterAllows(listener.teamIds, event.teamId, platform)
    ) {
      return false;
    }
    if (listener.event.case === "statusChanged") {
      return filterAllows(listener.event.statusIds, event.statusId, platform);
    }
    if (listener.event.case === "endOfCycle") {
      return filterAllows(listener.event.cycleIds, event.cycleId, platform);
    }
    return true;
  }
  if (listener.type === "sentry") {
    return (
      filterAllows(listener.projectIds, event.projectId, platform) &&
      (listener.event.case === "issueAny" || listener.event.case === event.event)
    );
  }
  return (
    filterAllows(listener.serviceIds, event.serviceId, platform) &&
    (listener.event.case === "incidentAny" || listener.event.case === event.event)
  );
}

/** Does any listener on this routine want this event? */
export function anyListenerMatches(
  listeners: readonly EventListener[],
  event: TriggerEvent,
  options?: { platformMatched?: boolean; admitMissingSubject?: boolean },
): boolean {
  return listeners.some((listener) => listenerMatchesEvent(listener, event, options));
}

// -------------------------------------------------------------- describing

function joinOr(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? "";
  }
  if (parts.length === 2) {
    return `${parts[0]} or ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")}, or ${parts.at(-1)}`;
}

function slackScopeWords(channel: string): string {
  return channel === ANY_SCOPE ? "anywhere on Slack" : `in ${channel}`;
}

export function describeSlackListener(listener: SlackListener): string {
  const scope = slackScopeWords(listener.channel);
  if (listener.match.kind === "mention") {
    return `When @mentioned ${scope}`;
  }
  if (listener.match.kind === "keyword") {
    return `When "${listener.match.keyword}" is mentioned ${scope}`;
  }
  if (listener.match.kind === "message") {
    return `On any message ${scope}`;
  }
  const emoji = listener.match.emoji ?? [];
  const names = joinOr(emoji.map((name) => `:${name}:`));
  if (listener.match.bySelf === true) {
    return `When you react${emoji.length > 0 ? ` ${names}` : ""} ${scope}`;
  }
  return `On ${emoji.length > 0 ? names : "a reaction"} ${scope}`;
}

const GITHUB_PHRASES: Record<string, string> = {
  "pr-opened": "a PR opens",
  "pr-pushed": "a PR is updated",
  "pr-merged": "a PR merges",
  "review-requested": "a review is requested",
  "review-approved": "a review approves a PR",
  "review-changes-requested": "a review requests changes",
  "review-commented": "a review comments on a PR",
  "pr-comment": "a PR comment lands",
  "inline-review-comment": "an inline review comment lands",
  "review-thread-resolved": "a review thread is resolved",
  "review-thread-unresolved": "a review thread is reopened",
  "issue-assigned": "an issue is assigned",
  "ci-passed": "CI passes",
  "ci-failed": "CI fails",
};

export function describeGithubListener(listener: GithubListener): string {
  const phrases = listener.events.map((kind) => {
    const phrase = GITHUB_PHRASES[kind] ?? kind;
    return isCiEvent(kind) && listener.ciBranch !== undefined
      ? `${phrase} on ${listener.ciBranch}`
      : phrase;
  });
  const base = `When ${joinOr(phrases)} in ${listener.repo}`;
  const logins = listener.userAllowlist ?? [];
  if (logins.length === 0) {
    return base;
  }
  return `${base} (by ${joinOr(logins.map((login) => (login.startsWith("@") ? login : `@${login}`)))})`;
}

const CASE_PHRASES: Record<string, Record<string, string>> = {
  linear: {
    issueCreated: "a Linear issue is created",
    statusChanged: "a Linear issue changes status",
    endOfCycle: "a Linear cycle ends",
  },
  sentry: {
    issueCreated: "a Sentry issue is created",
    issueResolved: "a Sentry issue is resolved",
    issueAssigned: "a Sentry issue is assigned",
    issueArchived: "a Sentry issue is archived",
    issueUnresolved: "a Sentry issue becomes unresolved",
    issueAny: "a Sentry issue changes",
  },
  pagerduty: {
    incidentTriggered: "a PagerDuty incident is triggered",
    incidentAcknowledged: "a PagerDuty incident is acknowledged",
    incidentResolved: "a PagerDuty incident is resolved",
    incidentEscalated: "a PagerDuty incident is escalated",
    incidentAny: "a PagerDuty incident changes",
  },
};

/** One line saying what fires this listener, for the routine list. */
export function describeListener(listener: EventListener): string {
  if (listener.type === "slack") {
    return describeSlackListener(listener);
  }
  if (listener.type === "github") {
    return describeGithubListener(listener);
  }
  if (listener.type === "microsoftTeams") {
    return listener.messageContains === ""
      ? "On a Microsoft Teams message"
      : `When a Teams message matches "${listener.messageContains}"`;
  }
  return `When ${CASE_PHRASES[listener.type]?.[listener.event.case] ?? listener.event.case}`;
}

/**
 * The event, fenced, for the turn the listener fires.
 *
 * Everything in here was written by whoever sent the message or opened the PR,
 * so it is data and never instruction. The reference escapes it into an XML
 * tag; this repo already has a stronger fence with an unforgeable id
 * (`untrusted.ts`), so it uses that instead.
 */
export function buildEventContext(event: TriggerEvent): string {
  return wrapUntrusted(JSON.stringify(event, null, 2), String(event.source ?? "trigger"));
}

/** One line naming the event that actually arrived, for the transcript. */
export function describeEvent(event: TriggerEvent): string {
  const line = (value: unknown) =>
    typeof value === "string"
      ? value
          .replace(/[\r\n]+/g, " ")
          .trim()
          .slice(0, 120)
      : "";
  if (event.source === "slack") {
    return event.reactionEmoji != null
      ? `${event.sender} reacted ${event.reactionEmoji} in ${event.channel}`
      : `${event.sender} in ${event.channel}: "${line(event.text)}"`;
  }
  if (event.source === "github") {
    const label = GITHUB_PHRASES[event.kind as string] ?? event.kind;
    return `${label} in ${event.repo}: "${line(event.title)}"`;
  }
  return `${event.source}: "${line(event.title)}"`;
}
