import type { Message } from "@kenkaiiii/gg-ai";
import { type BlobMemory, MEMORY_LIMIT, MEMORY_TEXT_LIMIT, renderMemories } from "@/lib/blob-tools";
import { OLLAMA_URL } from "@/lib/ollama";
import { OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX } from "@/lib/ollama-native";
import { isTinfoilModel, tinfoilStructuredCall } from "@/lib/tinfoil";

/**
 * Intent routing: decide what a user's message asks of the Blob using
 * grammar-constrained JSON instead of tool calling.
 *
 * Why this exists (all figures measured with `pnpm sim`, qwen3.5:0.8b):
 * a sub-1B model asked to *choose* a tool almost never does — deleting a
 * memory succeeded 20-40% of the time, changing the Blob's job 0-20%, and at
 * temperature 0 the model called `remember` 0 times in 8. The same model
 * filling a JSON schema is reliable, because the grammar leaves it no other
 * legal output: 5/5 on delete and job-change in the same conditions.
 *
 * This runs *alongside* the tools rather than replacing them, so a capable
 * model that calls tools directly still works and the two paths converge on
 * the same effect (memory writes dedupe, config writes are idempotent).
 *
 * Cost: one extra non-streaming call per message, measured at roughly +300ms
 * on this model (plain chat turn 500ms -> 860ms). Paid on every message to
 * make the ones that matter deterministic.
 */

/** What the router decided the user's last message calls for. */
export type Intent = (
  | { action: "none" }
  | { action: "save_fact"; fact: string }
  | { action: "delete_fact"; memoryNumber: number }
  | { action: "change_job" }
) & {};

/**
 * Hard ceiling on the router call. It runs before every reply, so a stalled
 * or cold-loading model must not hold the conversation hostage: on timeout the
 * turn proceeds as `none` and the tools remain available.
 */
const ROUTER_TIMEOUT_MS = 5_000;

/**
 * The router emits a handful of JSON tokens; capping stops a confused model
 * padding the `fact` field until the turn times out.
 */
const ROUTER_MAX_TOKENS = 256;

/**
 * Deterministic classification: same message, same route, every time.
 *
 * Note this is the opposite of what temperature does for tool *choice* — the
 * sim measured a small model calling `remember` 0/8 times at temperature 0.
 * Grammar-constrained output cannot fail to emit, so determinism is free here
 * and slightly more accurate (83% vs 80% over 30 classifications).
 */
const ROUTER_TEMPERATURE = 0;

/**
 * Options for every router/reconcile call. `num_ctx` MUST match the chat
 * turns: Ollama reloads the whole model whenever a request's runner options
 * differ from the loaded runner's (sched.go `needsReload` deep-equals them),
 * so an intent call without it would swap the runner — and dump its KV cache
 * — twice on every single message: once for this call, once for the reply.
 */
const ROUTER_OPTIONS = {
  temperature: ROUTER_TEMPERATURE,
  num_predict: ROUTER_MAX_TOKENS,
  num_ctx: OLLAMA_NUM_CTX,
} as const;

/** Grammar the model must fill; `action` is a closed enum, so it cannot stray. */
const INTENT_SCHEMA = {
  type: "object",
  // Every field the mapping reads is required: an optional field is exactly
  // what a small model omits. Measured on qwen3.5:2b at temperature 0 — with
  // memory_number optional it emitted `delete_fact` WITHOUT the number on
  // every run (the mapping then had to discard the delete), with it required
  // the same model filled it correctly 3/3. Fields that don't apply to the
  // chosen action are emitted anyway and ignored (0 / '' by convention).
  required: ["action", "memory_number", "fact"],
  properties: {
    action: { type: "string", enum: ["none", "save_fact", "delete_fact", "change_job"] },
    fact: { type: "string" },
    memory_number: { type: "integer" },
  },
  // Required by OpenAI strict structured outputs (Tinfoil); Ollama ignores it.
  additionalProperties: false,
} as const;

/**
 * Classifier prompt. Tuned empirically against the sim; the examples matter
 * more than the prose on a small model, and the closing question-guard is what
 * stops ordinary questions being filed as facts.
 */
