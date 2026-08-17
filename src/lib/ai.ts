import { type AgentTool, agentLoop, isAbortError } from "@kenkaiiii/gg-agent";
import {
  type Message,
  type Provider,
  type StreamResult,
  stream,
  type ThinkingLevel,
  type Tool,
} from "@kenkaiiii/gg-ai";
import { z } from "zod";
import {
  type MemoryAccess,
  makeAskTool,
  makeBlobTools,
  makeFsTools,
  makeRosterTools,
  type PendingAsk,
  type RosterAccess,
} from "@/lib/blob-tools";
import type { HomeBackend } from "@/lib/home";
import { type Intent, routeIntent } from "@/lib/intent";
import { loadMcpTools, type McpServerConfig } from "@/lib/mcp";
import { OLLAMA_URL } from "@/lib/ollama";
import {
  OLLAMA_KEEP_ALIVE,
  OLLAMA_NUM_CTX,
  registerNativeOllamaProvider,
} from "@/lib/ollama-native";
import { isTinfoilModel, registerTinfoilProvider, tinfoilStructuredCall } from "@/lib/tinfoil";

// From here on, "local" streams over native /api/chat so every turn carries
// a real context window (see ollama-native.ts) — /v1 cannot set one and
// silently truncates long conversations at Ollama's 4096 default.
registerNativeOllamaProvider();
// "tinfoil" routes gg-ai's OpenAI provider through Tinfoil's attested,
// end-to-end-encrypted enclave transport — see tinfoil.ts for the decision.
registerTinfoilProvider();

/** Which registered gg-ai provider serves this Settings model choice. */
function providerFor(model: string): Provider {
  return (isTinfoilModel(model) ? "tinfoil" : "local") as Provider;
}

/**
 * Reasoning models (qwen3, deepseek-r1, …) default to emitting thousands of
 * hidden chain-of-thought tokens before the first visible word — measured 21s
 * for a one-line reply. The native provider maps this sentinel to Ollama's
 * `think: false`, which disables that. Non-thinking models simply ignore it.
 */
const NO_THINKING = "none" as ThinkingLevel;

/** Backstop so a runaway local model can't generate forever. */
const MAX_REPLY_TOKENS = 4096;

// Chat temperature stays at the model's default on purpose: the sim measured
// restraint at 50% (default), 63% (0.3) and 38% (0.1) — noise, not a lever.
// Tool discipline comes from the router's `needsWeb` verdict instead.

/**
 * Chat streaming through one of the two providers registered above: local
 * Ollama, or (for `tinfoil:` model ids) Tinfoil's client-attested enclaves —
 * the one cloud path allowed, by explicit product decision: attestation is
 * verified on-device and request bodies are encrypted end to end, so the
 * operator cannot read user content. Nothing else should be added.
 *
 * Usage (dual-nature result):
 *   for await (const event of streamLocalChat({ model, messages })) { ... }
 *   const response = await streamLocalChat({ model, messages });
 */
