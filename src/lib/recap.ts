/**
 * Conversation recap: the part of a conversation that no longer fits in the
 * model's window, folded into a rolling summary.
 *
 * `splitHistory` (prompt.ts) drops the oldest block of a long conversation on
 * the turn it crosses the budget. Without this, what it drops is simply gone:
 * a Blob talked to for a week forgets how its job was described, what was
 * decided, and what it was in the middle of. Here the dropped block is
 * summarised into a short text that rides in the system prompt instead.
 *
 * Deliberately NOT the memory store (`memory.ts`): memories are durable facts
 * about the user, written from the user's own words and user-editable in
 * Settings. A recap is state of one conversation, written automatically and
 * replaced at every compaction — forty slots of "we were debugging the invoice
 * script" would evict real facts from a list the user owns.
 *
 * The summary is *updated*, never rebuilt: `coveredId` marks the newest
 * message already folded in, so each pass only reads what is new. Re-reading
 * material that is already summarised is the known drift failure mode of naive
 * recursive summarisation.
 */
import type { Message } from "@kenkaiiii/gg-ai";
import { streamLocalChat } from "@/lib/ai";

/** A conversation's rolling summary, one per conversation (Blob or group). */
export interface Recap {
  /** The summary itself, at most `RECAP_CHARS`. Replaced, never appended to. */
  text: string;
  /** Transcript id of the newest message already folded into `text`. */
  coveredId: string;
}

/** One dropped history message, paired with the transcript id it came from. */
export interface RecapEntry {
  id: string;
  message: Message;
}

/**
 * Hard cap on the recap, in characters (~300 tokens, ~7% of the local 16k
 * window). It is charged against the history budget in `splitHistory`, so
 * every character here is a character of real conversation given up; the size
 * is in the range production summarisers use (LangMem defaults to 256 tokens).
 */
export const RECAP_CHARS = 1_200;

/**
 * Cap on what one summarisation pass reads (~6k tokens). Keeps a compaction
 * bounded on a small local model: the OLDEST messages that fit are folded now
 * and the rest on the next pass, so nothing is skipped — it is only deferred.
 */
const RECAP_INPUT_CHARS = 24_000;

/** Ceiling for the summary itself; the prompt asks for far less. */
const RECAP_MAX_TOKENS = 400;

/** A stalled model must not hold up the next turn in the queue. */
const RECAP_TIMEOUT_MS = 60_000;

/**
 * The dropped messages not yet folded into `recap`.
 *
 * When the covered id is no longer in the block (the message was deleted, or
 * the conversation was rolled over) the whole block is returned: a missing id
 * must not silently freeze compaction forever.
 */
export function pendingMessages(dropped: RecapEntry[], recap?: Recap): RecapEntry[] {
  if (recap === undefined) {
    return dropped;
  }
  const covered = dropped.findIndex((entry) => entry.id === recap.coveredId);
  return covered === -1 ? dropped : dropped.slice(covered + 1);
}

/**
 * Dropped exchanges as plain labelled lines — the summariser reads a
 * transcript, not a conversation it is taking part in.
 *
 * Capped at `RECAP_INPUT_CHARS`, keeping the oldest that fit: the newest
 * messages are the ones a later pass will still have.
 *
 * `coveredId` is the last entry that actually made it into the text, and it is
 * the only safe thing to record as summarised. Stamping the caller's newest
 * *pending* message instead would mark everything past the cut as covered
 * without a model ever reading it — dropped from the prompt AND missing from
 * the recap, which is the one outcome this module exists to prevent. It only
 * matters on a big window (a 131k-token one drops ~100k characters against a
 * 24k cap), where it would be most of every block.
 *
 * Null when nothing renders: an empty pass has covered nothing.
 */
