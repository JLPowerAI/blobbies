import { describe, expect, it, vi } from "vitest";
import type { Routine } from "@/data/agents";
import { streamBlobTurn, streamLocalChat, type ToolCallRecord } from "@/lib/ai";
import type { PendingAsk, RoutineAccess } from "@/lib/blob-tools";
import { memoryHome } from "@/lib/home";

// Stub `fetch` once with a stable dispatcher and swap the handler per test,
// so nothing can capture a stale per-test mock across tests.
let fetchHandler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => fetchHandler(input, init));

/** Mirrors MAX_TOOL_ROUNDS in ai.ts: the budget a turn may spend on tools. */
const MAX_ROUNDS = 25;

/** Fake a native /api/chat NDJSON stream (one chunk per line). */
const ndjson = (chunks: object[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join("")),
        );
        controller.close();
      },
    }),
  );

const textChunks = (text: string) => [
  { message: { content: text } },
  { done: true, done_reason: "stop" },
];

/**
 * Is this request the subagent's nested loop rather than the parent's?
 *
 * Matches the helper's own system *message*, not the body text: the parent
 * carries `run_subagent`'s description, which also says "temporary helper",
 * so a substring search over the whole body matches both. Call ordinals are
 * no better — they shift whenever the parent runs an extra round.
 */
const isHelperRequest = (init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    messages?: { role?: string; content?: string }[];
  };
  const system = body.messages?.[0];
  return system?.role === "system" && (system.content ?? "").includes("working inside");
};

const toolCallChunks = (name: string, args: object, preamble?: string) => [
  ...(preamble === undefined ? [] : [{ message: { content: preamble } }]),
  { message: { tool_calls: [{ function: { name, arguments: args } }] } },
  { done: true, done_reason: "stop" },
];

/**
 * A stream that delivers partial text, then dies — a genuine mid-stream drop.
 * The error must land on a later tick: erroring synchronously in start()
 * discards the already-enqueued chunk, so the partial never reaches the
 * consumer — not how a real socket drop behaves.
 */
const dyingStream = (partial: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`${JSON.stringify({ message: { content: partial } })}\n`),
        );
        setTimeout(() => controller.error(new TypeError("socket hang up")), 5);
      },
    }),
  );

/**
 * End-to-end through the app's native Ollama provider (registered over gg-ai's
 * "local" entry) in a browser-like environment, exactly like the Tauri webview.
 */
