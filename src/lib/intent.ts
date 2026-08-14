import type { Message } from "@kenkaiiii/gg-ai";
import { type BlobMemory, renderMemories } from "@/lib/blob-tools";
import { OLLAMA_URL } from "@/lib/ollama";

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
 */

/** What the router decided the user's last message calls for. */
export type Intent =
  | { action: "none" }
  | { action: "save_fact"; fact: string }
  | { action: "delete_fact"; memoryNumber: number }
  | { action: "change_job" };

/** Grammar the model must fill; `action` is a closed enum, so it cannot stray. */
const INTENT_SCHEMA = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["none", "save_fact", "delete_fact", "change_job"] },
    fact: { type: "string" },
    memory_number: { type: "integer" },
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
  "`fact` as a short sentence about the user.\n" +
  "delete_fact -> the user asks you to forget, delete or drop something you " +
  "saved. Put that memory's number in `memory_number`.\n" +
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
  "'Delete what you saved about my address' -> delete_fact\n" +
  "'Be my writing coach instead' -> change_job\n" +
  "'Stop being my coach, help me with recipes now' -> change_job\n" +
  "'What day do I train?' -> none\n" +
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
  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      body: JSON.stringify({
        model: options.model,
        stream: false,
        think: false,
        format: INTENT_SCHEMA,
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
      return { action: "none" };
    }
    const payload = (await response.json()) as { message?: { content?: string } };
    const parsed: unknown = JSON.parse(payload.message?.content ?? "{}");
    if (parsed === null || typeof parsed !== "object") {
      return { action: "none" };
    }
    const record = parsed as Record<string, unknown>;
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
    return { action: "none" };
  }
}