export function renderBlock(
  entries: RecapEntry[],
  blobName: string,
): { text: string; coveredId: string } | null {
  const lines: string[] = [];
  let coveredId: string | undefined;
  let total = 0;
  for (const entry of entries) {
    const content = entry.message.content;
    const body = (typeof content === "string" ? content : JSON.stringify(content)).trim();
    if (body === "") {
      continue;
    }
    const line = `${entry.message.role === "assistant" ? blobName : "User"}: ${body}`;
    // +1 for the newline this line joins on, so the budget counts what is sent.
    if (total + line.length + 1 > RECAP_INPUT_CHARS && lines.length > 0) {
      break;
    }
    total += line.length + 1;
    lines.push(line);
    // A single message longer than the whole cap is clipped below and still
    // counted as covered: it can never fit, and re-offering it every turn
    // would wedge compaction on it forever.
    coveredId = entry.id;
  }
  return coveredId === undefined
    ? null
    : { text: lines.join("\n").slice(0, RECAP_INPUT_CHARS), coveredId };
}

/**
 * Enforce the size cap the prompt only asks for, cutting at a sentence end so
 * a recap never trails off mid-word.
 */
export function clipRecap(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= RECAP_CHARS) {
    return trimmed;
  }
  const cut = trimmed.slice(0, RECAP_CHARS);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  // Only honour a sentence end in the last third; an early one would throw
  // away most of the summary to gain a tidy ending.
  return (stop > RECAP_CHARS * 0.66 ? cut.slice(0, stop + 1) : cut).trim();
}

const RECAP_PROMPT =
  "You maintain a running summary of a conversation between a user and an " +
  "assistant, so the assistant can keep working after the older messages " +
  "scroll out of its context.\n\n" +
  "You are given the previous summary (may be empty) inside <recap> tags, " +
  "followed by the messages that have since scrolled out. Write the UPDATED " +
  "summary: fold the new messages into the previous one, keeping what still " +
  "matters and dropping what has been settled or superseded.\n\n" +
  "Keep, in this order and only when present:\n" +
  "- what the user is trying to get done\n" +
  "- standing preferences and instructions they gave\n" +
  "- decisions made, and facts established (names, numbers, dates exactly as written)\n" +
  "- what is still open or unfinished\n\n" +
  "Rules: under 150 words. Plain prose or short lines, no headings. Write " +
  "about them in the third person ('the user asked…'). Invent nothing and " +
  "resolve nothing that was left open. Output the summary only — no preamble, " +
  "no commentary.";

/**
 * Fold `entries` into `previous`, returning the new recap text and what the
 * call cost. Returns null on timeout, error or empty output.
 *
 * Failure is safe by construction: the caller leaves `coveredId` where it was,
 * so the next compaction retries with a larger block, and the messages were
 * dropped from the prompt either way — which is exactly what happened before
 * recaps existed. This can improve on that floor but never fall below it.
 */
export async function summarizeHistory(options: {
  model: string;
  previous: string | undefined;
  entries: RecapEntry[];
  blobName: string;
  signal?: AbortSignal;
}): Promise<{
  text: string;
  /** Newest entry this pass actually read; what the caller must record. */
  coveredId: string;
  usage: { inputTokens: number; outputTokens: number };
} | null> {
  const block = renderBlock(options.entries, options.blobName);
  if (block === null) {
    return null;
  }
  // Same deadline discipline as the intent router: a stalled model must not
  // hang the turn queue, and cancelling the turn must cancel this too.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), RECAP_TIMEOUT_MS);
  const onParentAbort = () => deadline.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      deadline.abort();
    } else {
      options.signal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  try {
    const response = await streamLocalChat({
      model: options.model,
      messages: [
        { role: "system", content: RECAP_PROMPT },
        {
          role: "user",
          content:
            `<recap>\n${options.previous ?? ""}\n</recap>\n\n` +
            `Messages that just scrolled out:\n${block.text}`,
        },
      ],
      maxTokens: RECAP_MAX_TOKENS,
      signal: deadline.signal,
    });
    const content = response.message.content;
    const text = clipRecap(
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(""),
    );
    return text === ""
      ? null
      : {
          text,
          coveredId: block.coveredId,
          usage: {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
          },
        };
  } catch {
    // Timeout, abort, offline server: the conversation keeps the recap it had.
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}