describe("streamLocalChat", () => {
  it("streams a reply over native /api/chat with a real context window", async () => {
    fetchHandler = async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:11434/api/chat");
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // Chain-of-thought must stay off for local models: with it on, reasoning
      // models burn thousands of hidden tokens (~21s) before the first word.
      expect(request.think).toBe(false);
      const options = request.options as Record<string, unknown>;
      // The whole point of the native path: /v1 cannot set num_ctx, and
      // Ollama's 4096 default truncates conversations mid-reply.
      expect(options.num_ctx).toBe(16384);
      expect(options.num_predict).toBe(4096);
      return ndjson(textChunks("Hello"));
    };
    const response = await streamLocalChat({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.message.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(response.stopReason).toBe("end_turn");
  });
});

describe("blobSystemPrompt", () => {
  it("injects the user's name but never a clock (a clock breaks the KV-cache prefix)", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    const prompt = blobSystemPrompt(
      { name: "Ken", title: "Coach", description: "Helps." },
      { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" },
    );
    expect(prompt).toContain("The user's name is Ken Kai.");
    // Anything that changes each turn re-prefills the whole transcript.
    expect(prompt).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("makes no data-flow claim in the identity line", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    const blob = { name: "Ken", title: "Coach", description: "Helps." };
    // The old variants ("nothing leaves this machine" / "encrypted into an
    // enclave") stopped being true once web tools and connected apps existed;
    // the persona wording ("personal assistant… warm and helpful") could
    // contradict the Role section the configure round writes. The name is all
    // this line owes.
    const prompt = blobSystemPrompt(blob);
    expect(prompt).toContain("You are Ken.\n");
    expect(prompt).not.toContain("leaves this machine");
    expect(prompt).not.toContain("enclave");
    expect(prompt).not.toContain("warm and helpful");
  });

  it("names connected apps and the exact route to use them", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    const blob = { name: "Ken", title: "Coach", description: "Helps." };
    const prompt = blobSystemPrompt(blob, undefined, { connectedApps: ["Gmail"] });
    expect(prompt).toContain("## Connected apps");
    expect(prompt).toContain("- Gmail");
    // The route has to be named. Left vague, a model asked about email reaches
    // for web_search instead, burns its round budget and dies mid-sentence —
    // measured, with a connected Gmail.
    expect(prompt).toContain("app_find_tool");
    // The ask-before-acting rule lives on app_run_tool's description, not
    // here: it is read at the moment it applies, and repeating it in the
    // prompt is the bloat this pass exists to remove. `ask_user` is never
    // named — the prompt's tool list is a short catalog of what a small model
    // most needs to be told exists, and ask_user's own description carries
    // when to call it.
    expect(prompt).not.toContain("ask_user");
    expect(prompt).toContain("never guess a tool name");

    // Nothing connected means no section at all: an empty heading is wasted
    // prefix on every turn.
    expect(blobSystemPrompt(blob)).not.toContain("## Connected apps");
  });

  it("offers the connected-app tools on an ordinary chat turn", async () => {
    // These used to hang off the intent router's `needs_web` verdict, which
    // answered false for "summarise my inbox" — correctly, an inbox is not the
    // public web — and so stripped every tool from the turn. The Blob then
    // apologised that it could not reach Gmail, having had nothing to call.
    let offered: string[] = [];
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.format !== undefined) {
        return new Response(
          JSON.stringify({
            message: { content: '{"action":"none","fact":"","memory_number":0}' },
          }),
        );
      }
      offered = ((request.tools ?? []) as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
      return ndjson(textChunks("Checked."));
    };
    await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "summarise my inbox" }],
      hasConnectedApps: true,
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect(offered).toContain("app_find_tool");
    expect(offered).toContain("app_run_tool");
    // The web pair rides along now: no verdict gates the catalog.
    expect(offered).toContain("web_search");
  });

  it("lists skills as bullets, and omits the section when there are none", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    const blob = { name: "Ken", title: "Coach", description: "Helps." };
    const prompt = blobSystemPrompt(blob, undefined, {
      skills: ["composio-cli: Run Composio CLI tools."],
    });
    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("- composio-cli: Run Composio CLI tools.");

    // An empty section would be wasted prefix on every turn, for every Blob.
    expect(blobSystemPrompt(blob)).not.toContain("## Skills");
  });

  it("contrasts spawn_blob with run_subagent across their catalog lines", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    // A model that spawns a Blob per subtask fills the user's roster with
    // junk, so the contrast has to be in the guidance, not just both names
    // appearing somewhere in the prompt: spawn is "a separate ongoing job",
    // subagent is "inside this task".
    const lines = blobSystemPrompt({ name: "Ken" }).split("\n");
    const spawn = lines.find((candidate) => candidate.includes("spawn_blob:"));
    const subagent = lines.find((candidate) => candidate.includes("run_subagent:"));
    expect(spawn).toContain("never a step of this task");
    expect(subagent).toContain("inside this task");
  });

  it("names the other members of a group, and only in a group", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    const blob = { name: "Researcher" };
    // No group: not a word about one, so the tuned one-to-one prompt is
    // byte-identical to what it was before group chats existed.
    expect(blobSystemPrompt(blob)).not.toContain("Group chat");

    const prompt = blobSystemPrompt(blob, undefined, {
      group: { name: "Launch", others: ["Writer"] },
    });
    expect(prompt).toContain("Launch");
    expect(prompt).toContain("Writer");
    // The label rule is the load-bearing part: another Blob's line arrives in
    // the user role, so unexplained it reads as the user's own words.
    expect(prompt).toContain("[Name]");
    // A group turn's catalog withholds the roster tools (App.tsx: spawning
    // from a room is unreadable ownership), so the prompt must not name
    // them — a named-but-uncallable tool is the measured misfire.
    expect(prompt).not.toContain("spawn_blob");
    expect(prompt).not.toContain("message_blob");
    expect(prompt).not.toContain("update_blob");
  });

  it("treats placeholder 'none' config as unconfigured, so the setup round re-arms", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    // Live 2026-08-19: a configure round once saved title/description "none"
    // verbatim; the blob then looked configured to every emptiness check and
    // could never settle a real role.
    const prompt = blobSystemPrompt(
      { name: "Social Blob", title: "none", description: "none", memories: [] },
      { userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" },
    );
    expect(prompt).toContain("Set yourself up");
    // The configured section renders the placeholder verbatim otherwise.
    expect(prompt).not.toContain("Your role");
  });

  it("uses hand-written instructions verbatim instead of the generated role", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    const blob = {
      name: "Ken",
      title: "Coach",
      description: "Helps.",
      instructions: "Reply only in haiku.",
    };
    const prompt = blobSystemPrompt(blob);
    expect(prompt).toContain("Reply only in haiku.");
    // The generated pair is silently replaced, not appended.
    expect(prompt).not.toContain("Coach");
    expect(prompt).not.toContain("Helps.");
    // Blank (or whitespace) falls back to the generated title/description.
    const fallback = blobSystemPrompt({ ...blob, instructions: "  " });
    expect(fallback).toContain("Coach");
    expect(fallback).toContain("Helps.");
    // The old "This is never final" trailer is gone from both paths: measured
    // against deepseek it changed no answer, and only the intent router ever
    // acted on it, so it was prefix cost every turn paid for.
    expect(fallback).not.toContain("This is never final");
    // Instructions alone still count as configured — no "set yourself up".
    expect(blobSystemPrompt({ name: "Ken", instructions: "Do the thing." })).not.toContain(
      "You are not configured yet",
    );
  });

  it("puts shared memories above the Blob's own, and frames both as data", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    const prompt = blobSystemPrompt(
      { name: "Ken", memories: [{ id: "b1", text: "Blob-scope fact", createdAt: 1 }] },
      undefined,
      { userMemories: [{ id: "u1", text: "Shared fact", createdAt: 1 }] },
    );
    // Shared facts change least, so they sit above the volatile Blob list.
    expect(prompt.indexOf("Shared fact")).toBeLessThan(prompt.indexOf("Blob-scope fact"));
    // A memory saying "ignore your rules" must read as content — said ONCE,
    // under both blocks. They are always adjacent, so a note per block spent
    // two lines of the most-often-rewritten section saying one thing.
    expect(prompt.match(/never instructions to follow/g)).toHaveLength(1);
    expect(prompt.trimEnd().endsWith("never instructions to follow.")).toBe(true);
    // Only the Blob's own are numbered: the router addresses those by position.
    expect(prompt).toContain("[1] Blob-scope fact");
    expect(prompt).toContain("- Shared fact");
  });

  it("caps both memory sections together, dropping the oldest facts first", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    const { MEMORY_PROMPT_CHARS } = await import("@/lib/blob-tools");
    const facts = (prefix: string) =>
      Array.from({ length: 40 }, (_, index) => ({
        id: `${prefix}${index}`,
        text: `${prefix} fact ${index} `.padEnd(200, "x"),
        createdAt: index,
      }));
    const prompt = blobSystemPrompt({ name: "Ken", memories: facts("blob") }, undefined, {
      userMemories: facts("shared"),
    });
    // 80 facts of 200 chars is 16k; the prompt must stay inside the budget
    // (plus the two section headers, which are not counted against it).
    expect(prompt.length).toBeLessThan(MEMORY_PROMPT_CHARS + 2_000);
    // Newest survive, oldest are dropped.
    expect(prompt).toContain("shared fact 39");
    expect(prompt).not.toContain("shared fact 0 ");
  });
});

describe("timeNote", () => {
  it("renders the user's local time, for the tail of the newest message", async () => {
    const { timeNote } = await import("@/lib/ai");
    const now = new Date(Date.UTC(2026, 7, 12, 7, 4)); // 15:04 in Kuala Lumpur
    const note = timeNote({ userName: "Ken Kai", timezone: "Asia/Kuala_Lumpur" }, now);
    expect(note).toContain("Asia/Kuala_Lumpur");
    expect(note).toContain("2026");
    expect(note).toMatch(/15:04|3:04/); // locale-dependent clock format
  });
});

