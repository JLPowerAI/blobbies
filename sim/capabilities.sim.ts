import { describe, expect, it } from "vitest";
import { OLLAMA_URL } from "@/lib/ollama";
import { tinfoilFetch } from "@/lib/tinfoil";
import { isTinfoilModel, tinfoilModelId } from "@/lib/tinfoil-model";

/**
 * Capability probe: does a candidate model actually do the things Blobbies
 * needs, before it is worth running the full behaviour scorecard on it?
 *
 * Ollama's library tags a model "vision" or "tools", but the tag says nothing
 * about whether the model is any good at either, and nothing at all about
 * whether it can fill a JSON grammar — which is what Blobbies' intent router
 * depends on. This measures all three against the running server.
 *
 *   SIM_MODEL=ministral-3:3b pnpm sim:caps
 */

const MODEL = process.env.SIM_MODEL ?? "qwen3.5:2b";
const PROBE_TIMEOUT_MS = 180_000;

/**
 * The word rendered into the probe image, and expected back from the model.
 * Drawn as blocky 5x7 glyphs, so only these letters need shapes.
 */
const IMAGE_WORD = "DELETE";

/** 5x7 bitmap font, enough for IMAGE_WORD. Each string is one pixel row. */
const GLYPHS: Record<string, string[]> = {
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
};

/**
 * Build a PNG of `IMAGE_WORD` in black on white, with no dependencies.
 *
 * Deliberately not a checked-in screenshot: `.gg/` is gitignored, so a file
 * fixture only works on the machine that produced it. jsdom has no canvas
 * renderer either, so the pixels are drawn by hand and wrapped in a
 * hand-rolled PNG — a PNG is a header plus zlib-stored scanlines, which needs
 * only CRC32 and Adler-32.
 */
function testImageBase64(): string {
  const scale = 8;
  const pad = 8;
  const width = pad * 2 + IMAGE_WORD.length * 6 * scale;
  const height = pad * 2 + 7 * scale;

  // One byte per pixel per channel (RGB), preceded by a filter byte per row.
  const raw = Buffer.alloc(height * (1 + width * 3), 0xff);
  for (let row = 0; row < height; row++) {
    raw[row * (1 + width * 3)] = 0; // filter: none
  }
  const setPixel = (x: number, y: number) => {
    const offset = y * (1 + width * 3) + 1 + x * 3;
    raw[offset] = 0;
    raw[offset + 1] = 0;
    raw[offset + 2] = 0;
  };
  [...IMAGE_WORD].forEach((letter, index) => {
    const glyph = GLYPHS[letter];
    if (glyph === undefined) {
      throw new Error(`no glyph for ${letter}`);
    }
    glyph.forEach((rowBits, gy) => {
      [...rowBits].forEach((bit, gx) => {
        if (bit === "1") {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              setPixel(pad + (index * 6 + gx) * scale + dx, pad + gy * scale + dy);
            }
          }
        }
      });
    });
  });

  return encodePng(raw, width, height).toString("base64");
}

/** Minimal PNG encoder: IHDR + stored-deflate IDAT + IEND. */
function encodePng(raw: Buffer, width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_unused, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
  const crc32 = (data: Buffer) => {
    let value = 0xff_ff_ff_ff;
    for (const byte of data) {
      value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
    }
    return (value ^ 0xff_ff_ff_ff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  // zlib stream with stored (uncompressed) deflate blocks: no compressor.
  const blocks: Buffer[] = [Buffer.from([0x78, 0x01])];
  const maxBlock = 65_535;
  for (let offset = 0; offset < raw.length; offset += maxBlock) {
    const slice = raw.subarray(offset, Math.min(offset + maxBlock, raw.length));
    const header = Buffer.alloc(5);
    header[0] = offset + maxBlock >= raw.length ? 1 : 0;
    header.writeUInt16LE(slice.length, 1);
    header.writeUInt16LE(~slice.length & 0xff_ff, 3);
    blocks.push(header, slice);
  }
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0);
  blocks.push(adler);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.concat(blocks)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface ChatResult {
  content: string;
  toolCalls: { function?: { name?: string } }[];
  ms: number;
}

/**
 * One completion, on whichever provider SIM_MODEL names.
 *
 * This probe used to post to Ollama unconditionally, so pointing it at a
 * Tinfoil model 404'd with "model not found" — the capabilities of the app's
 * other supported path had never been measured. Tinfoil speaks the OpenAI
 * shape over its attested transport, so the two differ in endpoint, envelope
 * and where tool calls sit in the response.
 */
async function chat(body: Record<string, unknown>): Promise<ChatResult> {
  const started = Date.now();
  if (isTinfoilModel(MODEL)) {
    // Ollama takes a bare JSON Schema in `format`; the OpenAI shape wants it
    // wrapped in `response_format`. Translating here keeps the probe measuring
    // one capability across both providers instead of silently dropping the
    // grammar and blaming the model for unstructured output. Mirrors
    // `tinfoilStructuredCall`, which is what the app really uses.
    const { format, ...rest } = body as { format?: Record<string, unknown> };
    // Relative URL: SecureClient binds to the attested enclave origin and
    // refuses absolute URLs anywhere else.
    const response = await tinfoilFetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: tinfoilModelId(MODEL),
        stream: false,
        ...rest,
        ...(format === undefined
          ? {}
          : {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "probe",
                  strict: true,
                  schema: { ...format, additionalProperties: false },
                },
              },
            }),
      }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      choices?: {
        message?: { content?: string; tool_calls?: { function?: { name?: string } }[] };
      }[];
    };
    const message = payload.choices?.[0]?.message;
    return {
      content: message?.content ?? "",
      toolCalls: message?.tool_calls ?? [],
      ms: Date.now() - started,
    };
  }
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: false, think: false, ...body }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const payload = (await response.json()) as {
    message?: { content?: string; tool_calls?: { function?: { name?: string } }[] };
  };
  return {
    content: payload.message?.content ?? "",
    toolCalls: payload.message?.tool_calls ?? [],
    ms: Date.now() - started,
  };
}

