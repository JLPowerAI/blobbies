import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Agent, Message } from "@/data/agents";
import { createAcpAgent } from "@/lib/acp/host";
import { publishConversation } from "@/lib/conversation-bus";
import type { Group } from "@/lib/groups";

/**
 * End-to-end check of the editor bridge, minus the window.
 *
 * Everything an editor touches is real here: the shipped `blobbies-acp`
 * binary, its token handshake, the newline framing, the SDK on both ends, and
 * `host.ts` driving scripted app callbacks. Only Tauri's own listener and the
 * webview's event relay are stood in for — a Node socket plays `acp.rs`.
 *
 * This is the check that catches what unit tests cannot: a relay that drops a
 * frame, a handshake that hangs, a prompt that never resolves over a real
 * pipe. It needs no model and no GUI.
 *
 *   pnpm acp:relay && pnpm sim:acp
 */

// jsdom gives `import.meta.url` an http origin, so the path is resolved from
// the working directory instead — vitest runs from the repo root.
const RELAY = join(process.cwd(), "src-tauri", "target", "release", "blobbies-acp");
const TOKEN = "b".repeat(64);

const researcher: Agent = {
  id: "blob-a",
  name: "Researcher",
  time: "Now",
  snippet: "",
  tone: "blue",
  shape: "sphere",
};
const studio: Group = { id: "g1", name: "Studio" };

/** What the scripted app was asked to do. */
const sent: { to: string; text: string }[] = [];
const stopped: string[] = [];

/** Stand-in for `acp.rs`: check the token, then relay frames to the host. */
function hostServer(): Promise<{ server: Server; home: string }> {
  const app = createAcpAgent({
    roster: () => [researcher],
    groups: () => [studio],
    transcript: (): Message[] => [],
    sendToBlob: (blob, text) => {
      sent.push({ to: blob.id, text });
    },
    sendToGroup: (group, text) => {
      sent.push({ to: `group:${group.id}`, text });
    },
    stop: (id) => {
      stopped.push(id);
    },
    defaultBlob: () => researcher,
  });

  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      let authenticated = false;
      let buffer = "";
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index = buffer.indexOf("\n");
        while (index !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!authenticated) {
            if (line.trim() !== TOKEN) {
              socket.destroy();
              return;
            }
            authenticated = true;
          } else if (line.trim() !== "") {
            void writer.write(new TextEncoder().encode(`${line}\n`));
          }
          index = buffer.indexOf("\n");
        }
      });
      const outbound = new WritableStream<Uint8Array>({
        write(chunk) {
          socket.write(chunk);
        },
      });
      app.connect(ndJsonStream(outbound, stream.readable));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      // The relay finds its port and token exactly where the app writes them.
      const home = join(tmpdir(), `blobbies-acp-sim-${process.pid}`);
      mkdirSync(join(home, ".blobbies"), { recursive: true });
      writeFileSync(
        join(home, ".blobbies", "acp.json"),
        JSON.stringify({ port: address.port, token: TOKEN }),
      );
      resolve({ server, home });
    });
  });
}

const available = existsSync(RELAY);
const suite = available ? describe : describe.skip;

let server: Server;
let home: string;
let relay: ReturnType<typeof spawn>;
let session: ReturnType<typeof connectClient>;

/** A real ACP client speaking over the relay's stdio, as an editor does. */
function connectClient(child: ReturnType<typeof spawn>) {
  const updates: string[] = [];
  const app = acpClient().onNotification("session/update", ({ params }) => {
    const update = params.update;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      updates.push(update.content.text);
    }
  });
  let open = true;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      // Teardown closes the connection and kills the relay, in that order or
      // the other; either way the stream may already be finished when the
      // remaining half notices, and touching a closed controller throws.
      child.stdout?.on("data", (chunk: Buffer) => {
        if (open) {
          controller.enqueue(new Uint8Array(chunk));
        }
      });
      child.stdout?.on("end", () => {
        if (open) {
          open = false;
          controller.close();
        }
      });
    },
    cancel() {
      open = false;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      child.stdin?.write(chunk);
    },
  });
  const connection = app.connect(ndJsonStream(writable, readable));
  return { updates, agent: connection.agent, close: () => connection.close() };
}

beforeAll(async () => {
  if (!available) {
    return;
  }
  ({ server, home } = await hostServer());
  relay = spawn(RELAY, [], { env: { ...process.env, HOME: home }, stdio: "pipe" });
  session = connectClient(relay);
});

afterAll(() => {
  relay?.kill();
  session?.close();
  server?.close();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

suite("an editor talking to Blobbies through the shipped relay", () => {
  it("completes the handshake and opens a session on a Blob", async () => {
    const initialized = await session.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initialized.agentInfo?.name).toBe("Blobbies");

    const opened = await session.agent.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    });
    expect(opened.sessionId).toBe("blob-a");
  });

  it("carries a prompt to the Blob and its reply back", async () => {
    const prompt = session.agent.request("session/prompt", {
      sessionId: "blob-a",
      prompt: [{ type: "text", text: "what is the plan?" }],
    });
    await settle();
    expect(sent).toContainEqual({ to: "blob-a", text: "what is the plan?" });

    publishConversation("blob-a", { type: "segment", blobId: "blob-a", text: "Looking now." });
    publishConversation("blob-a", { type: "exchange_end", outcome: "done" });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(session.updates).toContain("Looking now.");
  });

  it("talks to a group, naming each speaker", async () => {
    const opened = await session.agent.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { "blobbies/target": "group:g1" },
    });
    expect(opened.sessionId).toBe("group:g1");

    const prompt = session.agent.request("session/prompt", {
      sessionId: "group:g1",
      prompt: [{ type: "text", text: "status?" }],
    });
    await settle();
    expect(sent).toContainEqual({ to: "group:g1", text: "status?" });

    publishConversation("group:g1", { type: "segment", blobId: "blob-a", text: "Drafting." });
    publishConversation("group:g1", { type: "exchange_end", outcome: "done" });
    await prompt;
    expect(session.updates).toContain("**Researcher:** Drafting.");
  });

  it("cancels a running turn", async () => {
    const prompt = session.agent.request("session/prompt", {
      sessionId: "blob-a",
      prompt: [{ type: "text", text: "long job" }],
    });
    await settle();
    await session.agent.notify("session/cancel", { sessionId: "blob-a" });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(stopped).toContain("blob-a");
  });
});