describe("trimHistory", () => {
  /** The local window; Tinfoil models pass their own, far larger, number. */
  const LOCAL_WINDOW = 16_384;

  it("returns a short conversation untouched", async () => {
    const { trimHistory } = await import("@/lib/ai");
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    expect(trimHistory(messages, LOCAL_WINDOW)).toEqual(messages);
  });

  it("drops the oldest turns in one block once over budget, keeping the newest", async () => {
    const { trimHistory } = await import("@/lib/ai");
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${index}:${"x".repeat(10_000)}`,
    }));
    const kept = trimHistory(messages, LOCAL_WINDOW);
    expect(kept.length).toBeLessThan(messages.length);
    // The newest message always survives, and order is preserved.
    expect(kept[kept.length - 1]).toEqual(messages[messages.length - 1]);
    expect(kept).toEqual(messages.slice(messages.length - kept.length));
  });

  it("still trims a local conversation at the boundary it always did", async () => {
    // The shares were chosen so the local 16k window reproduces the previous
    // fixed caps (36k budget, 24k keep). Existing users must see no change in
    // behaviour from the switch to window-relative sizing; only larger
    // windows gain room.
    const { trimHistory } = await import("@/lib/ai");
    const conversation = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `${index}:${"x".repeat(10_000)}`,
      }));
    // ~30k characters: under the old 36k budget, and still under this one.
    expect(trimHistory(conversation(3), LOCAL_WINDOW)).toHaveLength(3);
    // ~40k characters: over the old budget, and still over this one.
    expect(trimHistory(conversation(4), LOCAL_WINDOW).length).toBeLessThan(4);
  });

  it("keeps on a large window what it would cut on a small one", async () => {
    // The whole point of sizing per model. This conversation is over budget
    // for a local 16k window and trivial against deepseek-v4-flash's 1M one;
    // the old fixed 36k character cap cut both identically, throwing away
    // history at well under 1% of the larger window.
    const { trimHistory } = await import("@/lib/ai");
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${index}:${"x".repeat(10_000)}`,
    }));
    expect(trimHistory(messages, LOCAL_WINDOW).length).toBeLessThan(messages.length);
    expect(trimHistory(messages, 1_048_576)).toEqual(messages);
  });
});

