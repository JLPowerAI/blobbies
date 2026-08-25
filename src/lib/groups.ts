import type { Agent } from "@/data/agents";

/**
 * A group chat: several Blobs and the user in one transcript.
 *
 * Membership is a Blob's `section` — the sidebar group it was dragged into —
 * so the *name* is the key that ties Blobs to a group, and renaming one
 * rewrites its members. The `id` exists only to key the transcript slice:
 * a group name is user text and can never be a path component.
 */
export interface Group {
  id: string;
  name: string;
  /**
   * Replies landed here while the group was not on screen.
   *
   * Set by a Blob's reply, never by the user's own message. A group exchange
   * runs several turns deep and the user routinely switches away mid-way —
   * which is exactly the case a per-Blob unread flag cannot cover, since the
   * words land in the group's transcript, not in any member's.
   */
  unread?: boolean;
}

/**
 * Members that answer one message. Grok caps a group at six Bots; here it is
 * also a cost cap — with no mention, every member replies in series against
 * the one local model, so seven members is seven turns of waiting.
 */
export const MAX_GROUP_MEMBERS = 6;

/** Conversation-id namespace, so a group transcript cannot collide with a Blob's. */
const GROUP_PREFIX = "group:";

/** Conversation id for a group, as `sentByAgent` and the store key it. */
export function groupConversationId(groupId: string): string {
  return `${GROUP_PREFIX}${groupId}`;
}

/** The group id inside a conversation id, or null for a Blob conversation. */
export function groupIdFromConversation(conversationId: string): string | null {
  return conversationId.startsWith(GROUP_PREFIX) ? conversationId.slice(GROUP_PREFIX.length) : null;
}

/** Everyone-mention, matched case-insensitively like a member name. */
const EVERYONE = "everyone";

/** End of the previous sentence, i.e. what a directed mention follows. */
const SENTENCE_END = /[.!?\n]\s*$/;

/** True when `char` would make the mention part of a longer word. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\w@]/.test(char);
}

/**
 * Find `@Name` mentions, in the order they appear.
 *
 * Names hold spaces ("Research Blob"), so this matches each member's name
 * rather than tokenising on whitespace, and requires a non-word character on
 * both sides — "@Ann" must not resolve to a member called "An", and an email
 * address in the message body is not a mention.
 */
export function parseMentions(
  text: string,
  members: readonly Agent[],
): { ids: string[]; everyone: boolean; directed: string[] } {
  const haystack = text.toLowerCase();
  const hits: { id: string; at: number; opens: boolean }[] = [];
  let everyone = false;
  const find = (name: string): number => {
    const needle = `@${name.toLowerCase()}`;
    for (let from = 0; from <= haystack.length - needle.length; ) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) {
        return -1;
      }
      if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + needle.length])) {
        return at;
      }
      from = at + 1;
    }
    return -1;
  };
  for (const member of members) {
    const at = find(member.name);
    if (at !== -1) {
      hits.push({ id: member.id, at, opens: at === 0 || SENTENCE_END.test(text.slice(0, at)) });
    }
  }
  if (find(EVERYONE) !== -1) {
    everyone = true;
  }
  hits.sort((left, right) => left.at - right.at);
  return {
    ids: hits.map((hit) => hit.id),
    everyone,
    directed: hits.filter((hit) => hit.opens).map((hit) => hit.id),
  };
}

/**
 * A message addressing the whole room in plain English, with no `@`.
 *
 * “@everyone” is the explicit form and already routes to every member. But
 * people do not type it: “anything cool I should know about everyone?”,
 * “what's each of you working on?” and “any updates from you all?” are the
 * same request, and without this they went to the router as an ordinary
 * question — which picks a few, and then rule 1 of the group prompt (“a
 * colleague already answered it”) silenced all but the first. A question the
 * user asked the room came back as one answer and “Scout, Quill and Nova
 * stayed out”.
 *
 * Second person only, and that is what keeps it safe. The room word has to be
 * addressed TO the members (“each of you”, “you all”) or stand as the bare
 * collective the user is talking to (“everyone”, “the team”) — so “everyone
 * at the office says hi” still routes normally rather than waking six Blobs.
 * “anyone” is deliberately absent: “does anyone know X?” wants one answer,
 * not six. Neither side of the word may be `@`, so a handle (“@everyone”,
 * which `parseMentions` owns) and an address (“everyone@example.com”) both
 * fall through to the code that already knows what they are.
 */