const ROUTER_PROMPT =
  "You classify the user's last message for a personal assistant.\n\n" +
  "save_fact -> the user states something lasting about themselves (schedule, " +
  "preferences, name, situation), or tells you to remember it. Copy it into " +
  "`fact` as a short sentence about the user. `fact` restates what the user " +
  "JUST SAID in this message — NEVER copy a sentence from the saved " +
  "memories list; those are already saved.\n" +
  "delete_fact -> the user asks you to forget, delete or drop something you " +
  "saved. Put that memory's number in `memory_number`. For every other " +
  "action set `memory_number` to 0, and for every action except save_fact " +
  "set `fact` to ''.\n" +
  "change_job -> the user wants you to work as a different KIND of assistant " +
  "from now on (a new role or profession for you). Choose this ONLY when what " +
  "YOU do changes. If the change is about the USER's own life or about a fact " +
  "you saved, it is save_fact, never change_job.\n" +
  "none -> questions, greetings, thanks, or a request to do a task.\n\n" +
  "Examples:\n" +
  "'Remember I train Mondays' -> save_fact, fact='the user trains on Mondays'\n" +
  "'I moved training to Tuesdays' -> save_fact, fact='the user trains on Tuesdays'\n" +
  "'Actually I train Fridays now. Update what you remember.' -> save_fact, " +
  "fact='the user trains on Fridays'\n" +
  "'My sister is called Mia' -> save_fact, fact=\"the user's sister is called Mia\"\n" +
  "'Rough week, Mia and I broke up' (saved: [1] the user's girlfriend is " +
  "called Mia) -> save_fact, fact='the user and Mia broke up'\n" +
  "'Delete what you saved about my address' (saved: [2] the user's address...) " +
  "-> delete_fact, memory_number=2\n" +
  "'Be my writing coach instead' -> change_job\n" +
  "'What day do I train?' -> none\n" +
  "'What's the weather in Lisbon tomorrow?' -> none\n" +
  "'Who wrote that book?' -> none\n" +
  "'Search for the latest Node.js release notes' -> none\n" +
  "'I moved to Lisbon — what's the weather there?' -> save_fact, " +
  "fact='the user lives in Lisbon'\n" +
  "'Can you help me plan the week?' -> none\n" +
  "'thanks' -> none\n\n" +
  "A message ending in '?' is almost always none.";

/**
 * Words that mean the user is talking about the Blob's *memory*, not its job.
 *
 * The sim found "Update what you remember" classified as a job change on
 * every run — "update" outweighs everything else for a small model. This is a
 * deterministic signal the classifier cannot argue with, so it is computed
 * here and stated in the prompt rather than hoped for.
 */
const MEMORY_WORDS = /\b(remember|memory|memories|forget|forgot|recall)\b/i;

/**
 * How much of a group's transcript the responder router sees.
 *
 * Four lines, 200 chars each. The router's job is to resolve what a message
 * refers to ("and the cost?"), not to understand the conversation — and more
 * context measurably pulls a small model towards picking whoever appears in
 * it rather than whoever the message needs.
 */
const GROUP_CONTEXT_LINES = 4;
const GROUP_CONTEXT_CHARS = 200;

/** Grammar for the reconcile call: only a list of positions is legal. */
const RECONCILE_SCHEMA = {
  type: "object",
  required: ["obsolete"],
  properties: {
    obsolete: { type: "array", items: { type: "integer" } },
  },
  // Required by OpenAI strict structured outputs (Tinfoil); Ollama ignores it.
  additionalProperties: false,
} as const;

/**
 * Decide which saved facts a new fact makes untrue.
 *
 * Word overlap cannot do this: "Ken's girlfriend is called Sarah" and "Sarah
 * and Ken broke up" share almost no words yet cannot both be true, while
 * "allergic to peanuts" and "allergic to shellfish" share nearly all of theirs
 * and both are. Meaning is the model's job — asked through a grammar so even a
 * 2B model can only answer with positions.
 *
 * Returns 1-based positions into `existing`. Empty on any failure, so a
 * reconcile problem can only ever leave memory as it was.
 */
