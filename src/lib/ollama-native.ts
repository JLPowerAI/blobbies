import {
  type Message,
  providerRegistry,
  type StopReason,
  type StreamEvent,
  type StreamOptions,
  type StreamResponse,
  StreamResult,
  type ToolCall,
} from "@kenkaiiii/gg-ai";
import { z } from "zod";
import { OLLAMA_URL } from "@/lib/ollama";

/**
 * Context window requested for every Blob turn, in tokens.
 *
 * Ollama's stock server default is 4096, which a normal conversation fills in
 * a few exchanges — the model then silently truncates the transcript and the
 * reply dies mid-sentence. The native /api/chat endpoint accepts a per-request
 * `num_ctx`, so the app asks for a real window instead of requiring every
 * user to reconfigure their Ollama install.
 *
 * simplification: fixed budget, not adaptive to model or free RAM. 16k of KV
 * cache is tens of MB for the small models this app targets; an adaptive pick
 * would need /api/ps probing and an eviction story.
 */
export const OLLAMA_NUM_CTX = 16384;

/**
 * How long Ollama keeps the model loaded after each request.
 *
 * The server default is 5 minutes: an "employee" Blob the user returns to
 * after a coffee break would pay a multi-second cold reload — and lose the
 * whole KV cache with it, so the entire conversation re-prefills too. Every
 * request from this app (chat, router, reconcile, configure) sends this same
 * value; the timer resets on each call.
 *
 * simplification: fixed duration, not a Settings knob. "-1" (never unload)
 * would hold RAM hostage on shared machines; 30m covers normal pauses.
 */
export const OLLAMA_KEEP_ALIVE = "30m";

/** Wire shape of one native /api/chat message. */
interface NativeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

/** One NDJSON chunk streamed by native /api/chat. */
interface NativeChunk {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { function?: { name?: string; arguments?: Record<string, unknown> } }[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Text of a content part list, ignoring non-text parts (this app sends none). */
function textOf(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * gg-ai transcript → native /api/chat messages.
 *
 * Ollama's native API has no tool-call ids: an assistant's calls are matched
 * to `role:"tool"` replies by order and `tool_name`. The ids gg-agent minted
 * are resolved to names here and dropped from the wire.
 */
export function toNativeMessages(messages: Message[]): NativeMessage[] {
  const nameById = new Map<string, string>();
  const out: NativeMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
    } else if (message.role === "user") {
      out.push({ role: "user", content: textOf(message.content) });
    } else if (message.role === "assistant") {
      const calls: ToolCall[] =
        typeof message.content === "string"
          ? []
          : message.content.filter((part): part is ToolCall => part.type === "tool_call");
      for (const call of calls) {
        nameById.set(call.id, call.name);
      }
      out.push({
        role: "assistant",
        content: textOf(message.content),
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((call) => ({
                function: { name: call.name, arguments: call.args },
              })),
            }
          : {}),
      });
    } else {
      for (const result of message.content) {
        const name = nameById.get(result.toolCallId);
        out.push({
          role: "tool",
          content: typeof result.content === "string" ? result.content : textOf(result.content),
          ...(name === undefined ? {} : { tool_name: name }),
        });
      }
    }
  }
  return out;
}

/** Map Ollama's done_reason onto gg-ai's stop reasons. */
function toStopReason(reason: string | undefined, sawToolCalls: boolean): StopReason {
  if (sawToolCalls) {
    return "tool_use";
  }
  if (reason === "length") {
    return "max_tokens";
  }
  return "end_turn";
}

async function* streamNativeOllama(
  options: StreamOptions,
): AsyncGenerator<StreamEvent, StreamResponse> {
  const body = {
    model: options.model,
    messages: toNativeMessages(options.messages),
    stream: true,
    keep_alive: OLLAMA_KEEP_ALIVE,
    // "none" is the app's explicit thinking-off sentinel; absent means model
    // default. Mirrors the reasoning_effort mapping the /v1 path used.
    ...(options.thinking === undefined ? {} : { think: options.thinking !== ("none" as string) }),
    ...(options.tools !== undefined && options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.rawInputSchema ?? z.toJSONSchema(tool.parameters),
            },
          })),
        }
      : {}),
    options: {
      num_ctx: OLLAMA_NUM_CTX,
      ...(options.maxTokens === undefined ? {} : { num_predict: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.topP === undefined ? {} : { top_p: options.topP }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
    },
  };
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    body: JSON.stringify(body),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Ollama /api/chat failed (${response.status}): ${await response.text()}`);
  }

  let text = "";
  let thinking = "";
  const toolCalls: ToolCall[] = [];
  let stopReason: StopReason = "end_turn";
  let inputTokens = 0;
  let outputTokens = 0;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  /** Parse one NDJSON line and emit its stream events. */
  function* handleLine(line: string): Generator<StreamEvent> {
    if (line.trim() === "") {
      return;
    }
    const chunk = JSON.parse(line) as NativeChunk;
    if (chunk.error !== undefined) {
      throw new Error(`Ollama /api/chat error: ${chunk.error}`);
    }
    if (chunk.message?.thinking !== undefined && chunk.message.thinking !== "") {
      thinking += chunk.message.thinking;
      yield { type: "thinking_delta", text: chunk.message.thinking };
    }
    if (chunk.message?.content !== undefined && chunk.message.content !== "") {
      text += chunk.message.content;
      yield { type: "text_delta", text: chunk.message.content };
    }
    for (const call of chunk.message?.tool_calls ?? []) {
      if (call.function?.name === undefined) {
        continue;
      }
      // Native Ollama has no call ids; mint stable ones for gg-agent.
      const id = `ollama-call-${toolCalls.length + 1}`;
      const toolCall: ToolCall = {
        type: "tool_call",
        id,
        name: call.function.name,
        args: call.function.arguments ?? {},
      };
      toolCalls.push(toolCall);
      yield {
        type: "toolcall_done",
        id,
        name: toolCall.name,
        args: toolCall.args,
      };
    }
    if (chunk.done === true) {
      stopReason = toStopReason(chunk.done_reason, toolCalls.length > 0);
      inputTokens = chunk.prompt_eval_count ?? 0;
      outputTokens = chunk.eval_count ?? 0;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      // The last element is a partial line (or ""); keep it for the next read.
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        yield* handleLine(line);
      }
    }
    // A body that ends without a trailing newline leaves its last line here.
    yield* handleLine(`${buffered}${decoder.decode()}`);
  } finally {
    reader.releaseLock();
  }

  yield { type: "done", stopReason };
  return {
    message: {
      role: "assistant",
      content: [
        ...(thinking === "" ? [] : [{ type: "thinking" as const, text: thinking }]),
        ...(text === "" ? [] : [{ type: "text" as const, text }]),
        ...toolCalls,
      ],
    },
    stopReason,
    usage: { inputTokens, outputTokens },
  };
}

/**
 * Replace gg-ai's built-in "local" provider (OpenAI-compat /v1, which cannot
 * set a context window) with Ollama's native /api/chat, so every request
 * carries `num_ctx` and long conversations stop truncating mid-reply on
 * stock Ollama installs. Idempotent; call before the first stream.
 */
export function registerNativeOllamaProvider(): void {
  providerRegistry.register("local", {
    stream: (options: StreamOptions) =>
      new StreamResult(streamNativeOllama(options), options.signal),
  });
}