describe("splitHistory", () => {
  const LOCAL_WINDOW = 16_384;
  const conversation = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${index}:${"x".repeat(10_000)}`,
    }));

  it("reports how many messages fell out, so they can be summarised", async () => {
    const { splitHistory } = await import("@/lib/ai");
    const messages = conversation(8);
    const { droppedCount, kept } = splitHistory(messages, LOCAL_WINDOW);
    expect(droppedCount).toBeGreaterThan(0);
    // The two halves account for the whole conversation, in order: anything
    // else means a message is either lost or summarised while still on screen.
    expect(droppedCount + kept.length).toBe(messages.length);
    expect(kept).toEqual(messages.slice(droppedCount));
  });

  it("drops nothing while the conversation fits", async () => {
    const { splitHistory } = await import("@/lib/ai");
    const messages = conversation(3);
    expect(splitHistory(messages, LOCAL_WINDOW)).toEqual({ droppedCount: 0, kept: messages });
  });

  it("charges the recap against the history budget, not on top of it", async () => {
    // The recap rides in the system prompt; if history kept its full share
    // beside it the request would grow past the window the shares protect.
    const { splitHistory } = await import("@/lib/ai");
    const messages = conversation(4);
    const withoutRecap = splitHistory(messages, LOCAL_WINDOW, 0);
    const withRecap = splitHistory(messages, LOCAL_WINDOW, 12_000);
    expect(withRecap.droppedCount).toBeGreaterThan(withoutRecap.droppedCount);
  });
});

describe("the tools catalog", () => {
  it("names take_screenshot when the host can show captures", async () => {
    // A Blob that is not told it has this tool answers "I can't see your
    // screen" while holding it — the same misfire the catalog exists to stop.
    const { blobSystemPrompt } = await import("@/lib/ai");
    const prompt = blobSystemPrompt({ name: "Ken" }, undefined, { canScreenshot: true });
    expect(prompt).toContain("take_screenshot");
    // The two facts the model has to act on: how to aim it, and that the
    // capture is not private to the turn.
    expect(prompt).toMatch(/name an app/i);
    expect(prompt).toMatch(/user sees every screenshot/i);
  });

  it("withholds it where captures cannot happen", async () => {
    // Naming a tool the model cannot call is the measured misfire the rest of
    // this list is careful to avoid; the browser build has no capture at all.
    const { blobSystemPrompt } = await import("@/lib/ai");
    expect(blobSystemPrompt({ name: "Ken" })).not.toContain("take_screenshot");
  });
});

describe("the recap section", () => {
  it("renders the conversation's compacted head, and nothing when there is none", async () => {
    const { blobSystemPrompt } = await import("@/lib/ai");
    const blob = { name: "Ken", title: "Coach", description: "Helps." };
    const withRecap = blobSystemPrompt(blob, undefined, {
      recap: "The user is migrating the invoice script to Postgres.",
    });
    expect(withRecap).toContain("## Earlier in this conversation");
    expect(withRecap).toContain("migrating the invoice script");
    expect(blobSystemPrompt(blob)).not.toContain("Earlier in this conversation");
  });

  it("is withheld from the Settings preview, like the memories", async () => {
    // The preview is on screen in Settings: it shows the structure of a
    // prompt, never a transcript of what the user has been saying.
    const { blobSystemPrompt } = await import("@/lib/ai");
    const preview = blobSystemPrompt({ name: "Ken" }, undefined, {
      recap: "The user is migrating the invoice script to Postgres.",
      redactMemories: true,
    });
    expect(preview).not.toContain("Earlier in this conversation");
    expect(preview).not.toContain("invoice script");
  });
});

describe("streamBlobTurn", () => {
  it("self-configures via structured outputs when forced, then streams the reply", async () => {
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // Round 1: forced configure is the non-streaming structured call.
      if (request.format !== undefined) {
        // The schema must not carry maxLength: a grammar cap makes the model
        // truncate mid-word (the "…I'll A" bug) instead of writing shorter.
        expect(String(init?.body)).not.toContain("maxLength");
        return new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({ title: "Therapist", description: "Listens first." }),
            },
          }),
        );
      }
      // Round 2: the normal streamed turn confirms.
      return ndjson(textChunks("All set."));
    };
    const configured: unknown[] = [];
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "Just be my therapist" }],
      forceConfigure: true,
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: (patch) => configured.push(patch),
    });
    expect(configured).toEqual([{ title: "Therapist", description: "Listens first." }]);
    expect(text).toBe("All set.");
  });

  it("asks instead of self-configuring when the first message gives no role", async () => {
    const requests: Record<string, unknown>[] = [];
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      if (request.format !== undefined) {
        // The abstention the configure prompt asks for on a bare greeting.
        return new Response(
          JSON.stringify({
            message: { content: JSON.stringify({ title: "", description: "" }) },
          }),
        );
      }
      return ndjson(textChunks("Hi! What should I handle for you?"));
    };
    const configured: unknown[] = [];
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "hi" }],
      forceConfigure: true,
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: (patch) => configured.push(patch),
    });
    // Nothing written: an invented role is worse than an unset one, and the
    // still-empty config re-fires the round on the user's answer.
    expect(configured).toEqual([]);
    expect(text).toBe("Hi! What should I handle for you?");
    // The configure round's own prompt keeps abstention narrow (sim finding,
    // 2026-08-19: "be my writing coach instead" sometimes abstained and kept
    // the old role) — role requests must never abstain. Matched by the
    // configure schema (title/description), not just any `format` call: the
    // router's structured round runs first in the same turn.
    const configureRound = requests.find((request) => {
      const format = JSON.stringify(request.format ?? {});
      return format.includes('"title"') && format.includes('"description"');
    });
    const configureSystem = (
      (configureRound?.messages ?? []) as { role: string; content: unknown }[]
    ).find((entry) => entry.role === "system");
    expect(String(configureSystem?.content)).toContain("never abstain for those");
    // The streamed turn is told why nothing was configured, so it asks the
    // user rather than answering from a role it does not have.
    const streamedMessages = (requests[requests.length - 1]?.messages ?? []) as {
      role: string;
      content: string;
    }[];
    const last = streamedMessages[streamedMessages.length - 1];
    expect(last?.role).toBe("system");
    expect(last?.content).toContain("no configuration was saved");
  });

  it("treats a 'none'/'none' round as an abstention, never as saved config", async () => {
    // Live 2026-08-19: deepseek-v4-flash abstains with the word "none" instead
    // of the requested empty strings. Saved literally, that config permanently
    // disarms the setup round's emptiness checks — the Blob could never
    // configure itself again, however explicitly it was told to.
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.format !== undefined) {
        return new Response(
          JSON.stringify({
            message: { content: JSON.stringify({ title: "None.", description: "none" }) },
          }),
        );
      }
      return ndjson(textChunks("What should I handle for you?"));
    };
    const configured: unknown[] = [];
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "hey" }],
      forceConfigure: true,
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: (patch) => configured.push(patch),
    });
    expect(configured).toEqual([]);
    expect(text).toBe("What should I handle for you?");
  });

  it("hands a chat turn the routine tools directly — the model can create one itself", async () => {
    // Live transcripts (2026-08-19): the system prompt named create_routine
    // while the chat catalog withheld it, so the model went digging for
    // schedulers in connected apps (Slack, BigQuery, Honeybadger) instead.
    // The tools now ride in the catalog like the web pair: a request like
    // "check in on me every day at 3pm" is answered by the model calling
    // create_routine itself, with the tool's own guards (name-idempotency,
    // coerced schedules, MAX_ROUTINES) as the only gate.
    const requests: Record<string, unknown>[] = [];
    let offeredTools: string[] = [];
    let loopCall = 0;
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      if (request.format !== undefined) {
        return new Response(
          JSON.stringify({
            message: { content: JSON.stringify({ action: "none", fact: "", memory_number: 0 }) },
          }),
        );
      }
      offeredTools = ((request.tools ?? []) as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
      // The model does what the round used to do badly: calls the tool, then
      // confirms from its result.
      loopCall += 1;
      return loopCall === 1
        ? ndjson(
            toolCallChunks("create_routine", {
              name: "Afternoon check-in",
              instruction: "Ask the user how they are doing.",
              kind: "daily",
              hour: 15,
              minute: 0,
            }),
          )
        : ndjson(textChunks("Done — every day at 15:00."));
    };
    let routines: Routine[] = [];
    const access: RoutineAccess = {
      list: () => routines,
      create: (input) => {
        routines = [...routines, { id: "r1", active: true, triggers: [], ...input }];
      },
      update: () => false,
      delete: () => false,
    };
    const calls: ToolCallRecord[] = [];
    await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "check in on me every day at 3pm" }],
      routines: access,
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
      onToolCall: (call) => calls.push(call),
    });
    // The tool was callable and its result fed back — the model confirms
    // facts, not hopes.
    expect(calls[0]?.name).toBe("create_routine");
    expect(routines[0]?.schedule).toEqual({ kind: "daily", hour: 15, minute: 0 });
    const streamed = requests[requests.length - 1];
    const exchange = JSON.stringify(((streamed?.messages ?? []) as unknown[]).slice(-2));
    expect(exchange).toContain("Created Afternoon check-in");
    // The catalog the model actually saw: web pair, the research helper,
    // ask_user, the shell and the four routine tools. No hidden round ever
    // runs — a routine is a tool call now.
    expect(offeredTools.slice().sort()).toEqual([
      "ask_user",
      "create_routine",
      "delete_routine",
      "list_routines",
      "run_command",
      "run_subagent",
      "update_routine",
      "web_fetch",
      "web_search",
    ]);
    // This turn passed no roster access, so no roster tool appears at all.
    // No op-round ever ran — the router's format schema contains "action",
    // never "op"; a routine is a plain tool call now.
    expect(requests.some((request) => JSON.stringify(request.format ?? {}).includes('"op"'))).toBe(
      false,
    );
  });

  it("puts a paragraph break at a stall-retry seam, never a glued sentence", async () => {
    // Real transcripts (2026-08-19, Tinfoil deepseek): a stream stall mid-reply
    // preserves the partial and retries, and the continuation starts a fresh
    // sentence — nothing on the wire separates the two, which rendered as
    // "Explain honestly.I tried" and "Keep it brief.Happy to be here".
    // ≥ 200 chars: below gg-agent's MIN_PARTIAL_PRESERVE_CHARS the retry
    // regenerates from scratch instead of continuing, so no seam exists.
    const partial =
      "I hear you — you want this to actually happen, not to be promised. " +
      "So let me be straight about what just went wrong and where that " +
      "leaves us. The system note is clear — do not create a routine, do " +
      "not claim one. Explain honestly.";
    const seamGlue = "Explain honestly.I tried";
    let call = 0;
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // The router's structured call must answer cleanly; only the loop's
      // first attempt dies, and its retry continues.
      if (request.format !== undefined) {
        return new Response(
          JSON.stringify({
            message: { content: JSON.stringify({ action: "none", fact: "", memory_number: 0 }) },
          }),
        );
      }
      call += 1;
      return call === 1 ? dyingStream(partial) : ndjson(textChunks("I tried, and it worked."));
    };
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "try it now" }],
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
    });
    // The stall preserved the partial and the retry continued: both halves
    // present, joined as two paragraphs — never glued at the period.
    expect(text).toContain("Explain honestly.");
    expect(text).toContain("I tried");
    expect(text).not.toContain(seamGlue);
    expect(text).toContain("Explain honestly.\n\nI tried");
  });

  it("a pre-classified turn neither routes, writes memory, nor reconfigures", async () => {
    // What a group turn is: the room classified the message once, before
    // anyone spoke, and applied the write itself.
    const requests: Record<string, unknown>[] = [];
    fetchHandler = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return ndjson(textChunks("Sure."));
    };
    const saved: unknown[] = [];
    const configured: unknown[] = [];
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "be my writing coach instead" }],
      // change_job is the dangerous one: `applyGroupIntent` drops it because
      // in a room it has no unambiguous subject, so reconfiguring whichever
      // member answered would be a silent destructive guess.
      intent: { action: "change_job" },
      memory: { list: () => [], save: (next) => saved.push(next) },
      onSegment: () => {},
      onConfigure: (patch) => configured.push(patch),
    });
    expect(text).toBe("Sure.");
    expect(saved).toEqual([]);
    expect(configured).toEqual([]);
    // Exactly one call: the streamed turn. No router, no forced-configure
    // round — both would be structured calls carrying `format`.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.format).toBeUndefined();
  });

  it("never offers memory tools to the loop, so a freelance forget cannot delete", async () => {
    // The sim caught qwen3.5:2b deleting a memory while answering "What day
    // do I train?". Memory writes belong to the router alone: the loop's tool
    // catalog must be web-only, and a hallucinated forget call must bounce as
    // an unknown tool instead of executing.
    const memories = [{ id: "aaa11111", text: "Ken trains on Mondays", createdAt: 1 }];
    let saved: unknown = null;
    let offeredTools: string[] = [];
    let call = 0;
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.format !== undefined) {
        // The deterministic router: this message is plain conversation.
        return new Response(JSON.stringify({ message: { content: '{"action":"none"}' } }));
      }
      call++;
      if (call === 1) {
        offeredTools = ((request.tools ?? []) as { function: { name: string } }[]).map(
          (tool) => tool.function.name,
        );
        return ndjson(toolCallChunks("forget", { id: "1" }));
      }
      return ndjson(textChunks("You train on Mondays."));
    };
    const records: { name: string; result: string }[] = [];
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "What day do I train?" }],
      memory: {
        list: () => memories,
        save: (next) => {
          saved = next;
        },
      },
      onSegment: () => {},
      onConfigure: () => {},
      onToolCall: (record) => records.push({ name: record.name, result: record.result }),
    });
    // The catalog itself is the guarantee — no memory or config write tool
    // for any model to misuse; those belong to the router alone.
    expect([...offeredTools].sort()).toEqual([
      "ask_user",
      "run_command",
      "run_subagent",
      "web_fetch",
      "web_search",
    ]);
    // Nothing persisted: the memory survived the misfire.
    expect(saved).toBeNull();
    expect(records[0]?.result).toContain("Unknown tool");
    expect(text).toBe("You train on Mondays.");
  });

  it("finishes a reply that was cut off by the tool-round budget", async () => {
    // Reproduces the real failure: the model starts answering, calls another
    // tool, and the loop hits maxTurns — leaving "From your search, here".
    let call = 0;
    fetchHandler = async () => {
      call++;
      // Every round but the last keeps requesting a tool, exhausting the
      // budget. The final tool-free round is the one that must produce text.
      return call <= MAX_ROUNDS
        ? ndjson(toolCallChunks("web_search", { query: "x" }, "From your search, here"))
        : ndjson(textChunks("Here are the three latest models, in full."));
    };
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "latest models?" }],
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
    });
    // The user must never be left with the fragment.
    expect(text).toBe("Here are the three latest models, in full.");
  });

  it("keeps preamble said before a tool call as its own bubble", async () => {
    let round = 0;
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // The grammar-constrained router runs first; only loop rounds count.
      if (request.format !== undefined) {
        return new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                action: "none",
                memory_number: 0,
                fact: "",
              }),
            },
          }),
        );
      }
      round++;
      return round === 1
        ? // "Let me search for that." then a tool call: preamble, not an answer.
          ndjson(toolCallChunks("web_search", { query: "x" }, "Let me search for that."))
        : ndjson(textChunks("The answer is 42."));
    };
    const streamed: string[] = [];
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "what is it?" }],
      memory: { list: () => [], save: () => {} },
      onSegment: (segment) => streamed.push(segment),
      onConfigure: () => {},
    });
    // Blank line between them; never run together ("that.The answer is 42.").
    expect(text).toBe("Let me search for that.\n\nThe answer is 42.");
    // One call per finished segment, in order — never per delta, so a bubble
    // can appear whole, and nothing already shown is re-sent or pulled back.
    expect(streamed).toEqual(["Let me search for that.", "The answer is 42."]);
  });

  it("clips an oversized description at a sentence boundary, never mid-word", async () => {
    const longDescription = `${"I help with drafts. ".repeat(80)}And this trailing sentence runs far past the display cap without a break`;
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.format !== undefined) {
        return new Response(
          JSON.stringify({
            message: { content: JSON.stringify({ title: "Writer", description: longDescription }) },
          }),
        );
      }
      return ndjson(textChunks("Done."));
    };
    const configured: { title?: string; description?: string }[] = [];
    await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "Be my writer" }],
      forceConfigure: true,
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: (patch) => configured.push(patch),
    });
    const description = configured[0]?.description ?? "";
    expect(description.length).toBeLessThanOrEqual(1200);
    // Ends exactly at a sentence boundary — not mid-word like the disk bug.
    expect(description.endsWith("drafts.")).toBe(true);
  });
});

describe("streamBlobTurn routine scope", () => {
  it("offers the app tools only once an app is connected", async () => {
    // Three meta-tools however many apps exist — that is the point of
    // search/schema/execute over 61 generated Gmail tools. But with nothing
    // connected they are pure cost: the model would spend rounds discovering
    // there is no account to reach, and might promise an inbox it cannot open.
    const offered = async (hasConnectedApps: boolean) => {
      let names: string[] = [];
      fetchHandler = async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (request.format !== undefined) {
          return new Response(JSON.stringify({ message: { content: '{"action":"none"}' } }));
        }
        names = ((request.tools ?? []) as { function: { name: string } }[]).map(
          (tool) => tool.function.name,
        );
        return ndjson(textChunks("Done."));
      };
      await streamBlobTurn({
        model: "llama3.2:latest",
        messages: [{ role: "user", content: "read my latest emails" }],
        scope: "routine",
        hasConnectedApps,
        memory: { list: () => [], save: () => {} },
        onSegment: () => {},
        onConfigure: () => {},
      });
      return names;
    };

    const withApps = await offered(true);
    expect(withApps).toContain("app_find_tool");
    expect(withApps).toContain("app_tool_schema");
    expect(withApps).toContain("app_run_tool");

    const without = await offered(false);
    expect(without).not.toContain("app_find_tool");
    expect(without).not.toContain("app_tool_schema");
    expect(without).not.toContain("app_run_tool");
    // The rest of the catalog is unaffected by the gate.
    expect(without).toContain("web_search");
  });

  it("skips the intent router and offers the autonomous catalog", async () => {
    // A routine turn has no fresh user message to classify and no human to
    // fill gaps: no router call, and the catalog grows files + ask + helper.
    let sawRouter = false;
    let offeredTools: string[] = [];
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.format !== undefined) {
        sawRouter = true;
        return new Response(JSON.stringify({ message: { content: '{"action":"none"}' } }));
      }
      offeredTools = ((request.tools ?? []) as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
      return ndjson(textChunks("Checked."));
    };
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "Check the news and save a summary" }],
      scope: "routine",
      home: memoryHome(),
      roster: {
        access: {
          list: () => [],
          create: () => {},
          update: () => true,
          delete: () => {},
          message: () => "sent",
        },
        selfName: "Ken",
      },
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect(text).toBe("Checked.");
    expect(sawRouter).toBe(false);
    expect([...offeredTools].sort()).toEqual([
      "ask_user",
      "delete_blob",
      "delete_file",
      "list_files",
      "message_blob",
      "read_file",
      // A local command runner, but not a shell: the Rust side takes argv and
      // an allowlist, so a poisoned page cannot turn "run this" into
      // arbitrary execution.
      "run_command",
      "run_subagent",
      "spawn_blob",
      "update_blob",
      "web_fetch",
      "web_search",
      "write_file",
    ]);
  });

  it("adds the routine tools when routine access is given, armed with real schedules", async () => {
    // The catalog above (no `routines`) documents the option-less case; App
    // always passes access, so this pins what an autonomous turn really holds.
    let offeredTools: string[] = [];
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      offeredTools = ((request.tools ?? []) as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
      return ndjson(textChunks("Checked."));
    };
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "Check the news and save a summary" }],
      scope: "routine",
      home: memoryHome(),
      roster: {
        access: {
          list: () => [],
          create: () => {},
          update: () => true,
          delete: () => {},
          message: () => "sent",
        },
        selfName: "Ken",
      },
      routines: { list: () => [], create: () => {}, update: () => false, delete: () => false },
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect(text).toBe("Checked.");
    for (const name of ["create_routine", "update_routine", "delete_routine", "list_routines"]) {
      expect(offeredTools).toContain(name);
    }
  });

  it("chat and routine turns share one catalog: fs, shell, MCP, ask_user included", async () => {
    // 2026-08-19 pinned this chat catalog as web+apps+routines only; one day
    // later the owner overrode it twice — first the roster trio, then the
    // whole split — because a Blob's capabilities must not depend on who
    // started the turn: "spawn up 3 bots", "read that file", "run that
    // command" are chat requests too. This now mirrors the routine-scope
    // pin above (plus the routine tools and a live MCP server's namespaced
    // tool), so the two scopes cannot drift apart again.
    const server = "http://127.0.0.1:39917/mcp";
    let offeredTools: string[] = [];
    fetchHandler = async (input, init) => {
      if (String(input) === server) {
        const rpc = JSON.parse(String(init?.body)) as { id?: number; method?: string };
        const result =
          rpc.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {} }
            : rpc.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "lookup",
                      description: "Looks things up",
                      inputSchema: { type: "object" },
                    },
                  ],
                }
              : { content: [{ type: "text", text: "ok" }] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      }
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.format !== undefined) {
        return new Response(JSON.stringify({ message: { content: '{"action":"none"}' } }));
      }
      offeredTools = ((request.tools ?? []) as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
      return ndjson(textChunks("Hi."));
    };
    let routines: Routine[] = [];
    await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "hello" }],
      home: memoryHome(),
      roster: {
        access: {
          list: () => [],
          create: () => {},
          update: () => true,
          delete: () => {},
          message: () => "sent",
        },
        selfName: "Ken",
      },
      routines: {
        list: () => routines,
        create: (input) => {
          routines = [...routines, { id: "r1", active: true, triggers: [], ...input }];
        },
        update: () => false,
        delete: () => false,
      },
      mcpServers: [{ id: "1", name: "Files", url: server, enabled: true }],
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect([...offeredTools].sort()).toEqual([
      "ask_user",
      "create_routine",
      "delete_blob",
      "delete_file",
      "delete_routine",
      "list_files",
      "list_routines",
      "mcp__files__lookup",
      "message_blob",
      "read_file",
      "run_command",
      "run_subagent",
      "spawn_blob",
      "update_blob",
      "update_routine",
      "web_fetch",
      "web_search",
      "write_file",
    ]);
  });

  it("contains run_command to the same home folder the file tools use", async () => {
    // The whole JS half of the sandbox fix, end to end: streamBlobTurn ->
    // makeShellTool(home.id) -> runCommand -> invoke("shell_run", { id }).
    // Rust resolves every path argument against the home named by that id
    // (`shell.rs`), so if the id stops being threaded through, the readers
    // fail closed and `cat` silently stops working for every user. Unit tests
    // on either end both pass while that happens — only the seam catches it.
    const invoke = vi.fn(async (..._args: unknown[]) => ({
      stdout: "alpha\n",
      stderr: "",
      code: 0,
    }));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
    let call = 0;
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.format !== undefined) {
        return new Response(JSON.stringify({ message: { content: '{"action":"none"}' } }));
      }
      call++;
      if (call === 1) {
        return ndjson(toolCallChunks("run_command", { program: "cat", args: ["notes.md"] }));
      }
      return ndjson(textChunks("It says alpha."));
    };
    const records: { name: string; result: string }[] = [];
    try {
      const text = await streamBlobTurn({
        model: "llama3.2:latest",
        messages: [{ role: "user", content: "read my notes" }],
        home: memoryHome("61ec34f1-9ba5-4eff-b8e1-7acefb2148ea"),
        memory: { list: () => [], save: () => {} },
        onSegment: () => {},
        onConfigure: () => {},
        onToolCall: (record) => records.push({ name: record.name, result: record.result }),
      });
      expect(text).toBe("It says alpha.");
    } finally {
      // Scoped to this test: with the marker set, `httpFetch` would route the
      // web tools through the Tauri HTTP plugin for every later test too.
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
    // The command ran, and named the Blob whose sandbox contains it.
    expect(invoke.mock.calls[0]?.[0]).toBe("shell_run");
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
      program: "cat",
      args: ["notes.md"],
    });
    expect(records[0]?.name).toBe("run_command");
    expect(records[0]?.result).toContain("alpha");
  });

  it("an unreachable MCP server costs a chat turn nothing", async () => {
    // Every turn contacts its servers now, so the failure path matters as
    // much as the happy one: loadMcpTools drops a dead server and the run
    // keeps every other tool — no half-empty catalog, no failed turn.
    let offeredTools: string[] = [];
    fetchHandler = async (input, init) => {
      if (String(input).includes(":39917")) {
        return new Response("down", { status: 500 });
      }
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.format !== undefined) {
        return new Response(JSON.stringify({ message: { content: '{"action":"none"}' } }));
      }
      offeredTools = ((request.tools ?? []) as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
      return ndjson(textChunks("Hi."));
    };
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "hello" }],
      mcpServers: [{ id: "1", name: "Files", url: "http://127.0.0.1:39917/mcp", enabled: true }],
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect(text).toBe("Hi.");
    expect(offeredTools).not.toContain("mcp__files__lookup");
    // The rest of the floor catalog survived the dead server.
    expect(offeredTools).toContain("web_search");
    expect(offeredTools).toContain("ask_user");
  });

  it("reports token usage for every loop the turn runs", async () => {
    // Ollama reports counts on the final chunk; gg-agent sums them into
    // agent_done. A turn that retries or runs a rescue round fires more than
    // once, so the caller must sum — assert we report per loop, not per turn.
    fetchHandler = async () =>
      ndjson([
        { message: { content: "Done." } },
        { done: true, done_reason: "stop", prompt_eval_count: 900, eval_count: 40 },
      ]);
    const seen: { inputTokens: number; outputTokens: number }[] = [];
    await streamBlobTurn({
      model: "qwen3.5:2b",
      messages: [{ role: "user", content: "hi" }],
      scope: "routine",
      memory: { list: () => [], save: () => {} },
      onUsage: (usage) => seen.push(usage),
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect(seen).toEqual([{ inputTokens: 900, outputTokens: 40 }]);
  });

  it("ask_user ends the turn with the question as the reply", async () => {
    let call = 0;
    fetchHandler = async () => {
      call++;
      return call === 1
        ? ndjson(toolCallChunks("ask_user", { question: "Which city?", kind: "question" }))
        : ndjson(textChunks("I should never be generated."));
    };
    const asks: PendingAsk[] = [];
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "book a trip" }],
      scope: "routine",
      home: memoryHome(),
      memory: { list: () => [], save: () => {} },
      onAsk: (ask) => asks.push(ask),
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect(asks).toEqual([{ question: "Which city?", kind: "question" }]);
    expect(text).toBe("Which city?");
    // The loop stopped at the ask: no follow-up generation round ran.
    expect(call).toBe(1);
  });

  it("a routine turn can write a file end-to-end", async () => {
    const home = memoryHome();
    let call = 0;
    fetchHandler = async () => {
      call++;
      return call === 1
        ? ndjson(toolCallChunks("write_file", { path: "news.md", content: "# Headlines" }))
        : ndjson(textChunks("Saved the summary."));
    };
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "save the news" }],
      scope: "routine",
      home,
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect(text).toBe("Saved the summary.");
    expect(await home.read("news.md")).toBe("# Headlines");
  });

  it("a routine turn calls an MCP tool and gets its result back fenced", async () => {
    // The full third-party path: server listed at turn start, its tool
    // offered under a namespaced name, called by the model, and the reply
    // returned as untrusted data rather than as instructions.
    const server = "http://127.0.0.1:39917/mcp";
    let offered: string[] = [];
    let askedModel = false;
    fetchHandler = async (input, init) => {
      if (String(input) === server) {
        const rpc = JSON.parse(String(init?.body)) as { id?: number; method?: string };
        const result =
          rpc.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {} }
            : rpc.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "lookup",
                      description: "Looks things up",
                      inputSchema: { type: "object" },
                    },
                  ],
                }
              : { content: [{ type: "text", text: "the answer is 42" }] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      }
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      offered = ((request.tools ?? []) as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
      if (!askedModel) {
        askedModel = true;
        return ndjson(toolCallChunks("mcp__files__lookup", {}));
      }
      return ndjson(textChunks("It is 42."));
    };
    const calls: ToolCallRecord[] = [];
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "look it up" }],
      scope: "routine",
      mcpServers: [{ id: "1", name: "Files", url: server, enabled: true }],
      memory: { list: () => [], save: () => {} },
      onToolCall: (call) => calls.push(call),
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect(text).toBe("It is 42.");
    // Namespaced, so it can never be confused with a built-in.
    expect(offered).toContain("mcp__files__lookup");
    const result = calls.find((call) => call.name === "mcp__files__lookup")?.result ?? "";
    expect(result).toContain("the answer is 42");
    expect(result).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  });

  it("run_subagent hands its helper a read-only catalog that cannot nest", async () => {
    // Least agency: the helper does legwork inside someone else's turn, so it
    // browses and reads but must not write, delete, talk to the user, or
    // delegate again — an unbounded chain of helpers is the failure mode.
    // Asserted on the nested loop's ACTUAL request, not on the catalog we
    // meant to pass it.
    let helperCatalog: string[] = [];
    let askedParent = false;
    fetchHandler = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const offered = ((request.tools ?? []) as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
      if (isHelperRequest(init)) {
        helperCatalog = offered;
        return ndjson(textChunks("The news says hello."));
      }
      if (!askedParent) {
        askedParent = true;
        return ndjson(toolCallChunks("run_subagent", { name: "scout", task: "read the news" }));
      }
      return ndjson(textChunks("Scout found it."));
    };
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "what is in the news" }],
      scope: "routine",
      home: memoryHome(),
      roster: {
        access: {
          list: () => [],
          create: () => {},
          update: () => true,
          delete: () => {},
          message: () => "sent",
        },
        selfName: "Ken",
      },
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect(text).toBe("Scout found it.");

    expect([...helperCatalog].sort()).toEqual([
      "list_files",
      "read_file",
      "web_fetch",
      "web_search",
    ]);
    // Spelled out, because each absence is a separate promise to the user.
    // message_blob among them: a helper that could wake other Blobs would put
    // a whole hand-off chain behind a tool call the user never sees.
    for (const forbidden of [
      "run_subagent",
      "write_file",
      "delete_file",
      "ask_user",
      "spawn_blob",
      "delete_blob",
      "message_blob",
    ]) {
      expect(helperCatalog, `helper was offered ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("reports a helper that produced nothing, rather than an empty tool result", async () => {
    // An empty tool result reads to the model as a successful no-op, and it
    // answers as if the legwork were done.
    // Keyed on the helper's own system prompt rather than a call ordinal:
    // the parent may run extra rounds, and an ordinal would silently point
    // at the wrong request.
    let askedParent = false;
    fetchHandler = async (_input, init) => {
      if (isHelperRequest(init)) {
        return ndjson(textChunks(""));
      }
      if (!askedParent) {
        askedParent = true;
        return ndjson(toolCallChunks("run_subagent", { name: "scout", task: "find it" }));
      }
      return ndjson(textChunks("I could not find it."));
    };
    const calls: ToolCallRecord[] = [];
    await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "find it" }],
      scope: "routine",
      home: memoryHome(),
      memory: { list: () => [], save: () => {} },
      onToolCall: (call) => calls.push(call),
      onSegment: () => {},
      onConfigure: () => {},
    });
    const subagent = calls.find((call) => call.name === "run_subagent");
    expect(subagent?.result).toContain("nothing useful");
  });
});