const ROOM_ADDRESS =
  /(?:^|[^\p{L}\p{N}_@])(?:everyone|everybody|each of (?:you|ya)|all of you|you all|y'all|the team)(?![\p{L}\p{N}_@])/iu;

/** True when the message speaks to the whole room without naming anyone. */
export function addressesRoom(text: string): boolean {
  return ROOM_ADDRESS.test(text);
}

/**
 * The word a Blob says when it has nothing worth adding.
 *
 * A picked Blob is *invited* to speak, not obliged to. Colleagues in a room
 * do not each acknowledge every message, and a group where being brought in
 * forces a reply produces exactly the noise the router was built to avoid —
 * three "sounds good!" lines under one answer. The exception is a Blob the
 * user named: see `namedResponders`.
 */
export const PASS_TOKEN = "PASS";

/**
 * True when a reply is the Blob declining to speak.
 *
 * Two accepted shapes, because small models produce both: the bare token, and
 * the token followed by a reason ("PASS \u2014 I don't have that number either").
 * The reason goes with it: the Blob opted out, and "I also don't know" from
 * three colleagues is precisely the noise this exists to remove.
 *
 * The separator is what keeps it safe. Only punctuation may follow the token,
 * so "PASS the file to Quill" stays a real reply \u2014 dropping one of those is
 * far worse than showing a stray "PASS", since the user can see the latter
 * but never sees what was silently deleted.
 */
/**
 * Whether this Blob owes an answer, so PASS must not silence it.
 *
 * Two ways to be obliged, and the second is the one that bites: a Blob the
 * user addressed by name, and the *only* Blob the router picked. PASS means
 * “a colleague has this” — with nobody else picked there is no colleague, so
 * a pass leaves a direct question answered by silence. Measured on qwen3.5:2b,
 * which did exactly that in 3 of 5 runs on “what did hosting cost last month?”
 *
 * `pickedCount` is read before the turn loop starts, never during it: a
 * hand-off appends to the queue, and a Blob that was alone when it was asked
 * does not stop being alone because it later pulled someone in.
 */
export function owesAnswer(options: { addressed: boolean; pickedCount: number }): boolean {
  return options.addressed || options.pickedCount === 1;
}

export function isPass(reply: string): boolean {
  return new RegExp(
    `^[\\s*_"\u2018\u201c\`]*${PASS_TOKEN}\\b[\\s*_"\u2019\u201d\`]*([-\u2013\u2014:;.,!\u2026]|$)`,
    "i",
  ).test(reply.trim());
}

/**
 * Drop a Blob's own name where it has signed its reply.
 *
 * Measured, not guessed: qwen3.5:2b opens with its own “@Ken …” on 3 runs out
 * of 3, and no wording of the prompt rule changed that — abstract (“never
 * start it with your own name”) and explicit (naming the handle) both failed,
 * on the full section and the trimmed one. qwen3.5:9b obeys either. Since the
 * rule cannot be taught to the small model, it is enforced here instead.
 *
 * It matters beyond tidiness: every message already carries its author, so a
 * signature is noise — and `handoffTarget` reads a sentence-opening mention as
 * “hand the next step to that Blob”, so a Blob signing its own name would wake
 * *itself*.
 *
 * Deliberately narrow. Only the Blob's own name, only at the very start, only
 * when punctuation or whitespace follows — so “@Kendra …” survives for a Blob
 * called Ken, and a genuine hand-off to a colleague is never touched. Anything
 * it fails to catch is cosmetic; anything it wrongly ate would be a reply the
 * user never sees.
 */
export function stripSelfMention(reply: string, selfName: string): string {
  const name = selfName.trim();
  if (name === "") {
    return reply;
  }
  // The name reaches here from user-editable Blob config, so it is escaped
  // rather than interpolated into a pattern raw.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Two shapes, and the separator is what makes each safe:
  //   “@Ken …”  an @handle is already unambiguous, so a space is enough.
  //   “Ken: …”  a bare name needs a colon or dash, or “Ken and Quill agree”
  //             loses its subject and “Ken's report” becomes “'s report”.
  // `\b` is avoided throughout: word boundaries are defined against word
  // characters, so they never match after a name ending in punctuation
  // (“C++”) and the strip would silently stop working for those Blobs.
  const tail = "(?![\\p{L}\\p{N}_])";
  const open = "[\\s*_\"'‘“]*";
  const handle = new RegExp(`^${open}@${escaped}${tail}[\\s]*[:,—–-]?[\\s]+`, "iu");
  const bare = new RegExp(`^${open}${escaped}${tail}[\\s]*[:—–-][\\s]*`, "iu");
  const opened = handle.test(reply) ? reply.replace(handle, "") : reply.replace(bare, "");
  // Also at the end, where a 9b model signs off: “… How can I help today? @Scout”.
  // Only the @handle form and only its own — a trailing “@Quill” is the hand-off
  // this design runs on, and `handoffTarget` reads it. Self is never a hand-off:
  // the Blob has already spoken, so it can only be a signature.
  const signOff = new RegExp(`[\\s—–-]*@${escaped}${tail}[\\s.!?]*$`, "iu");
  const stripped = opened.replace(signOff, "");
  // Never return an empty reply: if the name was the whole message, the
  // original is less confusing than a blank bubble.
  return stripped.trim() === "" ? reply : stripped;
}

/**
 * The one teammate a Blob's reply is handing work to, or null.
 *
 * Stricter than `parseMentions` on purpose, and both restrictions are
 * measured: `pnpm sim:group` caught a Blob answering a question and writing
 * “…I've also noted that @Scout will not be attending, and @Quill has
 * confirmed” — two teammates woken to say nothing, which is the chorus this
 * whole design exists to avoid, arriving through the side door.
 *
 * So: only a mention that OPENS a sentence counts (“@Quill draft it.” is
 * addressing someone; “that @Quill has confirmed” is talking about them), and
 * only the first one — a reply cannot fan out, so the worst case is one extra
 * turn rather than a cascade. A user's mention stays permissive: they mean it.
 */
export function handoffTarget(
  reply: string,
  members: readonly Agent[],
  spoken: ReadonlySet<string>,
): Agent | null {
  for (const id of parseMentions(reply, members).directed) {
    if (!spoken.has(id)) {
      return members.find((member) => member.id === id) ?? null;
    }
  }
  return null;
}

/**
 * Who was *explicitly* addressed by a message, in speaking order — or `null`
 * when nobody was, which is the caller's cue to decide some other way (the
 * app asks a router; see `pickResponders`).
 *
 * A mention wins over everything: it is the only way to address one teammate
 * with certainty. A reply addresses the Blob whose message it answers. An
 * unaddressed message is `null`, deliberately not "everyone": on one local
 * model each responder is a serial turn, and a group where all six answer
 * every "thanks" is a group nobody would keep.
 *
 * `null` rather than an empty array, because the two mean opposite things:
 * empty is a decision that nobody speaks.
 */
export function addressedResponders(
  members: readonly Agent[],
  message: { text: string; replyToAuthorId?: string | undefined },
): Agent[] | null {
  const mentions = parseMentions(message.text, members);
  if (mentions.everyone || addressesRoom(message.text)) {
    return [...members];
  }
  if (mentions.ids.length > 0) {
    return mentions.ids
      .map((id) => members.find((member) => member.id === id))
      .filter((member): member is Agent => member !== undefined);
  }
  const replied = members.find((member) => member.id === message.replyToAuthorId);
  return replied === undefined ? null : [replied];
}

/**
 * Ids of the Blobs the user addressed — `@Name`, `@everyone`, or a reply.
 *
 * The difference between an invitation and an obligation. Addressed Blobs
 * must answer; anyone else (picked by the router, or pulled in by a
 * colleague) may stay out.
 *
 * `@everyone` names every member, because that is what the user asked for.
 * The measured risk is a chorus — three members answering “210 euros” in turn
 * — but the cure for that is the prompt telling each to add what the others
 * did not, not the app quietly deciding the user did not mean it.
 */
export function namedResponders(
  members: readonly Agent[],
  message: { text: string; replyToAuthorId?: string | undefined },
): Set<string> {
  const mentions = parseMentions(message.text, members);
  if (mentions.everyone || addressesRoom(message.text)) {
    return new Set(members.map((member) => member.id));
  }
  const ids = new Set(mentions.ids);
  const replied = members.find((member) => member.id === message.replyToAuthorId);
  if (replied !== undefined) {
    ids.add(replied.id);
  }
  return ids;
}
