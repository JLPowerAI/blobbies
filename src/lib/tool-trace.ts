import type { Message } from "@kenkaiiii/gg-ai";
import type { ToolTraceEntry } from "@/data/agents";

/** Longest argument string kept per call. Enough for a wrong field name. */
const ARGS_CHARS = 120;
/** Longest result kept per call. Enough for an error, not for a page of JSON. */
const RESULT_CHARS = 200;
/**
 * Most calls kept for one message. A turn that made forty calls does not need
 * to replay forty: the last few carry what it was doing, and this rides along
 * on every later turn.
 */
const MAX_ENTRIES = 8;

/**
 * Clip to `limit`, saying so when it cuts.
 *
 * The marker is not decoration. A silent ellipsis reads as the end of the
 * value, so a model seeing a clipped error can conclude the tool said less
 * than it did; every truncation the model can see is labelled.
 */
function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}… [truncated]` : flat;
}

/**
 * Cut a turn's calls down to what is worth keeping, at capture time.
 *
 * Called before the trace is stored, not just before it is sent. A tool result
 * is unbounded — an app tool can return a page of JSON — and the transcript is
 * rewritten to disk on every checkpoint, so storing raw results would grow the
 * saved conversation without limit for data that is clipped the moment it is
 * used anyway.
 */
export function trimToolTrace(entries: readonly ToolTraceEntry[]): ToolTraceEntry[] {
  return entries.slice(-MAX_ENTRIES).map((entry) => ({
    name: entry.name,
    ...(entry.args === undefined ? {} : { args: clip(entry.args, ARGS_CHARS) }),
    ...(entry.result === undefined ? {} : { result: clip(entry.result, RESULT_CHARS) }),
    ...(entry.failed === true ? { failed: true } : {}),
  }));
}

/**
 * Replay a past turn's tool calls as the messages they originally were.
 *
 * Without this the transcript reads as "assistant knew this having called
 * nothing", and the model copies that shape — measured inventing file contents
 * (sim/grounding.sim.ts), and reported re-promising a fix it had already tried
 * because no trace of the attempt survived.
 *
 * Native `tool_call` parts and `role: "tool"` results rather than a prose
 * summary: it is the shape every provider already understands, so a failed
 * call reads to the model as a failed call — `isError` and all — instead of as
 * the Blob's own paraphrase of one. Args and results are clipped because this
 * is replayed on every later turn.
 *
 * Emits an assistant/tool PAIR, always adjacent and always in this order. A
 * `role: "tool"` message with no preceding `tool_call` is a hard provider
 * error, so the two must never be separated — see `dropOrphanToolResults`.
 */
export function toolTraceMessages(
  entries: readonly ToolTraceEntry[],
  messageId: string,
): Message[] {
  if (entries.length === 0) {
    return [];
  }
  // Belt and braces: `trimToolTrace` already did this at capture, but a trace
  // stored before that existed is still in someone's transcript.
  const kept = trimToolTrace(entries);
  // Ids only have to be unique within the request, and the stored trace has
  // none of its own — the transcript id plus position gives a stable one.
  const idOf = (index: number): string => `${messageId}-t${index}`;
  return [
    {
      role: "assistant",
      content: kept.map((entry, index) => ({
        type: "tool_call" as const,
        id: idOf(index),
        name: entry.name,
        args: parseArgs(entry.args),
      })),
    },
    {
      role: "tool",
      content: kept.map((entry, index) => ({
        type: "tool_result" as const,
        toolCallId: idOf(index),
        content: entry.result === undefined ? "(no output)" : clip(entry.result, RESULT_CHARS),
        ...(entry.failed === true ? { isError: true } : {}),
      })),
    },
  ];
}

/** Stored as JSON text; a malformed one must not lose the call that was made. */
function parseArgs(args: string | undefined): Record<string, unknown> {
  if (args === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? clipArgs(parsed as Record<string, unknown>)
      : { value: clip(args, ARGS_CHARS) };
  } catch {
    return { value: clip(args, ARGS_CHARS) };
  }
}

/** Keep argument names exact — the wrong-field case is the point — but cap values. */
function clipArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "string" ? clip(value, ARGS_CHARS) : value,
    ]),
  );
}

/**
 * Remove `role: "tool"` messages whose `tool_call` never made it into the
 * window.
 *
 * History is trimmed from the front when a conversation outgrows the context
 * budget, and the cut lands wherever it lands — including between a replayed
 * assistant/tool pair. The leftover result is not merely useless: providers
 * reject a tool result with no matching call outright, which would take down
 * the whole turn rather than degrade it.
 */
export function dropOrphanToolResults(messages: readonly Message[]): Message[] {
  const called = new Set<string>();
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "tool_call") {
          called.add(part.id);
        }
      }
    }
    if (message.role === "tool") {
      const results = message.content.filter((result) => called.has(result.toolCallId));
      // Every result orphaned: the message would be empty, so it goes too.
      if (results.length > 0) {
        out.push({ ...message, content: results });
      }
      continue;
    }
    out.push(message);
  }
  return out;
}
