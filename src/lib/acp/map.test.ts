import { describe, expect, it } from "vitest";
import type { Agent, Message } from "@/data/agents";
import {
  conversationIdFor,
  findBlob,
  findGroup,
  parseCommand,
  promptText,
  targetForSession,
  toolKind,
  transcriptUpdates,
} from "@/lib/acp/map";
import type { Group } from "@/lib/groups";

const blob = (id: string, name: string): Agent => ({
  id,
  name,
  time: "Now",
  snippet: "",
  tone: "blue",
  shape: "sphere",
});

const researcher = blob("a", "Researcher");
const writer = blob("b", "Writer");
const roster = [researcher, writer];
const studio: Group = { id: "g1", name: "Studio" };
const groups = [studio];

const said = (author: "user" | "agent", text: string, authorId?: string): Message => ({
  id: crypto.randomUUID(),
  kind: "text",
  author,
  segments: [{ text }],
  timestampMs: 0,
  ...(authorId === undefined ? {} : { authorId }),
});

describe("session ids", () => {
  it("uses the Blob id for a 1:1 session", () => {
    expect(conversationIdFor({ kind: "blob", blob: researcher })).toBe("a");
  });

  it("namespaces a group session", () => {
    expect(conversationIdFor({ kind: "group", group: studio })).toBe("group:g1");
  });

  it("round-trips a Blob session", () => {
    expect(targetForSession("a", roster, groups)).toEqual({ kind: "blob", blob: researcher });
  });

  it("round-trips a group session", () => {
    expect(targetForSession("group:g1", roster, groups)).toEqual({
      kind: "group",
      group: studio,
    });
  });

  it("returns null for a Blob deleted since the editor last connected", () => {
    expect(targetForSession("gone", roster, groups)).toBeNull();
    expect(targetForSession("group:gone", roster, groups)).toBeNull();
  });
});

describe("lookup by name", () => {
  it("ignores case and surrounding space", () => {
    expect(findBlob(roster, "  researcher ")).toBe(researcher);
    expect(findGroup(groups, "STUDIO")).toBe(studio);
  });

  it("does not guess at a name it does not have", () => {
    expect(findBlob(roster, "Research")).toBeUndefined();
  });
});

describe("parseCommand", () => {
  it("splits a command from its argument", () => {
    expect(parseCommand("/blob Researcher")).toEqual({ name: "blob", argument: "Researcher" });
  });

  it("reads a bare command", () => {
    expect(parseCommand("/blobs")).toEqual({ name: "blobs", argument: "" });
  });

  it("leaves an ordinary message alone", () => {
    expect(parseCommand("what does /usr/bin hold?")).toBeNull();
    expect(parseCommand("hello")).toBeNull();
  });
});

describe("toolKind", () => {
  it("maps the tools ACP has a word for", () => {
    expect(toolKind("read_file")).toBe("read");
    expect(toolKind("write_file")).toBe("edit");
    expect(toolKind("run_command")).toBe("execute");
    expect(toolKind("web_fetch")).toBe("fetch");
    expect(toolKind("web_search")).toBe("search");
  });

  it("calls anything else other rather than guessing", () => {
    expect(toolKind("remember")).toBe("other");
    expect(toolKind("mcp__linear__create_issue")).toBe("other");
  });
});

describe("promptText", () => {
  it("joins text blocks", () => {
    expect(
      promptText([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\n\ntwo");
  });

  it("inlines embedded context the editor sent", () => {
    expect(
      promptText([
        {
          type: "resource",
          resource: { uri: "file:///a.ts", mimeType: "text/plain", text: "code" },
        },
      ]),
    ).toBe("code");
  });

  it("names a block it cannot render as words", () => {
    expect(promptText([{ type: "image", data: "x", mimeType: "image/png" }])).toBe("[image]");
  });
});

describe("transcriptUpdates", () => {
  it("replays who said what", () => {
    expect(transcriptUpdates([said("user", "hi"), said("agent", "hello")])).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    ]);
  });

  it("labels group speakers, since v1 renders one agent", () => {
    const updates = transcriptUpdates([said("agent", "on it", "a")], {
      nameOf: (id) => (id === "a" ? "Researcher" : undefined),
    });
    expect(updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "**Researcher:** on it" },
      },
    ]);
  });

  it("skips events and empty bubbles", () => {
    const messages: Message[] = [
      { id: "e", kind: "event", text: "Routine: nightly", timestampMs: 0 },
      said("agent", "   "),
    ];
    expect(transcriptUpdates(messages)).toEqual([]);
  });
});