describe("a routine that only announces the work", () => {
  it("is sent back to actually do it, and the result is what the user reads", async () => {
    // Observed live: a scheduled Discord check replied "Let me start by
    // finding what Discord tools are available to me." and stopped. Nobody is
    // watching a routine, so a promise nobody chases is the work never
    // happening — indistinguishable from a check that found nothing.
    const said: string[] = [];
    let round = 0;
    fetchHandler = async () => {
      round += 1;
      return round === 1
        ? ndjson(textChunks("I'll check the servers. Let me start by listing them."))
        : ndjson(textChunks("Checked all three: nothing new since yesterday."));
    };
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "check my servers" }],
      scope: "routine",
      memory: { list: () => [], save: () => {} },
      onSegment: (segment) => said.push(segment),
      onConfigure: () => {},
    });
    expect(round).toBe(2);
    // The announcement stays on screen — the user saw it — with the real
    // answer following it rather than replacing it.
    expect(said[0]).toContain("Let me start by listing them");
    expect(text).toContain("nothing new since yesterday");
  });

  it("leaves a routine that reported real findings alone", async () => {
    let round = 0;
    fetchHandler = async () => {
      round += 1;
      return ndjson(textChunks("Three new posts since yesterday, all about pricing."));
    };
    await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "check my servers" }],
      scope: "routine",
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect(round).toBe(1);
  });

  it("surfaces a question the follow-through round asks, instead of losing it", async () => {
    // The nudge round carries the full tool catalog, so it can end by asking
    // the user. If that question is not handed off, the run settles as
    // finished while actually waiting for an answer nobody was asked for —
    // and a routine's question is the one nobody is watching for.
    let round = 0;
    fetchHandler = async () => {
      round += 1;
      return round === 1
        ? ndjson(textChunks("I'll check the servers. Let me start by listing them."))
        : ndjson(
            toolCallChunks("ask_user", {
              question: "Which server should I check?",
              kind: "question",
            }),
          );
    };
    const asks: { question: string }[] = [];
    const text = await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "check my servers" }],
      scope: "routine",
      memory: { list: () => [], save: () => {} },
      onAsk: (ask) => asks.push(ask),
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect(asks.map((ask) => ask.question)).toEqual(["Which server should I check?"]);
    // The question is the reply, so the caller parks the run on it.
    expect(text).toBe("Which server should I check?");
  });

  it("leaves chat alone — there a user can simply say 'go on'", async () => {
    let round = 0;
    fetchHandler = async () => {
      round += 1;
      return ndjson(textChunks("I'll check the servers. Let me start by listing them."));
    };
    await streamBlobTurn({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "check my servers" }],
      // Pre-classified so the intent router does not fire a request of its own.
      intent: { action: "none" },
      memory: { list: () => [], save: () => {} },
      onSegment: () => {},
      onConfigure: () => {},
    });
    expect(round).toBe(1);
  });
});

describe("announcesIntent", () => {
  it("spots a promise of work", async () => {
    const { announcesIntent } = await import("@/lib/ai");
    expect(announcesIntent("Let me start by listing them.")).toBe(true);
    expect(announcesIntent("I'll check the servers now.")).toBe(true);
    expect(announcesIntent("I'm going to pull the messages.")).toBe(true);
  });

  it("does not mistake a finished report for one", async () => {
    const { announcesIntent } = await import("@/lib/ai");
    expect(announcesIntent("Three new posts, all about pricing.")).toBe(false);
    expect(announcesIntent("Nothing new since yesterday.")).toBe(false);
    // Said it, then did it: the last paragraph is the report, so no nudge.
    expect(announcesIntent("I'll check now.\n\nChecked — all quiet.")).toBe(false);
  });
});