export function streamLocalChat(options: {
  /** Ollama model tag, e.g. "llama3.2:latest" (the Settings → Model choice). */
  model: string;
  messages: Message[];
  /** Allow chain-of-thought (slow but deeper). Defaults off — see NO_THINKING. */
  thinking?: boolean;
  tools?: Tool[];
  signal?: AbortSignal;
}): StreamResult {
  return stream({
    provider: providerFor(options.model),
    model: options.model,
    messages: options.messages,
    // Thinking on: omit the knob so the model uses its default reasoning depth.
    ...(options.thinking === true ? {} : { thinking: NO_THINKING }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    maxTokens: MAX_REPLY_TOKENS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

/** One completed tool call, as observed by a caller of `streamBlobTurn`. */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
}

/** What a Blob may change about itself via the configure tool. */
export interface BlobConfigPatch {
  title?: string;
  description?: string;
}

// Generous parse caps (trimmed, not rejected, below): hard limits belong in
// the prompt, never in the generation grammar — a grammar maxLength makes the
// model truncate mid-word instead of writing a shorter text.
const configArgs = z.object({
  title: z
    .string()
    .optional()
    .describe("Short role line shown under the Blob's name, e.g. 'Inbox assistant'"),
  description: z
    .string()
    .optional()
    .describe("What this Blob does for the user and how it should behave"),
});

/**
 * Tool identity reported for the forced-configure round. Configuration is
 * only ever written through that structured-output round (or the router's
 * change_job verdict feeding it) — never model-chosen; see runLoop.
 */
const CONFIGURE_TOOL_NAME = "configure_blob";

export { isAbortError } from "@kenkaiiii/gg-agent";
export type { PromptExtensions, UserContext } from "@/lib/prompt";
/**
 * Prompt assembly (system prompt, per-turn clock, history trim) lives in the
 * leaf `prompt.ts` so the app shell can build turns without loading the
 * provider stack. Re-exported here — plus `isAbortError`, so App.tsx's lazy
 * boundary is a single dynamic import of this module.
 */
export { blobSystemPrompt, timeNote, trimHistory } from "@/lib/prompt";

/**
 * How many tool round-trips one user message may trigger.
 *
 * Real research is iterative — search, read, search again, cross-check — and a
 * tight budget truncates the answer mid-sentence rather than producing a
 * shorter one (the "From your search, here" bug came from a budget of 3, which
 * a single search-fetch-answer already consumes). This is a ceiling to stop a
 * runaway loop, not a target: the model stops when it has what it needs, and a
 * turn that does hit the ceiling still gets a forced tool-free round to speak.
 */
const MAX_TOOL_ROUNDS = 25;

/**
 * Carry out a routed intent using the same memory tools the model would have
 * called, so both paths share one implementation (including dedupe and the
 * lenient memory lookup). Returns null when there was nothing to do.
 */
async function applyIntent(intent: Intent, memory: MemoryAccess): Promise<ToolCallRecord | null> {
  const tools = makeBlobTools(memory);
  const run = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallRecord | null> => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      return null;
    }
    const result = await tool.execute(args, {
      toolCallId: "intent-1",
      signal: new AbortController().signal,
    });
    return typeof result === "string" ? { name, args, result, isError: false } : null;
  };
  switch (intent.action) {
    case "save_fact":
      return run("remember", { text: intent.fact });
    case "delete_fact":
      return run("forget", { id: String(intent.memoryNumber) });
    default:
      // change_job is handled by the forced configure round, not here.
      return null;
  }
}

/** Append a completed tool call to the conversation so the model can confirm it. */
function withToolExchange(conversation: Message[], call: ToolCallRecord, id: string): Message[] {
  return [
    ...conversation,
    { role: "assistant", content: [{ type: "tool_call", id, name: call.name, args: call.args }] },
    { role: "tool", content: [{ type: "tool_result", toolCallId: id, content: call.result }] },
  ];
}

/**
 * Force an unconfigured Blob to write its own configuration.
 *
 * Free-form tool calling is unreliable here: small models skip or refuse the
 * tool, and Ollama's OpenAI endpoint ignores `tool_choice: "required"` when
 * streaming (verified against 0.32.9). Ollama's structured outputs
 * (grammar-constrained JSON via `format`) work even on sub-1B models, so this
 * round uses the native /api/chat non-streaming with a JSON schema.
 * Returns null when the model/server can't do it; chat continues without.
 */
async function forcedConfigureCall(
  model: string,
  messages: Message[],
): Promise<BlobConfigPatch | null> {
  // No maxLength here: a grammar length cap makes the model truncate
  // mid-word at the boundary. Length is steered by the prompt instead,
  // and oversized output is trimmed at whole-sentence level below.
  // additionalProperties is required by OpenAI strict structured outputs
  // (Tinfoil); Ollama ignores it.
  const configureSchema = {
    type: "object",
    required: ["title", "description"],
    properties: {
      title: { type: "string" },
      description: { type: "string" },
    },
    additionalProperties: false,
  };
  const configureMessages = [
    ...messages
      .filter((entry) => entry.role !== "system" && typeof entry.content === "string")
      .map((entry) => ({ role: entry.role, content: entry.content as string })),
    {
      role: "system",
      content:
        "The user just explained what they need you (their assistant Blob) to do. " +
        "Write your own configuration: a short `title` for the role (a few words), " +
        "and a `description` of what you will do for them and how you will behave " +
        "(2-4 complete sentences).",
    },
  ];
  try {
    let content: string;
    if (isTinfoilModel(model)) {
      const result = await tinfoilStructuredCall({
        model,
        messages: configureMessages,
        schema: configureSchema,
        schemaName: CONFIGURE_TOOL_NAME,
      });
      if (result === null) {
        return null;
      }
      content = result;
    } else {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          // Full conversation goes in; without a real window Ollama's 4096
          // default truncates it and the model configures from a torn prompt.
          options: { num_ctx: OLLAMA_NUM_CTX },
          messages: configureMessages,
          format: configureSchema,
        }),
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as { message?: { content?: string } };
      content = payload.message?.content ?? "{}";
    }
    const parsed = configArgs.safeParse(JSON.parse(content));
    if (!parsed.success) {
      return null;
    }
    return toConfigPatch(parsed.data);
  } catch {
    return null;
  }
}

