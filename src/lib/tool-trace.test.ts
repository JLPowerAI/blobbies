import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it } from "vitest";
import { dropOrphanToolResults, toolTraceMessages, trimToolTrace } from "@/lib/tool-trace";

/** The `tool_call` parts of an assistant message, for readable assertions. */
function callsIn(message: Message | undefined) {
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part.type === "tool_call")
    : [];
}

/** The results of a `role: "tool"` message, for readable assertions. */
function resultsIn(message: Message | undefined) {
  return message?.role === "tool" ? message.content : [];
}

describe("replaying what a turn already did", () => {
  it("is nothing at all when no tool ran", () => {
    // A stray empty assistant message on every text-only reply would be prefix
    // the model reads past on every later turn, forever.
    expect(toolTraceMessages([], "m1")).toEqual([]);
  });

  it("replays a call as the tool_call and tool_result it was", () => {
    // Native shape rather than a prose summary: a failed call then reads to
    // the model as a failed call, not as the Blob's paraphrase of one.
    const [assistant, results] = toolTraceMessages(
      [
        {
          name: "YOUTUBE_SEARCH_YOU_TUBE",
          args: '{"query":"new AI videos"}',
          result: "Invalid argument: unknown field 'query'. Did you mean 'q'?",
          failed: true,
        },
      ],
      "m1",
    );
    expect(assistant?.role).toBe("assistant");
    const [call] = callsIn(assistant);
    expect(call?.name).toBe("YOUTUBE_SEARCH_YOU_TUBE");
    // The exact argument name survives — the wrong-field case is the point.
    expect(call?.args).toEqual({ query: "new AI videos" });

    expect(results?.role).toBe("tool");
    const [result] = resultsIn(results);
    expect(result?.toolCallId).toBe(call?.id);
    expect(result?.isError).toBe(true);
    expect(String(result?.content)).toContain("Did you mean 'q'?");
  });

  it("does not mark a call that worked as an error", () => {
    const [, results] = toolTraceMessages(
      [{ name: "read_file", args: '{"path":"notes/trip.md"}', result: "Tokyo, 12-19 March." }],
      "m1",
    );
    const [result] = resultsIn(results);
    expect(result?.isError).toBeUndefined();
    expect(String(result?.content)).toContain("Tokyo");
  });

  it("says so when it clips a huge result", () => {
    // A silent ellipsis reads as the end of the value, so a model seeing a
    // clipped error could conclude the tool said less than it did.
    const [, results] = toolTraceMessages(
      [{ name: "web_search", result: "x".repeat(5_000) }],
      "m1",
    );
    const [result] = resultsIn(results);
    expect(String(result?.content)).toContain("[truncated]");
    expect(String(result?.content).length).toBeLessThan(300);
  });

  it("keeps the most recent calls when there were many", () => {
    // The tail is what the model is deciding from: the call that just failed
    // matters more than the listing it did first.
    const many = Array.from({ length: 12 }, (_, index) => ({
      name: `tool_${index}`,
      result: "ok",
    }));
    const names = callsIn(toolTraceMessages(many, "m1")[0]).map((call) => call.name);
    expect(names).toContain("tool_11");
    expect(names).toContain("tool_4");
    expect(names).not.toContain("tool_3");
  });

  it("survives arguments that are not valid JSON", () => {
    // The stored trace is text; a malformed one must not lose the fact that a
    // call was made at all.
    const [call] = callsIn(toolTraceMessages([{ name: "read_file", args: "{oops" }], "m1")[0]);
    expect(call?.name).toBe("read_file");
    expect(call?.args).toEqual({ value: "{oops" });
  });

  it("pairs every result with a call, so no id is left dangling", () => {
    // A tool result with no matching call is a hard provider error, not a
    // degraded turn.
    const [assistant, results] = toolTraceMessages(
      [
        { name: "a", result: "1" },
        { name: "b", result: "2" },
      ],
      "m1",
    );
    const ids = callsIn(assistant).map((call) => call.id);
    expect(resultsIn(results).map((result) => result.toolCallId)).toEqual(ids);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("clipping the trace before it is stored", () => {
  it("caps a huge result at capture, not only at send", () => {
    // The transcript is rewritten to disk on every checkpoint and a tool
    // result is unbounded — an app tool can return a page of JSON. Storing it
    // raw grows the saved conversation without limit for data that is clipped
    // the moment it is used anyway.
    const [entry] = trimToolTrace([{ name: "app_run_tool", result: "x".repeat(50_000) }]);
    expect(entry?.result?.length).toBeLessThan(300);
    expect(entry?.result).toContain("[truncated]");
  });

  it("caps arguments too", () => {
    const [entry] = trimToolTrace([{ name: "web_search", args: `{"q":"${"y".repeat(5_000)}"}` }]);
    expect(entry?.args?.length).toBeLessThan(200);
  });

  it("keeps clipped arguments parseable, so replay does not nest them under value", () => {
    // The reported failure: a long app_run_tool call was stored as sliced raw
    // JSON, which no longer parsed, so replay wrapped the fragment as
    // { value: "{\"tool\":…" } and the Blob copied that shape into its next
    // call — the value.value nesting it kept getting "Invalid arguments" for.
    const args = JSON.stringify({
      tool: "YOUTUBE_SEARCH_YOU_TUBE",
      arguments: JSON.stringify({
        q: "ai tools",
        order: "viewCount",
        publishedAfter: "2026-08-22T00:00:00Z",
        relevanceLanguage: "en",
        maxResults: 25,
        part: "snippet",
      }),
    });
    const trimmed = trimToolTrace([{ name: "app_run_tool", args, result: "ok" }]);
    expect(() => JSON.parse(trimmed[0]?.args ?? "")).not.toThrow();

    const [assistant] = toolTraceMessages(trimmed, "m1");
    const replayed = callsIn(assistant).at(0)?.args ?? {};
    expect(replayed.tool).toBe("YOUTUBE_SEARCH_YOU_TUBE");
    expect(replayed).not.toHaveProperty("value");
    // Field names survive; only the values are shortened.
    expect(Object.keys(replayed)).toEqual(["tool", "arguments"]);
    expect(String(replayed.arguments)).toContain("[truncated]");
  });

  it("still keeps a non-object argument string, wrapped", () => {
    // Nothing to preserve field names from, so `value` remains the fallback.
    const [entry] = trimToolTrace([{ name: "app_run_tool", args: "not json at all" }]);
    expect(entry?.args).toBe("not json at all");
    const [assistant] = toolTraceMessages([{ name: "app_run_tool", args: "nope" }], "m2");
    expect(callsIn(assistant).at(0)?.args).toEqual({ value: "nope" });
  });

  it("keeps only the most recent calls", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ name: `tool_${index}` }));
    const names = trimToolTrace(many).map((entry) => entry.name);
    expect(names).toHaveLength(8);
    expect(names.at(-1)).toBe("tool_29");
  });

  it("leaves a small trace exactly as it was", () => {
    // No spurious keys: an undefined result must not become "undefined".
    expect(trimToolTrace([{ name: "read_file", args: '{"path":"a.md"}', result: "hi" }])).toEqual([
      { name: "read_file", args: '{"path":"a.md"}', result: "hi" },
    ]);
    expect(trimToolTrace([{ name: "ask_user" }])).toEqual([{ name: "ask_user" }]);
  });
});

