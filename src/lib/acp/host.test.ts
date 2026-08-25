/**
 * The ACP host, exercised over a real in-process protocol connection.
 *
 * `client().connect(agentApp)` runs the SDK's own client and server halves
 * against each other, so these tests go through actual JSON-RPC dispatch and
 * schema parsing rather than calling handlers directly — the mistakes worth
 * catching here (a malformed update, a prompt that never settles, a stop
 * reason the client rejects) only show up on the wire.
 *
 * The app side is faked at the seam the host actually uses: the deps object
 * and the conversation bus.
 */

import {
  client as acpClient,
  type NewSessionRequest,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, Message } from "@/data/agents";
import { type AcpHostDeps, createAcpAgent } from "@/lib/acp/host";
import { publishConversation } from "@/lib/conversation-bus";
import type { Group } from "@/lib/groups";

const researcher: Agent = {
  id: "blob-a",
  name: "Researcher",
  time: "Now",
  snippet: "",
  tone: "blue",
  shape: "sphere",
};
const writer: Agent = { ...researcher, id: "blob-b", name: "Writer" };
const studio: Group = { id: "g1", name: "Studio" };

interface Harness {
  deps: AcpHostDeps;
  sent: { to: string; text: string }[];
  stopped: string[];
  transcript: Message[];
}

function harness(): Harness {
  const sent: { to: string; text: string }[] = [];
  const stopped: string[] = [];
  const transcript: Message[] = [];
  return {
    sent,
    stopped,
    transcript,
    deps: {
      roster: () => [researcher, writer],
      groups: () => [studio],
      transcript: () => transcript,
      sendToBlob: (blob, text) => {
        sent.push({ to: blob.id, text });
      },
      sendToGroup: (group, text) => {
        sent.push({ to: `group:${group.id}`, text });
      },
      stop: (conversationId) => {
        stopped.push(conversationId);
      },
      defaultBlob: () => researcher,
    },
  };
}

/** Connect a client to a host and collect every session update it receives. */
function connect(deps: AcpHostDeps) {
  const updates: SessionUpdate[] = [];
  const permissions: { question: string; answer: string }[] = [];
  let answer = "yes";
  const app = acpClient()
    .onNotification("session/update", ({ params }) => {
      updates.push(params.update);
    })
    .onRequest("session/request_permission", ({ params }) => {
      permissions.push({ question: params.toolCall.title ?? "", answer });
      return { outcome: { outcome: "selected" as const, optionId: answer } };
    });
  const connection = app.connect(createAcpAgent(deps));
  return {
    updates,
    permissions,
    agent: connection.agent,
    close: () => connection.close(),
    answerWith: (option: string) => {
      answer = option;
    },
  };
}

const NEW_SESSION = { cwd: "/tmp/project", mcpServers: [] };