/** Display caps; enforced by trimming cleanly, never by generation grammar. */
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 1200;

/** Cut at the last sentence end (or word) before `max`, never mid-word. */
function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, max);
  const sentenceEnd = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf(".\n"),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
  );
  if (sentenceEnd > max * 0.5) {
    return head.slice(0, sentenceEnd + 1);
  }
  const wordEnd = head.lastIndexOf(" ");
  return wordEnd > 0 ? head.slice(0, wordEnd) : head;
}

/** Normalize parsed tool/format args into a patch; null when empty. */
function toConfigPatch(args: {
  title?: string | undefined;
  description?: string | undefined;
}): BlobConfigPatch | null {
  const patch: BlobConfigPatch = {};
  const title = args.title?.trim();
  const description = args.description?.trim();
  if (title !== undefined && title !== "") {
    patch.title = clip(title, TITLE_MAX);
  }
  if (description !== undefined && description !== "") {
    patch.description = clip(description, DESCRIPTION_MAX);
  }
  return patch.title === undefined && patch.description === undefined ? null : patch;
}

/** Ceiling for a subagent: enough for search-fetch-answer, not for drift. */
const SUBAGENT_MAX_TURNS = 4;

/** Cap on the text a subagent hands back into the parent's context. */
const SUBAGENT_RESULT_LIMIT = 4_000;

/**
 * In-turn helper Blob: a nested `agentLoop` with its own short system prompt
 * and a read-only catalog (web pair + file reads). Never nests — the child
 * catalog contains no delegation, ask or write tools — and reports its result
 * as the tool result, so to the parent it is just one tool call.
 */