export async function reconcileMemories(options: {
  model: string;
  fact: string;
  existing: BlobMemory[];
  signal?: AbortSignal;
}): Promise<number[]> {
  if (options.existing.length === 0) {
    return [];
  }
  const numbered = options.existing
    .map((memory, index) => `${index + 1}. ${memory.text}`)
    .join("\n");
  // Same deadline discipline as the router: a stalled model must not hang a
  // memory save, and cancelling the turn must cancel this too.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ROUTER_TIMEOUT_MS);
  const onParentAbort = () => deadline.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      deadline.abort();
    } else {
      options.signal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  const reconcileMessages = [
    {
      role: "system",
      content:
        "You keep a person's saved facts up to date.\n\n" +
        "Every fact — new and saved — is about the SAME one person, whether " +
        "it calls them 'the user', a name, or anything else. Never treat a " +
        "different wording of the subject as a different person.\n\n" +
        "Given a NEW fact, list the numbers of saved facts that are now " +
        "WRONG or OUT OF DATE because of it. A saved fact is obsolete when " +
        "the new fact replaces it or contradicts it \u2014 people change jobs, " +
        "partners, cities and schedules, and the old version is no longer " +
        "true. Facts that can BOTH be true at once are not obsolete.\n\n" +
        "Examples:\n" +
        "new: 'the user and Sarah broke up' / saved: '1. Ken's girlfriend is " +
        "called Sarah' -> obsolete [1] (same person, relationship over)\n" +
        "new: 'the user works at Beta Corp' / saved: '1. Ken works at Acme' -> obsolete [1]\n" +
        "new: 'the user is allergic to shellfish' / saved: '1. Ken is allergic " +
        "to peanuts' -> obsolete [] (same person, but two allergies can " +
        "BOTH be true — adding is not replacing)\n" +
        "new: 'Ken trains on Fridays' / saved: '1. Ken trains on Mondays', " +
        "'2. Ken has a sister' -> obsolete [1]",
    },
    { role: "user", content: `NEW fact:\n${options.fact}\n\nSaved facts:\n${numbered}` },
  ];
  try {
    let content: string;
    if (isTinfoilModel(options.model)) {
      const result = await tinfoilStructuredCall({
        model: options.model,
        messages: reconcileMessages,
        schema: RECONCILE_SCHEMA,
        schemaName: "reconcile_memories",
        temperature: ROUTER_TEMPERATURE,
        maxTokens: ROUTER_MAX_TOKENS,
        signal: deadline.signal,
      });
      if (result === null) {
        return [];
      }
      content = result;
    } else {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: deadline.signal,
        body: JSON.stringify({
          model: options.model,
          stream: false,
          think: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          format: RECONCILE_SCHEMA,
          options: ROUTER_OPTIONS,
          messages: reconcileMessages,
        }),
      });
      if (!response.ok) {
        return [];
      }
      const payload = (await response.json()) as { message?: { content?: string } };
      content = payload.message?.content ?? "{}";
    }
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object") {
      return [];
    }
    const list = (parsed as Record<string, unknown>).obsolete;
    if (!Array.isArray(list)) {
      return [];
    }
    return list.filter(
      (value): value is number =>
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= options.existing.length,
    );
  } catch {
    // Timeout, abort, offline server, malformed JSON: keep memory as it was.
    return [];
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Apply a group message's classification to the *shared* memory scope.
 *
 * Returns the new list, or null when nothing changed.
 *
 * Two decisions, both about who owns a fact said in a room:
 *
 * The scope is **shared**, never one Blob's own. Six responders each writing
 * their private copy of the same sentence — each reconciled against a
 * different list — is how a group ends up with six drifting versions of one
 * thing the user said once. Shared is also simply true: it was said to
 * everyone, and every Blob already reads this scope.
 *
 * `change_job` is dropped. In a one-to-one chat "be my writing coach instead"
 * has one unambiguous subject; in a group it does not, and silently
 * reconfiguring whichever Blob happened to answer would be a destructive
 * guess. The user can say it in that Blob's own chat.
 */
export async function applyGroupIntent(
  intent: Intent,
  options: { model: string; memories: BlobMemory[]; signal?: AbortSignal },
): Promise<BlobMemory[] | null> {
  if (intent.action === "save_fact") {
    const text = (intent.fact ?? "").trim().slice(0, MEMORY_TEXT_LIMIT);
    if (text === "") {
      return null;
    }
    // Same duplicate guard as the per-Blob path: a group repeats itself more,
    // not less, because several Blobs may prompt the user to restate things.
    if (options.memories.some((memory) => memory.text.toLowerCase() === text.toLowerCase())) {
      return null;
    }
    const obsolete = await reconcileMemories({
      model: options.model,
      fact: text,
      existing: options.memories,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const kept = options.memories.filter((_, index) => !obsolete.includes(index + 1));
    return [
      ...kept.slice(Math.max(0, kept.length - (MEMORY_LIMIT - 1))),
      { id: crypto.randomUUID(), text, createdAt: Date.now() },
    ];
  }
  if (intent.action === "delete_fact") {
    const at = (intent.memoryNumber ?? 0) - 1;
    if (at < 0 || at >= options.memories.length) {
      return null;
    }
    return options.memories.filter((_, index) => index !== at);
  }
  return null;
}

/**
 * Pick which members of a group answer a message.
 *
 * Only reached when nobody was addressed — a mention or a reply is answered
 * without a model call (see `addressedResponders`). What this replaces is
 * "every member answers", which on one local model means N serial turns and N
 * near-identical replies to a question that concerned one of them.
 *
 * Same mechanism as the intent router and for the same reason: choosing is
 * what small models are bad at, filling a grammar is what they are reliable
 * at. The enum is the members' own names, so an unknown name is not merely
 * filtered afterwards — it is not generatable.
 *
 * Fails open to everyone: a router problem must never leave a group silent,
 * and "everyone answers" is exactly the behaviour this refines.
 *
 * The opening line asks for every task in the message, not just its subject.
 * That is what makes "check X, then write it up" reach both the researcher
 * and the writer instead of one of them; without it the second job silently
 * never starts. Measured on qwen3.5:9b, which is the floor these prompts are
 * tuned for: this wording also fixed "hi all" (0/2 -> 2/2 at listing
 * everyone), with the single-job cases unchanged at 2/2.
 *
 * It does *not* rescue a 2b-class model — that never picked both under any of
 * three wordings, and two of them broke its single-job routing. Judging this
 * prompt on a model that small optimises for a room it cannot hold anyway.
 */
export async function pickResponders(options: {
  model: string;
  text: string;
  members: { name: string; title?: string; description?: string }[];
  /**
   * The few lines before this message, oldest first, already labelled
   * ("Ken: …", "Scout: …"). "and what did that cost?" is unroutable on its
   * own — the subject was three messages ago.
   */
  recent?: string[];
  signal?: AbortSignal;
}): Promise<string[]> {
  const names = options.members.map((member) => member.name);
  // Nothing to choose between, and no reason to pay for a call.
  if (options.members.length <= 1 || options.text.trim() === "") {
    return names;
  }
  const schema = {
    type: "object",
    required: ["responders"],
    properties: {
      responders: { type: "array", items: { type: "string", enum: names } },
    },
    additionalProperties: false,
  } as const;
  // Enough to resolve "that"/"it", short enough that the message itself is
  // still the loudest thing in the prompt.
  const recent = (options.recent ?? [])
    .slice(-GROUP_CONTEXT_LINES)
    .map((line) => `- ${line.replace(/\s+/g, " ").slice(0, GROUP_CONTEXT_CHARS)}`)
    .join("\n");
  const roster = options.members
    .map(
      (member) =>
        `- ${member.name}: ${
          [member.title, member.description]
            .map((part) => (part ?? "").trim())
            .filter((part) => part !== "")
            .join(" \u2014 ") || "no stated job"
        }`,
    )
    .join("\n");
  const messages = [
    {
      role: "system",
      content:
        "People in a group chat have different jobs. Read the message for " +
        "every task in it, and list the people whose job each task needs \u2014 " +
        "one person per task, nobody else.\n\n" +
        "Rules:\n" +
        "- Usually a message is one task and needs one person. \u201CCheck X, then " +
        "write it up\u201D is two tasks and needs two people.\n" +
        "- Never everyone unless the message is addressed to the group " +
        "(\u201Ceveryone\u201D, \u201Cyou all\u201D, a general greeting or announcement) \u2014 then " +
        "list everyone.\n" +
        "- Someone whose job no task needs stays quiet. Silence is normal and " +
        "correct \u2014 do not add people to be safe.\n" +
        "- Judge by their job, not by who spoke last.\n" +
        // The context is for resolving what the message refers to, not for
        // re-answering it: without this line a small model picks whoever was
        // busy in the excerpt.
        "- Earlier lines are only to work out what the message is ABOUT. Do " +
        "not pick someone merely because they appear there.\n\n" +
        `The people:\n${roster}` +
        (recent === "" ? "" : `\n\nEarlier in the chat:\n${recent}`),
    },
    { role: "user", content: options.text },
  ];
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ROUTER_TIMEOUT_MS);
  const onParentAbort = () => deadline.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      deadline.abort();
    } else {
      options.signal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  try {
    let content: string;
    if (isTinfoilModel(options.model)) {
      const result = await tinfoilStructuredCall({
        model: options.model,
        messages,
        schema,
        schemaName: "pick_responders",
        temperature: ROUTER_TEMPERATURE,
        maxTokens: ROUTER_MAX_TOKENS,
        signal: deadline.signal,
      });
      if (result === null) {
        return names;
      }
      content = result;
    } else {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: deadline.signal,
        body: JSON.stringify({
          model: options.model,
          stream: false,
          think: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          format: schema,
          options: ROUTER_OPTIONS,
          messages,
        }),
      });
      if (!response.ok) {
        return names;
      }
      const payload = (await response.json()) as { message?: { content?: string } };
      content = payload.message?.content ?? "{}";
    }
    const parsed: unknown = JSON.parse(content);
    const picked = (parsed as Record<string, unknown> | null)?.responders;
    if (!Array.isArray(picked)) {
      return names;
    }
    // Dedupe and re-order by the roster: the model's ordering is arbitrary,
    // and a group reads best when the same people always speak in the same
    // order. A pick of nobody means nobody — that is the point of the router.
    const wanted = new Set(picked.filter((value): value is string => typeof value === "string"));
    return names.filter((name) => wanted.has(name));
  } catch {
    // Timeout, abort, offline, malformed JSON: everyone answers, which is the
    // behaviour this function refines rather than a new failure.
    return names;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}

/** Text of the most recent user message, or "" when there is none. */
function lastUserText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

/**
 * Classify the latest user message. Returns `{ action: "none" }` on any
 * failure, so a router problem can never block a reply.
 */
export async function routeIntent(options: {
  model: string;
  messages: Message[];
  memories: BlobMemory[];
  signal?: AbortSignal;
}): Promise<Intent> {
  const text = lastUserText(options.messages);
  if (text.trim() === "") {
    return { action: "none" };
  }
  // Chain the caller's abort with our own deadline, so cancelling the turn
  // cancels the router too and neither can outlive the other.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ROUTER_TIMEOUT_MS);
  const onParentAbort = () => deadline.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      deadline.abort();
    } else {
      options.signal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  // The per-message hint rides on the USER turn, never the system one. Ollama's
  // prefix cache is exact-match from token zero, so a system prompt that gains
  // and loses a sentence depending on the words in the message re-prefills the
  // whole router prompt on every flip — and flips back on the next message.
  // Kept here, the system half changes only when a memory is written.
  const hint = MEMORY_WORDS.test(text)
    ? "\n\n(This message mentions your memory, so it is about a saved fact: " +
      "choose save_fact or delete_fact, never change_job.)"
    : "";
  const routerMessages = [
    {
      role: "system",
      // The memory list is numbered exactly as the Blob sees it, so
      // `memory_number` lines up with what the user is referring to.
      content: `${ROUTER_PROMPT}\n\nYour saved memories:${
        renderMemories(options.memories) || "\n(none)"
      }`,
    },
    { role: "user", content: `${text}${hint}` },
  ];
  try {
    let content: string;
    if (isTinfoilModel(options.model)) {
      const result = await tinfoilStructuredCall({
        model: options.model,
        messages: routerMessages,
        schema: INTENT_SCHEMA,
        schemaName: "route_intent",
        temperature: ROUTER_TEMPERATURE,
        maxTokens: ROUTER_MAX_TOKENS,
        signal: deadline.signal,
      });
      if (result === null) {
        return { action: "none" };
      }
      content = result;
    } else {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: deadline.signal,
        body: JSON.stringify({
          model: options.model,
          stream: false,
          think: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          format: INTENT_SCHEMA,
          options: ROUTER_OPTIONS,
          messages: routerMessages,
        }),
      });
      if (!response.ok) {
        return { action: "none" };
      }
      const payload = (await response.json()) as { message?: { content?: string } };
      content = payload.message?.content ?? "{}";
    }
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object") {
      return { action: "none" };
    }
    const record = parsed as Record<string, unknown>;
    // Fail open: anything but an explicit false keeps the web tools.
    switch (record.action) {
      case "save_fact": {
        const fact = typeof record.fact === "string" ? record.fact.trim() : "";
        return fact === "" ? { action: "none" } : { action: "save_fact", fact };
      }
      case "delete_fact": {
        const number = record.memory_number;
        return typeof number === "number" && Number.isInteger(number) && number >= 1
          ? { action: "delete_fact", memoryNumber: number }
          : { action: "none" };
      }
      case "change_job":
        // Belt and braces: a memory-flavoured message is never a job change,
        // whatever the classifier says.
        return MEMORY_WORDS.test(text) ? { action: "none" } : { action: "change_job" };
      default:
        return { action: "none" };
    }
  } catch {
    // Timeout, abort, offline server, malformed JSON: the turn continues with
    // the tools, which is exactly the behaviour before the router existed.
    return { action: "none" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}
