import type { Message } from "@kenkaiiii/gg-ai";
import { type BlobMemory, renderMemories } from "@/lib/blob-tools";
import { OLLAMA_URL } from "@/lib/ollama";
import { OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX } from "@/lib/ollama-native";

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
) & {
  /**
   * Whether answering needs the public internet. Decides if the chat loop
   * gets the web tools at all: offered unconditionally, qwen3.5:2b googled
   * "Ken Kai training schedule" instead of reading its own memory in 4/8
   * runs — sampling tweaks moved that between 38% and 63%, never to 100%.
   * The same model answering a required boolean under a grammar is the
   * mechanism this file exists for. True on any router failure: wrongly
   * offered tools are the old behaviour, wrongly withheld ones are a
   * capability silently gone.
   */
  needsWeb: boolean;
};

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
  required: ["action", "needs_web", "memory_number", "fact"],
  properties: {
    action: { type: "string", enum: ["none", "save_fact", "delete_fact", "change_job"] },
    fact: { type: "string" },
    memory_number: { type: "integer" },
    needs_web: { type: "boolean" },
  },
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
  "Separately, set `needs_web`: true when answering could use PUBLIC " +
  "information — news, weather, prices, documentation, books, people, facts " +
  "about the world — or the user asks to search or read a page. false when " +
  "the answer is about the user or the conversation itself: their own " +
  "schedule, preferences, memories, or what was said earlier. The web does " +
  "not know the user.\n\n" +
  "Examples:\n" +
  "'Remember I train Mondays' -> save_fact, fact='the user trains on Mondays', needs_web=false\n" +
  "'I moved training to Tuesdays' -> save_fact, fact='the user trains on Tuesdays', needs_web=false\n" +
  "'Actually I train Fridays now. Update what you remember.' -> save_fact, " +
  "fact='the user trains on Fridays', needs_web=false\n" +
  "'My sister is called Mia' -> save_fact, fact=\"the user's sister is called Mia\", needs_web=false\n" +
  "'Rough week, Mia and I broke up' (saved: [1] the user's girlfriend is " +
  "called Mia) -> save_fact, fact='the user and Mia broke up', needs_web=false\n" +
  "'Delete what you saved about my address' (saved: [2] the user's address...) " +
  "-> delete_fact, memory_number=2, needs_web=false\n" +
  "'Be my writing coach instead' -> change_job, needs_web=false\n" +
  "'What day do I train?' -> none, needs_web=false\n" +
  "'What's the weather in Lisbon tomorrow?' -> none, needs_web=true\n" +
  "'Who wrote that book?' -> none, needs_web=true\n" +
  "'Search for the latest Node.js release notes' -> none, needs_web=true\n" +
  "'I moved to Lisbon — what's the weather there?' -> save_fact, " +
  "fact='the user lives in Lisbon', needs_web=true\n" +
  "'Can you help me plan the week?' -> none, needs_web=false\n" +
  "'thanks' -> none, needs_web=false\n\n" +
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

/** Grammar for the reconcile call: only a list of positions is legal. */
const RECONCILE_SCHEMA = {
  type: "object",
  required: ["obsolete"],
  properties: {
    obsolete: { type: "array", items: { type: "integer" } },
  },
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
  try {
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
        messages: [
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
        ],
      }),
    });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as { message?: { content?: string } };
    const parsed: unknown = JSON.parse(payload.message?.content ?? "{}");
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
    return { action: "none", needsWeb: true };
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
  try {
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
        messages: [
          {
            role: "system",
            // The memory list is numbered exactly as the Blob sees it, so
            // `memory_number` lines up with what the user is referring to.
            content:
              `${ROUTER_PROMPT}\n\nYour saved memories:${
                renderMemories(options.memories) || "\n(none)"
              }` +
              (MEMORY_WORDS.test(text)
                ? "\n\nThis message mentions your memory, so it is about a saved " +
                  "fact: choose save_fact or delete_fact, never change_job."
                : ""),
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!response.ok) {
      return { action: "none", needsWeb: true };
    }
    const payload = (await response.json()) as { message?: { content?: string } };
    const parsed: unknown = JSON.parse(payload.message?.content ?? "{}");
    if (parsed === null || typeof parsed !== "object") {
      return { action: "none", needsWeb: true };
    }
    const record = parsed as Record<string, unknown>;
    // Fail open: anything but an explicit false keeps the web tools.
    const needsWeb = record.needs_web !== false;
    switch (record.action) {
      case "save_fact": {
        const fact = typeof record.fact === "string" ? record.fact.trim() : "";
        return fact === "" ? { action: "none", needsWeb } : { action: "save_fact", fact, needsWeb };
      }
      case "delete_fact": {
        const number = record.memory_number;
        return typeof number === "number" && Number.isInteger(number) && number >= 1
          ? { action: "delete_fact", memoryNumber: number, needsWeb }
          : { action: "none", needsWeb };
      }
      case "change_job":
        // Belt and braces: a memory-flavoured message is never a job change,
        // whatever the classifier says.
        return MEMORY_WORDS.test(text)
          ? { action: "none", needsWeb }
          : { action: "change_job", needsWeb };
      default:
        return { action: "none", needsWeb };
    }
  } catch {
    // Timeout, abort, offline server, malformed JSON: the turn continues with
    // the tools, which is exactly the behaviour before the router existed.
    return { action: "none", needsWeb: true };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}