function makeSubagentTool(context: {
  model: string;
  blobName: string;
  thinking: boolean;
  readOnlyTools: AgentTool[];
  signal: AbortSignal | undefined;
  onProgress?: (line: string) => void;
}): AgentTool {
  const parameters = z.object({
    name: z.string().describe('Short helper name, e.g. "researcher"'),
    task: z.string().describe("The single task the helper must complete"),
    instructions: z
      .string()
      .optional()
      .describe("Optional extra guidance: sources to prefer, format of the result"),
  });
  const tool: AgentTool<typeof parameters> = {
    name: "run_subagent",
    description:
      "Delegate one self-contained research or reading task to a temporary " +
      "helper and get its findings back. The helper can browse the web and " +
      "read your files but cannot change anything or talk to the user. Use it " +
      "for legwork; do the final answer yourself.",
    parameters,
    executionMode: "sequential",
    execute: async (args, toolContext) => {
      const label = args.name.trim() === "" ? "helper" : args.name.trim().slice(0, 40);
      context.onProgress?.(`${label}: working on \u201c${args.task.slice(0, 80)}\u201d`);
      const system =
        `You are ${label}, a temporary helper working inside ${context.blobName}'s task. ` +
        "Complete the task below and reply with a concise result the caller can " +
        "use directly. You cannot talk to the user, spawn further helpers, or " +
        "change files or memories — research and report only." +
        (args.instructions === undefined || args.instructions.trim() === ""
          ? ""
          : `\n\nExtra instructions:\n${args.instructions.trim()}`);
      let text = "";
      let cutShort = false;
      try {
        const loop = agentLoop(
          [
            { role: "system", content: system },
            { role: "user", content: args.task },
          ],
          {
            provider: providerFor(context.model),
            model: context.model,
            ...(context.thinking ? {} : { thinking: NO_THINKING }),
            tools: context.readOnlyTools,
            maxTokens: MAX_REPLY_TOKENS,
            maxTurns: SUBAGENT_MAX_TURNS,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          },
        );
        for await (const event of loop) {
          if (event.type === "text_delta") {
            text += event.text;
          }
          if (event.type === "tool_call_start") {
            context.onProgress?.(`${label}: using ${event.name}`);
            text = "";
          }
          if (event.type === "max_turns") {
            cutShort = true;
          }
          if (event.type === "error") {
            break;
          }
          if (toolContext.signal.aborted) {
            break;
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        return `The helper failed: ${error instanceof Error ? error.message : "unknown error"}`;
      }
      const result = text.trim().slice(0, SUBAGENT_RESULT_LIMIT);
      if (result === "") {
        return "The helper returned nothing useful.";
      }
      return cutShort
        ? `${result}\n[The helper ran out of steps; this may be incomplete.]`
        : result;
    },
  };
  return tool;
}

/**
 * Does this text end on a thought the model actually finished? Used to decide
 * whether what it said before calling a tool is worth keeping on screen: a
 * closed sentence is, a trailing clause it broke off ("From your search,
 * here") is not — that one only reads right once the answer follows it, and
 * the answer arrives in the next round as a fresh sentence.
 */
function isCompleteThought(text: string): boolean {
  return /[.!?:;\u2026)\]"'`]$/.test(text.trim());
}

/**
 * One conversational turn for a Blob, run on gg-agent's `agentLoop`: it
 * validates tool args, executes configure_blob, and feeds results back until
 * the model settles on a text reply. Returns the full text of the reply.
 *
 * Models without tool support error before any text arrives; the turn
 * transparently retries once without tools so chat still works.
 */
export async function streamBlobTurn(options: {
  model: string;
  messages: Message[];
  thinking?: boolean;
  /**
   * Force the first round to call configure_blob. Small local models ignore
   * optional tools, so an unconfigured Blob must be pushed to set itself up.
   */
  forceConfigure?: boolean;
  /** Read/write access to the Blob's persistent memories. */
  memory: MemoryAccess;
  /**
   * "chat" (default) is the tuned interactive turn: intent router + web pair,
   * nothing else — its measured behavior must not drift. "routine" is an
   * autonomous turn fired by the scheduler: no router (routine turns never
   * write memories), and the catalog adds the Blob's files, ask_user,
   * run_subagent, the roster tools and any MCP server's tools, because there
   * is no human in the loop to fill gaps.
   */
  scope?: "chat" | "routine";
  /**
   * Classification the caller already made for this message, with its writes
   * already applied — skips this turn's router and its memory write.
   *
   * Exists for group chats: one user message classified once, then shared by
   * every responder. Per-responder routing would mean N calls deciding the
   * same sentence and N private copies of one fact.
   */
  intent?: Intent;
  /** The Blob's sandboxed home folder; enables file tools on routine turns. */
  home?: HomeBackend;
  /**
   * Roster access; enables spawn_blob/delete_blob on routine turns. The
   * calling Blob's own name gates self-deletion.
   */
  roster?: { access: RosterAccess; selfName: string };
  /**
   * Local MCP servers. Their tools join the routine catalog only — a
   * third-party server's tool descriptions are text we did not write, and the
   * chat path's restraint is measured with a fixed catalog.
   */
  mcpServers?: McpServerConfig[];
  /**
   * Token usage for one agent loop. Fired once per loop, so a turn that
   * retries or runs a rescue round reports more than once — the caller sums.
   */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /** Abort the turn (Stop button). Partial text is kept by the caller. */
  signal?: AbortSignal;
  /**
   * Mid-run user messages (follow-ups), consumed by the loop between tool
   * rounds and — via the follow-up hook — when it is about to stop.
   */
  getSteeringMessages?: () => Message[] | null;
  /**
   * The model asked the user something via ask_user: the turn ends after the
   * current round and the caller parks the run as waiting_input.
   */
  onAsk?: (ask: PendingAsk) => void;
  /** Safe flush point: assistant text + tool results for a turn are complete. */
  onCheckpoint?: () => void;
  /**
   * One completed speech segment — a banked preamble ("I'll look into that
   * now.") or the turn's final answer — delivered whole, never per delta, so
   * the caller can show each as its own bubble. The segments joined with
   * blank lines are exactly what the turn returns.
   */
  onSegment: (segment: string) => void;
  onConfigure: (patch: BlobConfigPatch) => void;
  /** Observes each completed tool call: drives the sim harness and, later, UI. */
  onToolCall?: (call: ToolCallRecord) => void;
}): Promise<string> {
  let conversation = options.messages;
  const scope = options.scope ?? "chat";

  // Reliability floor for weak models: classify the request with a grammar
  // (which a sub-1B model can satisfy) and act on it. This is the ONLY path
  // that writes memories or config — the chat loop never gets those tools
  // (see runLoop) — and it also decides whether the loop gets the web pair.
  // Routine turns skip it: there is no fresh user message to classify, the
  // instruction is the task, and autonomous turns must not write memories.
  //
  // A caller can also classify *for* this turn (`options.intent`). That is
  // what a group does: one message, one classification, shared by every
  // responder — otherwise each of them routes the same sentence and each
  // writes its own private copy of the same fact, which is how six Blobs end
  // up with six drifting versions of one thing the user said once.
  const intent: Intent =
    options.intent ??
    (scope === "routine"
      ? { action: "none", needsWeb: true }
      : await routeIntent({
          model: options.model,
          messages: conversation,
          memories: options.memory.list(),
        }));
  // A pre-classified turn has had its writes applied by the caller, once.
  if (options.intent === undefined && intent.action !== "none") {
    const applied = await applyIntent(intent, options.memory);
    if (applied !== null) {
      options.onToolCall?.(applied);
      conversation = withToolExchange(conversation, applied, "intent-1");
    }
  }

  // A job change is a reconfigure: run the same forced round that sets up a
  // new Blob, which is the only path measured reliable on a small model.
  //
  // Never from a pre-classified intent. "Be my writing coach instead" has one
  // subject in a 1-to-1 chat and none in a group, so rewriting whichever
  // member happened to answer would be a silent destructive guess — the same
  // reason `applyGroupIntent` drops the action rather than applying it.
  const forceConfigure =
    options.forceConfigure === true ||
    (options.intent === undefined && intent.action === "change_job");

  // simplification: forcing configure_blob on the first unconfigured turn
  // means a greeting like "hi" also triggers a (generic) self-config; the
  // model can refine it on later turns via the same tool.
  if (forceConfigure) {
    const patch = await forcedConfigureCall(options.model, conversation);
    if (patch !== null) {
      options.onConfigure(patch);
      // Report as a tool call: same effect, just forced rather than chosen.
      options.onToolCall?.({
        name: CONFIGURE_TOOL_NAME,
        args: patch as Record<string, unknown>,
        result: "Configuration saved.",
        isError: false,
      });
      // Feed the exchange back (as a tool round) so the streamed turn knows
      // it just configured itself and can confirm briefly instead of asking.
      conversation = [
        ...conversation,
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "configure-1",
              name: CONFIGURE_TOOL_NAME,
              args: patch as Record<string, unknown>,
            },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool_result", toolCallId: "configure-1", content: "Configuration saved." },
          ],
        },
      ];
    }
  }

  /** Set when the last loop stopped on its turn budget, mid-task. */
  let cutShort = false;

  // Contacted once per turn, and only on routine turns. An unreachable server
  // costs nothing: loadMcpTools drops it and the run keeps its other tools.
  const mcpTools =
    scope === "routine" && (options.mcpServers ?? []).length > 0
      ? await loadMcpTools(options.mcpServers ?? [], options.signal)
      : [];

  /**
   * Tools available this turn: the read-only web pair, or none at all
   * (fallback for a server that rejects tools outright).
   *
   * Everything that writes Blob state — memories and the Blob's own
   * configuration — is deliberately never offered to the free-running loop.
   * The deterministic router (same model, temperature 0, grammar-constrained)
   * is measurably better at deciding those: on "What day do I train?" it
   * routed to `none` 15/15, while the loop with memory tools in hand called
   * `remember` or `forget` in 33-50% of runs — one of which deleted the very
   * fact being asked about. A wrongly withheld write costs a retry through
   * the router; a wrongly executed `forget` is silent data loss.
   */
  /** Set when ask_user fired: the turn must end and wait for the user. */
  let pendingAsk: PendingAsk | null = null;

  /**
   * Text the model finished saying before each tool call ("Let me search for
   * that."). Each entry is emitted as its own bubble the moment it is banked,
   * and kept for the whole turn — including across the rescue round — so
   * nothing the user already read is pulled back off the screen and the
   * return always matches the bubbles on screen. Only whole segments land
   * here: a fragment cut off mid-sentence by the round budget is still
   * dropped.
   */
  const said: string[] = [];

  const runLoop = async (toolScope: "web" | "none"): Promise<{ text: string; latest: string }> => {
    let text = "";
    /** Everything shown for this turn: earlier segments plus the live one. */
    const full = () => [...said, text].filter((segment) => segment.trim() !== "").join("\n\n");
    const memoryTools = new Set(["remember", "update_memory", "forget"]);
    const webTools = makeBlobTools(options.memory).filter((tool) => !memoryTools.has(tool.name));
    // Routine turns run unattended, so they get the full autonomous catalog;
    // chat turns keep the tuned web-only pair (see the scope option docs).
    const fs = options.home === undefined ? null : makeFsTools(options.home);
    const tools =
      scope === "routine"
        ? [
            ...webTools,
            ...(fs === null ? [] : [...fs.readOnly, ...fs.mutating]),
            ...(options.roster === undefined
              ? []
              : makeRosterTools(options.roster.access, options.roster.selfName)),
            ...mcpTools,
            makeAskTool((ask) => {
              pendingAsk = ask;
            }),
            makeSubagentTool({
              model: options.model,
              blobName: "this Blob",
              thinking: options.thinking === true,
              readOnlyTools: [...webTools, ...(fs === null ? [] : fs.readOnly)],
              signal: options.signal,
            }),
          ]
        : webTools;
    const loop = agentLoop(conversation, {
      provider: providerFor(options.model),
      model: options.model,
      ...(options.thinking === true ? {} : { thinking: NO_THINKING }),
      ...(toolScope === "none" ? {} : { tools }),
      maxTokens: MAX_REPLY_TOKENS,
      maxTurns: MAX_TOOL_ROUNDS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.getSteeringMessages === undefined
        ? {}
        : {
            getSteeringMessages: options.getSteeringMessages,
            // Also drain follow-ups when the loop is about to stop: steering
            // alone is only polled after tool rounds, missing tool-less turns.
            getFollowUpMessages: options.getSteeringMessages,
          }),
    });
    const pending = new Map<string, { name: string; args: Record<string, unknown> }>();
    for await (const event of loop) {
      // No per-delta emission: a bubble appears only once its text is whole.
      if (event.type === "text_delta") {
        text += event.text;
      }
      if (event.type === "tool_call_start") {
        // Anything said before a tool call is preamble, not the answer. A
        // finished thought ("Let me search for that.") is banked as its own
        // bubble, whole, the moment the tool call starts; a sentence the
        // model abandoned mid-way to call a tool ("From your search, here")
        // is dropped, and an identical lead-in repeated every round is not
        // stacked.
        const segment = text.trim();
        if (isCompleteThought(segment) && said[said.length - 1] !== segment) {
          said.push(segment);
          options.onSegment(segment);
        }
        text = "";
        pending.set(event.toolCallId, { name: event.name, args: event.args });
      }
      if (event.type === "tool_call_end") {
        const started = pending.get(event.toolCallId);
        pending.delete(event.toolCallId);
        const record = {
          name: started?.name ?? "unknown",
          args: started?.args ?? {},
          result: event.result,
          isError: event.isError,
        };
        gathered.push(record);
        options.onToolCall?.(record);
      }
      if (event.type === "checkpoint") {
        options.onCheckpoint?.();
        // ask_user completed its round: stop generating and hand the turn to
        // the user. Breaking closes the loop generator cleanly.
        if (pendingAsk !== null) {
          break;
        }
      }
      if (event.type === "max_turns") {
        // The model wanted another tool call but ran out of budget, so whatever
        // it had said so far is a fragment ("From your search, here"). Never
        // cleared inside this helper: the rescue round must still see it.
        cutShort = true;
      }
      if (event.type === "agent_done") {
        // Reported per loop, and a turn can run the loop more than once (the
        // no-tools retry, the rescue round), so the caller accumulates.
        //
        // Undercounts on purpose: the three structured calls (router,
        // reconcile, forced-configure) are not part of this loop and are not
        // counted. They are small and fixed next to a tool-using turn, and
        // plumbing usage out of them would touch the tuned request bodies.
        options.onUsage?.({
          inputTokens: event.totalUsage.inputTokens,
          outputTokens: event.totalUsage.outputTokens,
        });
      }
      if (event.type === "error") {
        // Preserve any text already said: partial reply beats a retry from
        // zero. Mid-sentence is as finished as it will ever be — emit it.
        if (text.trim() !== "") {
          options.onSegment(text.trim());
          return { text: full(), latest: text };
        }
        throw event.error;
      }
    }
    // The loop settled: the live segment is complete, so it becomes a bubble.
    if (text.trim() !== "") {
      options.onSegment(text.trim());
    }
    return { text: full(), latest: text };
  };

  let result: { text: string; latest: string };
  // Kept so a turn that spent all its rounds on tools can still answer from
  // what those tools returned, instead of starting over empty-handed.
  const gathered: ToolCallRecord[] = [];
  try {
    // The router (grammar-constrained, temperature 0) decides whether this
    // turn may touch the web at all. Offered the tools unconditionally,
    // qwen3.5:2b googled the user's own facts in up to half of runs; with
    // the verdict gating the catalog, a turn that needs no tools has none
    // to misuse. needsWeb fails open to true, so a router failure only ever
    // restores the old always-offered behaviour.
    result = await runLoop(intent.needsWeb ? "web" : "none");
  } catch (error) {
    // simplification: any failure before text retries once without tools —
    // Ollama reports "does not support tools" as a plain 400.
    if (isAbortError(error)) {
      throw error;
    }
    result = await runLoop("none");
  }
  let text = result.text;

  // The model handed the turn to the user: the question IS the reply, and no
  // rescue round may run — it would answer on the user's behalf.
  if (pendingAsk !== null) {
    const ask: PendingAsk = pendingAsk;
    options.onAsk?.(ask);
    // The model often says the question as text right before calling the
    // tool; that bubble is already up, so ask again only if it is new.
    if (said[said.length - 1] !== ask.question) {
      options.onSegment(ask.question);
    }
    return ask.question;
  }

  // Two ways a turn ends without a usable answer: the model spends every round
  // on tools and never speaks (surfaced as "(no response from the model)"), or
  // it starts speaking, calls another tool, and hits the budget mid-sentence
  // ("From your search, here"). Both are fixed the same way: hand back what the
  // tools found and ask again with no tools, so the only move left is to reply.
  // Judged on the newest segment only: banked preamble is not an answer, so a
  // turn that spoke only before its tool calls still earns a rescue round.
  const needsAnswer = result.latest.trim() === "" || cutShort;
  if (needsAnswer && gathered.length > 0) {
    // Budgeted: a fetch result is up to 3k chars, and several of them replayed
    // whole would push the earlier conversation out of a small context window
    // — losing the very question this round exists to answer.
    const perResult = Math.max(400, Math.floor(4_000 / gathered.length));
    conversation = [
      ...conversation,
      {
        role: "user",
        content:
          "Results from the tools you just used:\n" +
          gathered.map((call) => `${call.name}: ${call.result.slice(0, perResult)}`).join("\n\n") +
          "\n\nAnswer my message now, in your own words. Do not use any more tools.",
      },
    ];
  }
  if (needsAnswer) {
    try {
      // Cleared first: this round has no tools, so it cannot hit the budget,
      // and a stale flag would make every later turn pay for a rescue round.
      cutShort = false;
      // Banked bubbles stay: the user already read them, and the rescue
      // answer follows them as its own bubble instead of trailing them in
      // one paragraph.
      const finished = await runLoop("none");
      // Keep the fragment only if the retry somehow produced nothing at all.
      text = finished.latest.trim() === "" ? text : finished.text;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
    }
  }
  // Whitespace-only is empty as far as the user is concerned; returning it
  // verbatim showed up as a blank bubble, or as "(no response from the
  // model)" because the caller only checks for the empty string.
  return text.trim() === "" ? "" : text;
}