/** Open a session bound to the default Blob, and return its id. */
async function openSession(session: ReturnType<typeof connect>): Promise<string> {
  const { sessionId } = await session.agent.request<NewSessionResponse, NewSessionRequest>(
    "session/new",
    NEW_SESSION,
  );
  return sessionId;
}
/** Let queued microtasks (subscription, notification delivery) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  close = undefined;
});

describe("initialize", () => {
  it("advertises session loading and answers in the client's version", async () => {
    const { deps } = harness();
    const session = connect(deps);
    close = session.close;
    const response = await session.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(response.agentCapabilities?.loadSession).toBe(true);
    expect(response.agentInfo?.name).toBe("Blobbies");
  });

  it("never answers above the version the client asked for", async () => {
    const { deps } = harness();
    const session = connect(deps);
    close = session.close;
    const response = await session.agent.request("initialize", {
      protocolVersion: 0,
      clientCapabilities: {},
    });
    expect(response.protocolVersion).toBe(0);
  });
});

describe("session/new", () => {
  it("binds to the last-used Blob and offers the roster commands", async () => {
    const { deps } = harness();
    const session = connect(deps);
    close = session.close;
    const sessionId = await openSession(session);
    expect(sessionId).toBe("blob-a");
    await settle();
    expect(session.updates).toContainEqual({
      sessionUpdate: "available_commands_update",
      availableCommands: expect.arrayContaining([expect.objectContaining({ name: "blob" })]),
    });
  });

  it("honours a target the client names", async () => {
    const { deps } = harness();
    const session = connect(deps);
    close = session.close;
    const { sessionId } = await session.agent.request("session/new", {
      ...NEW_SESSION,
      _meta: { "blobbies/target": "group:g1" },
    });
    expect(sessionId).toBe("group:g1");
  });

  it("refuses when there are no Blobs, rather than inventing one", async () => {
    const { deps } = harness();
    const session = connect({ ...deps, roster: () => [], defaultBlob: () => undefined });
    close = session.close;
    await expect(session.agent.request("session/new", NEW_SESSION)).rejects.toThrow(/No Blobs/);
  });
});

describe("session/load", () => {
  it("replays the stored transcript", async () => {
    const { deps, transcript } = harness();
    transcript.push(
      { id: "m1", kind: "text", author: "user", segments: [{ text: "hi" }] },
      { id: "m2", kind: "text", author: "agent", segments: [{ text: "hello" }] },
    );
    const session = connect(deps);
    close = session.close;
    await session.agent.request("session/load", { ...NEW_SESSION, sessionId: "blob-a" });
    await settle();
    expect(session.updates.slice(0, 2)).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    ]);
  });

  it("reports a deleted Blob instead of loading nothing", async () => {
    const { deps } = harness();
    const session = connect(deps);
    close = session.close;
    await expect(
      session.agent.request("session/load", { ...NEW_SESSION, sessionId: "blob-gone" }),
    ).rejects.toThrow(/no longer exists/);
  });
});

describe("session/prompt", () => {
  it("sends to the bound Blob and streams its reply until the exchange ends", async () => {
    const { deps, sent } = harness();
    const session = connect(deps);
    close = session.close;
    const sessionId = await openSession(session);

    const prompt = session.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "what is the plan?" }],
    });
    await settle();
    expect(sent).toEqual([{ to: "blob-a", text: "what is the plan?" }]);

    publishConversation("blob-a", { type: "segment", blobId: "blob-a", text: "Looking now." });
    publishConversation("blob-a", { type: "exchange_end", outcome: "done" });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(session.updates).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Looking now." },
    });
  });

  it("labels each speaker in a group, since v1 has one agent voice", async () => {
    const { deps, sent } = harness();
    const session = connect(deps);
    close = session.close;
    const { sessionId } = await session.agent.request("session/new", {
      ...NEW_SESSION,
      _meta: { "blobbies/target": "group:g1" },
    });
    const prompt = session.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "status?" }],
    });
    await settle();
    expect(sent).toEqual([{ to: "group:g1", text: "status?" }]);

    publishConversation("group:g1", { type: "segment", blobId: "blob-b", text: "Drafting." });
    publishConversation("group:g1", { type: "exchange_end", outcome: "done" });
    await prompt;
    expect(session.updates).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "**Writer:** Drafting." },
    });
  });

  it("reports a settled tool call with its result", async () => {
    const { deps } = harness();
    const session = connect(deps);
    close = session.close;
    const sessionId = await openSession(session);
    const prompt = session.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "read it" }],
    });
    await settle();
    publishConversation("blob-a", {
      type: "tool_call",
      blobId: "blob-a",
      name: "read_file",
      args: '{"path":"notes.md"}',
      result: "ok",
    });
    publishConversation("blob-a", { type: "exchange_end", outcome: "done" });
    await prompt;
    const call = session.updates.find((update) => update.sessionUpdate === "tool_call");
    expect(call).toMatchObject({ title: "read_file", kind: "read", status: "completed" });
  });

  it("stays open across a Blob's question until the answer's turn settles", async () => {
    const { deps, sent } = harness();
    const session = connect(deps);
    close = session.close;
    const sessionId = await openSession(session);
    const prompt = session.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "book it" }],
    });
    await settle();

    publishConversation("blob-a", {
      type: "ask",
      blobId: "blob-a",
      question: "Shall I book the 9am?",
      kind: "question",
    });
    // The run parks and the exchange reports done — but the editor's prompt is
    // not answered yet, so this must not resolve it.
    publishConversation("blob-a", { type: "exchange_end", outcome: "done" });
    await settle();
    expect(session.permissions).toEqual([{ question: "Shall I book the 9am?", answer: "yes" }]);
    expect(sent[1]).toEqual({ to: "blob-a", text: "Yes" });

    publishConversation("blob-a", { type: "exchange_end", outcome: "done" });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("reports a failed exchange as a refusal", async () => {
    const { deps } = harness();
    const session = connect(deps);
    close = session.close;
    const sessionId = await openSession(session);
    const prompt = session.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    await settle();
    publishConversation("blob-a", { type: "exchange_end", outcome: "failed" });
    await expect(prompt).resolves.toEqual({ stopReason: "refusal" });
  });

  it("ignores events from other conversations", async () => {
    const { deps } = harness();
    const session = connect(deps);
    close = session.close;
    const sessionId = await openSession(session);
    const prompt = session.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    await settle();
    publishConversation("blob-b", { type: "segment", blobId: "blob-b", text: "not yours" });
    publishConversation("blob-b", { type: "exchange_end", outcome: "done" });
    await settle();
    expect(session.updates).not.toContainEqual(
      expect.objectContaining({ content: { type: "text", text: "not yours" } }),
    );
    publishConversation("blob-a", { type: "exchange_end", outcome: "done" });
    await prompt;
  });
});

describe("slash commands", () => {
  it("lists Blobs and groups without running a turn", async () => {
    const { deps, sent } = harness();
    const session = connect(deps);
    close = session.close;
    const sessionId = await openSession(session);
    await session.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/blobs" }],
    });
    await settle();
    expect(session.updates).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "- Researcher\n- Writer" },
    });
    expect(sent).toEqual([]);
  });

  it("repoints the session at another Blob", async () => {
    const { deps, sent } = harness();
    const session = connect(deps);
    close = session.close;
    const sessionId = await openSession(session);
    await session.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/blob Writer" }],
    });
    const prompt = session.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    await settle();
    expect(sent).toEqual([{ to: "blob-b", text: "hello" }]);
    publishConversation("blob-b", { type: "exchange_end", outcome: "done" });
    await prompt;
  });

  it("says so when the name does not exist", async () => {
    const { deps } = harness();
    const session = connect(deps);
    close = session.close;
    const sessionId = await openSession(session);
    await session.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/blob Nobody" }],
    });
    await settle();
    expect(session.updates).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: 'No Blob called "Nobody".' },
    });
  });
});

describe("session/cancel", () => {
  it("stops the conversation and answers the prompt as cancelled", async () => {
    const { deps, stopped } = harness();
    const session = connect(deps);
    close = session.close;
    const sessionId = await openSession(session);
    const prompt = session.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "long job" }],
    });
    await settle();
    await session.agent.notify("session/cancel", { sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(stopped).toEqual(["blob-a"]);
  });
});

describe("a client that misbehaves", () => {
  it("does not run a turn for an empty prompt", async () => {
    const { deps, sent } = harness();
    const session = connect(deps);
    close = session.close;
    const sessionId = await openSession(session);
    await expect(
      session.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "  " }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(sent).toEqual([]);
  });

  it("rejects a prompt for a session it never opened", async () => {
    const { deps } = harness();
    const session = connect(deps);
    close = session.close;
    await expect(
      session.agent.request("session/prompt", {
        sessionId: "blob-nope",
        prompt: [{ type: "text", text: "hi" }],
      }),
    ).rejects.toThrow(/no longer exists/);
  });
});

describe("teardown", () => {
  it("leaves nothing subscribed once a prompt settles", async () => {
    const { deps } = harness();
    const listener = vi.fn();
    const session = connect(deps);
    close = session.close;
    const sessionId = await openSession(session);
    const prompt = session.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    await settle();
    publishConversation("blob-a", { type: "exchange_end", outcome: "done" });
    await prompt;
    // A late event from the app must not reach a finished prompt.
    publishConversation("blob-a", { type: "segment", blobId: "blob-a", text: "late" });
    await settle();
    expect(listener).not.toHaveBeenCalled();
    expect(session.updates).not.toContainEqual(
      expect.objectContaining({ content: { type: "text", text: "late" } }),
    );
  });
});
