/**
 * The ACP agent, running inside the app.
 *
 * Blobbies is the agent an editor talks to: the same Blobs, the same memories
 * and homes, the same one-at-a-time turn queue, the same transcripts on disk.
 * So this speaks the protocol *over* the app's existing send paths instead of
 * re-implementing a turn — `App.tsx` still owns orchestration, and everything
 * here is translation plus the bookkeeping one prompt needs.
 *
 * Protocol version 1 (what shipping editors negotiate), with two honest
 * limitations that fall out of the wire format:
 *
 * - A group reply is several Blobs speaking, and v1 has one agent voice, so
 *   each line is prefixed with its speaker's name.
 * - Turns are serialized app-wide against one local model. A second prompt
 *   waits its turn rather than failing.
 */

import type {
  PermissionOption,
  PromptResponse,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  type AgentApp,
  type AgentContext,
  agent as acpAgent,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { Agent, Message } from "@/data/agents";
import {
  ACP_COMMANDS,
  type AcpTarget,
  conversationIdFor,
  findBlob,
  findGroup,
  parseCommand,
  promptText,
  speakerPrefix,
  targetForSession,
  toolKind,
  transcriptUpdates,
} from "@/lib/acp/map";
import { type ConversationEvent, subscribeConversation } from "@/lib/conversation-bus";
import type { Group } from "@/lib/groups";

/** Everything the host borrows from the running app. */
export interface AcpHostDeps {
  /** Blobs, newest state each call — the roster changes under a live session. */
  roster: () => readonly Agent[];
  groups: () => readonly Group[];
  /** Stored transcript for a conversation, for `session/load`. */
  transcript: (conversationId: string) => readonly Message[];
  /** Send to one Blob's own chat. */
  sendToBlob: (blob: Agent, text: string) => void;
  /** Send to a group, which routes and may hand off between members. */
  sendToGroup: (group: Group, text: string) => void;
  /** Cancel whatever is running in a conversation. */
  stop: (conversationId: string) => void;
  /** Which Blob a session with no stated target should bind to. */
  defaultBlob: () => Agent | undefined;
}

/** How the agent identifies itself to the editor. */
const AGENT_INFO = { name: "Blobbies", version: "1" } as const;

/** The permission choices offered for a Blob's mid-turn question. */
const ASK_OPTIONS: PermissionOption[] = [
  { optionId: "yes", name: "Yes", kind: "allow_once" },
  { optionId: "no", name: "No", kind: "reject_once" },
];

/** A named list, or an honest note that there are none yet. */
function listOf(kind: string, names: readonly string[]): string {
  return names.length === 0
    ? `No ${kind} yet — make one in the Blobbies app.`
    : names.map((name) => `- ${name}`).join("\n");
}

/**
 * Bookkeeping for one prompt in flight.
 *
 * A prompt is answered when the conversation's *exchange* settles, which for a
 * group is every responder and hand-off, not the first reply. A Blob's mid-turn
 * question complicates that: the run parks on `waiting_input` and the exchange
 * reports done, but the editor's prompt is not answered until the user has
 * replied through `session/request_permission` and that answer's own turn
 * settles. `pendingAnswers` keeps the prompt open across that gap.
 */
interface Turn {
  settle: (reason: StopReason) => void;
  pendingAnswers: number;
  cancelled: boolean;
}

export function createAcpAgent(deps: AcpHostDeps): AgentApp {
  /**
   * What each session is bound to. The id starts as the conversation id, so a
   * session id is meaningful across restarts, but `/blob` can repoint a live
   * session — the id then stays as the client's stable handle.
   */
  const bindings = new Map<string, AcpTarget>();
  const turns = new Map<string, Turn>();

  const bind = (sessionId: string): AcpTarget | undefined => {
    const bound = bindings.get(sessionId);
    if (bound !== undefined) {
      return bound;
    }
    const resolved = targetForSession(sessionId, deps.roster(), deps.groups());
    if (resolved !== null) {
      bindings.set(sessionId, resolved);
      return resolved;
    }
    return undefined;
  };

  const nameOf = (blobId: string): string | undefined =>
    deps.roster().find((candidate) => candidate.id === blobId)?.name;

  const send = (sessionId: string, client: AgentContext, update: SessionUpdate): void => {
    void client.notify("session/update", { sessionId, update });
  };

  /** Offer the roster commands — how a v1 client reaches Blobs by name. */
  const announceCommands = (sessionId: string, client: AgentContext): void => {
    send(sessionId, client, {
      sessionUpdate: "available_commands_update",
      availableCommands: ACP_COMMANDS,
    });
  };

  /** Say something as the agent without involving a Blob (command output). */
  const reply = (sessionId: string, client: AgentContext, body: string): PromptResponse => {
    send(sessionId, client, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: body },
    });
    return { stopReason: "end_turn" };
  };

  /**
   * Turn one conversation event into what the editor should see.
   *
   * Group replies carry their speaker's name because v1 renders every agent
   * chunk as the same voice; in a 1:1 chat the Blob is the whole session, so
   * the prefix would only be noise.
   */
  const toUpdate = (event: ConversationEvent, target: AcpTarget): SessionUpdate | undefined => {
    switch (event.type) {
      case "segment": {
        const speaker = target.kind === "group" ? nameOf(event.blobId) : undefined;
        return {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: speaker === undefined ? event.text : `${speakerPrefix(speaker)}${event.text}`,
          },
        };
      }
      case "tool_call":
        // Blobs report calls that have already run, so a call and its result
        // arrive together — one settled `tool_call`, never a pending one that
        // would sit unresolved in the editor's UI if a turn were interrupted.
        return {
          sessionUpdate: "tool_call",
          toolCallId: `${event.blobId}-${event.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: event.name,
          kind: toolKind(event.name),
          status: event.failed === true ? "failed" : "completed",
          ...(event.args === undefined ? {} : { rawInput: event.args }),
          ...(event.result === undefined
            ? {}
            : { content: [{ type: "content", content: { type: "text", text: event.result } }] }),
        };
      case "activity":
        // The app's own status word, not invented reasoning: it is the only
        // signal of life during a long turn, and a thought chunk is where an
        // editor shows that.
        return {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: event.activity },
        };
      default:
        return undefined;
    }
  };

  /** Ask the editor's user a Blob's mid-turn question, then answer the Blob. */
  const relayAsk = async (
    sessionId: string,
    client: AgentContext,
    target: AcpTarget,
    turn: Turn,
    question: string,
  ): Promise<void> => {
    turn.pendingAnswers += 1;
    try {
      const response = await client.request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: `ask-${Date.now()}`, title: question, kind: "think" },
        options: ASK_OPTIONS,
      });
      if (turn.cancelled) {
        return;
      }
      if (response.outcome.outcome !== "selected") {
        turn.settle("cancelled");
        return;
      }
      const answer = response.outcome.optionId === "yes" ? "Yes" : "No";
      // The answer is an ordinary user message: the app sees the run parked on
      // `waiting_input` and resumes it, exactly as the composer would.
      if (target.kind === "blob") {
        deps.sendToBlob(target.blob, answer);
      } else {
        deps.sendToGroup(target.group, answer);
      }
    } catch {
      // The client refused or vanished; the turn below settles on its own.
    } finally {
      turn.pendingAnswers -= 1;
    }
  };

  const runPrompt = async (
    sessionId: string,
    client: AgentContext,
    target: AcpTarget,
    body: string,
    signal: AbortSignal,
  ): Promise<PromptResponse> => {
    const conversationId = conversationIdFor(target);
    let settle: (reason: StopReason) => void = () => undefined;
    const settled = new Promise<StopReason>((resolve) => {
      let done = false;
      settle = (reason) => {
        if (!done) {
          done = true;
          resolve(reason);
        }
      };
    });
    const turn: Turn = { settle, pendingAnswers: 0, cancelled: false };
    turns.set(sessionId, turn);

    const unsubscribe = subscribeConversation(conversationId, (event) => {
      if (event.type === "ask") {
        void relayAsk(sessionId, client, target, turn, event.question);
        return;
      }
      if (event.type === "exchange_end") {
        // A question left the run parked: the prompt is not answered until the
        // user's reply has run its own turn.
        if (turn.pendingAnswers > 0) {
          return;
        }
        settle(
          event.outcome === "cancelled"
            ? "cancelled"
            : event.outcome === "failed"
              ? "refusal"
              : "end_turn",
        );
        return;
      }
      const update = toUpdate(event, target);
      if (update !== undefined) {
        send(sessionId, client, update);
      }
    });

    const onAbort = () => {
      turn.cancelled = true;
      deps.stop(conversationId);
      settle("cancelled");
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (target.kind === "blob") {
        deps.sendToBlob(target.blob, body);
      } else {
        deps.sendToGroup(target.group, body);
      }
      return { stopReason: await settled };
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      turns.delete(sessionId);
    }
  };

  return acpAgent()
    .onRequest("initialize", ({ params }) => ({
      // Answer in the client's version when it is one we speak, so an older
      // editor is not told to disconnect over a version it never asked for.
      protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
      agentInfo: AGENT_INFO,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
      },
    }))
    .onRequest("session/new", ({ params, client }) => {
      // `cwd` is deliberately ignored: an ACP session gets no capabilities the
      // app's own chat does not have, so Blobs stay inside their own homes and
      // the editor's project directory is not handed to them.
      // A client that knows which Blob it wants says so; otherwise the
      // session opens on whatever the user was last talking to, which is the
      // only default that needs no protocol extension to be useful.
      const requested = params._meta?.["blobbies/target"];
      const fallback = deps.defaultBlob();
      const target =
        (typeof requested === "string"
          ? targetForSession(requested, deps.roster(), deps.groups())
          : null) ??
        (fallback === undefined ? null : ({ kind: "blob", blob: fallback } satisfies AcpTarget));
      if (target === null) {
        throw RequestError.invalidRequest(
          undefined,
          "No Blobs yet — make one in the Blobbies app first.",
        );
      }
      const sessionId = conversationIdFor(target);
      bindings.set(sessionId, target);
      announceCommands(sessionId, client);
      return { sessionId };
    })
    .onRequest("session/load", ({ params, client }) => {
      const target = bind(params.sessionId);
      if (target === undefined) {
        throw RequestError.resourceNotFound("That Blob or group no longer exists.");
      }
      for (const update of transcriptUpdates(deps.transcript(conversationIdFor(target)), {
        nameOf,
      })) {
        send(params.sessionId, client, update);
      }
      announceCommands(params.sessionId, client);
      return {};
    })
    .onRequest("session/prompt", async ({ params, client, signal }) => {
      const target = bind(params.sessionId);
      if (target === undefined) {
        throw RequestError.resourceNotFound("That Blob or group no longer exists.");
      }
      const body = promptText(params.prompt);
      const command = parseCommand(body);
      if (command !== null) {
        switch (command.name) {
          case "blobs":
            return reply(
              params.sessionId,
              client,
              listOf(
                "Blobs",
                deps.roster().map((blob) => blob.name),
              ),
            );
          case "groups":
            return reply(
              params.sessionId,
              client,
              listOf(
                "groups",
                deps.groups().map((group) => group.name),
              ),
            );
          case "blob": {
            const found = findBlob(deps.roster(), command.argument);
            if (found === undefined) {
              return reply(params.sessionId, client, `No Blob called "${command.argument}".`);
            }
            bindings.set(params.sessionId, { kind: "blob", blob: found });
            return reply(params.sessionId, client, `Now talking to ${found.name}.`);
          }
          case "group": {
            const found = findGroup(deps.groups(), command.argument);
            if (found === undefined) {
              return reply(params.sessionId, client, `No group called "${command.argument}".`);
            }
            bindings.set(params.sessionId, { kind: "group", group: found });
            return reply(params.sessionId, client, `Now talking to ${found.name}.`);
          }
          default:
            return reply(params.sessionId, client, `Unknown command: /${command.name}`);
        }
      }
      if (body.trim() === "") {
        return { stopReason: "end_turn" };
      }
      return runPrompt(params.sessionId, client, target, body, signal);
    })
    .onNotification("session/cancel", ({ params }) => {
      const target = bind(params.sessionId);
      if (target !== undefined) {
        deps.stop(conversationIdFor(target));
      }
      const turn = turns.get(params.sessionId);
      if (turn !== undefined) {
        turn.cancelled = true;
        turn.settle("cancelled");
      }
    })
    .onRequest("authenticate", () => ({}));
}