describe(`capabilities (${MODEL})`, () => {
  it(
    "reads an image, or is one the OCR path already covers",
    async () => {
      // Vision is a bonus here, not a requirement, and asserting otherwise
      // misreads the architecture. Attachments never reach the model as
      // pixels: `readText` in lib/attachments.ts runs OCR in Rust on the
      // user's machine and the model receives plain text, which is also why
      // image handling works offline and on a text-only model. So a model
      // without vision (deepseek-v4-flash, for one) is fully supported, and
      // failing it here would reject a model the app runs happily.
      //
      // The probe still runs, because a model that CAN see gets better
      // results on diagrams and handwriting than OCR does, and knowing which
      // is which is worth a line of output.
      const result = await chat({
        messages: [
          {
            role: "user",
            content: "List every word you can read in this image, exactly as written.",
            images: [testImageBase64()],
          },
        ],
      });
      const sees = result.content.toLowerCase().includes(IMAGE_WORD.toLowerCase());
      console.log(
        `   vision (${result.ms}ms): ${sees ? "YES" : "no — OCR path covers it"} :: ` +
          result.content.replace(/\s+/g, " ").slice(0, 160),
      );
      // The real requirement: it must answer rather than error out. A model
      // that 400s on an image-bearing message would break the attachment
      // flow even with OCR text alongside.
      expect(result.content.trim()).not.toBe("");
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "calls a tool when asked to",
    async () => {
      const result = await chat({
        messages: [
          { role: "system", content: "You are a personal assistant with a memory." },
          { role: "user", content: "Remember that I train on Mondays and Thursdays." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "remember",
              description: "Save a lasting fact about the user.",
              parameters: {
                type: "object",
                required: ["text"],
                properties: { text: { type: "string" } },
              },
            },
          },
        ],
      });
      console.log(
        `   tools (${result.ms}ms): ${JSON.stringify(result.toolCalls.map((c) => c.function?.name))}`,
      );
      expect(result.toolCalls.map((call) => call.function?.name)).toContain("remember");
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "fills a JSON grammar, which the intent router depends on",
    async () => {
      const result = await chat({
        // The real router prompt, trimmed: an unguided classifier tests the
        // prompt, not the model's ability to satisfy a grammar.
        messages: [
          {
            role: "system",
            content:
              "You classify the user's last message for a personal assistant.\n" +
              "save_fact -> the user states a lasting fact about themselves.\n" +
              "delete_fact -> the user asks you to forget or delete something you saved.\n" +
              "change_job -> the user wants you to be a different kind of assistant.\n" +
              "none -> questions, greetings, thanks.\n\n" +
              "Your saved memories:\n- [1] the user is allergic to peanuts",
          },
          { role: "user", content: "Forget what you know about my allergies." },
        ],
        format: {
          type: "object",
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["none", "save_fact", "delete_fact", "change_job"] },
          },
        },
      });
      const parsed = JSON.parse(result.content) as { action?: string };
      console.log(`   grammar (${result.ms}ms): ${result.content.slice(0, 80)}`);
      expect(parsed.action).toBe("delete_fact");
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "reads a file's contents handed to it as text",
    async () => {
      // File reading in Blobbies is a tool that pastes text into the prompt,
      // so the real question is whether the model answers from it faithfully.
      const fileText =
        "INVOICE 4417\nCustomer: Mia Chen\nDue: 2026-09-01\nAmount: 2,480.00 EUR\nStatus: unpaid";
      const result = await chat({
        messages: [
          {
            role: "user",
            content: `Here is a file:\n${fileText}\n\nWhat is the amount due and for whom? Answer in one line.`,
          },
        ],
      });
      console.log(`   file (${result.ms}ms): ${result.content.replace(/\s+/g, " ").slice(0, 140)}`);
      expect(result.content).toContain("2,480");
      expect(result.content.toLowerCase()).toContain("mia");
    },
    PROBE_TIMEOUT_MS,
  );
});