describe("history trimmed between a call and its result", () => {
  it("drops the orphaned result rather than sending a broken request", () => {
    // History is cut from the front when a conversation outgrows the budget,
    // and the cut lands wherever it lands — including mid-pair.
    const trimmed = dropOrphanToolResults([
      { role: "tool", content: [{ type: "tool_result", toolCallId: "gone", content: "x" }] },
      { role: "user", content: "and now?" },
    ]);
    expect(trimmed).toEqual([{ role: "user", content: "and now?" }]);
  });

  it("keeps a result whose call is still in the window", () => {
    const paired: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "read_file", args: {} }],
      },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", content: "ok" }] },
    ];
    expect(dropOrphanToolResults(paired)).toEqual(paired);
  });

  it("keeps the half of a message whose calls survived", () => {
    // One message can carry several results; only the unmatched ones go.
    const trimmed = dropOrphanToolResults([
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "read_file", args: {} }],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "c1", content: "kept" },
          { type: "tool_result", toolCallId: "gone", content: "dropped" },
        ],
      },
    ]);
    const results = resultsIn(trimmed[1]);
    expect(results).toHaveLength(1);
    expect(String(results[0]?.content)).toBe("kept");
  });

  it("leaves an ordinary conversation untouched", () => {
    const plain: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(dropOrphanToolResults(plain)).toEqual(plain);
  });
});
