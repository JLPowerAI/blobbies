import { describe, expect, it } from "vitest";
import type { Agent } from "@/data/agents";
import {
  addressedResponders,
  groupConversationId,
  groupIdFromConversation,
  handoffTarget,
  isPass,
  namedResponders,
  parseMentions,
} from "@/lib/groups";

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
const ann = blob("c", "Ann");
const members = [researcher, writer, ann];

describe("parseMentions", () => {
  it("finds mentions in the order they were written", () => {
    const found = parseMentions("@Writer take this from @Researcher", members);
    expect(found.ids).toEqual([writer.id, researcher.id]);
    expect(found.everyone).toBe(false);
  });

  it("matches a name case-insensitively, and only as a whole name", () => {
    // "Anna" must not resolve to Ann: the group would get the wrong member,
    // silently, with no way for the user to tell.
    expect(parseMentions("@anna said hi", members).ids).toEqual([]);
    expect(parseMentions("@ANN said hi", members).ids).toEqual([ann.id]);
  });

  it("ignores an @ inside a word, so an email address is not a mention", () => {
    expect(parseMentions("mail ann@writer.example", members).ids).toEqual([]);
  });

  it("reads @everyone as the whole group", () => {
    expect(parseMentions("@everyone standup in 5", members).everyone).toBe(true);
  });
});

describe("isPass", () => {
  it("reads the bare token as declining, however the model decorates it", () => {
    for (const said of ["PASS", "pass", "**PASS**", "PASS.", "\u201CPASS\u201D", " pass "]) {
      expect(isPass(said), said).toBe(true);
    }
  });

  it("reads a token plus a reason as declining too", () => {
    // Measured on qwen3.5:2b, which reliably explains itself: "I also don't
    // know" from three colleagues is exactly the noise this removes.
    for (const said of [
      "PASS - I don't have that info either.",
      "Pass. Ledger owns the invoices.",
      "PASS \u2014 nothing to add.",
    ]) {
      expect(isPass(said), said).toBe(true);
    }
  });

  it("never swallows a real reply that happens to contain the word", () => {
    // Dropping a real reply is far worse than showing a stray "PASS": the
    // user can see the latter, but never sees what was silently deleted.
    for (const said of [
      "PASS the file to Ann",
      "I'll pass on this one because the budget is fixed",
      "Passing it over now",
      "",
    ]) {
      expect(isPass(said), said).toBe(false);
    }
  });
});

describe("handoffTarget", () => {
  const nobody = new Set<string>();

  it("wakes the teammate a reply hands the next step to", () => {
    expect(handoffTarget("Sources are in. @Writer draft it.", members, nobody)).toBe(writer);
  });

  it("ignores a teammate the reply merely talks about", () => {
    // Measured in sim:group — a Blob answering a question wrote exactly this
    // shape and woke two teammates who had nothing to add.
    expect(
      handoffTarget(
        "14th. I noted that @Ann will not attend and @Writer confirmed.",
        members,
        nobody,
      ),
    ).toBeNull();
  });

  it("hands to one teammate only, so a reply cannot fan out", () => {
    expect(handoffTarget("@Writer draft it. @Ann review it.", members, nobody)).toBe(writer);
  });

  it("skips a Blob that already spoke, so an exchange terminates", () => {
    expect(handoffTarget("@Writer take it back.", members, new Set([writer.id]))).toBeNull();
  });
});

describe("addressedResponders", () => {
  it("returns null when nobody was addressed, so the caller must decide", () => {
    // Not "everyone": each responder is a serial turn on one local model, so
    // who answers an open question is a judgement the router makes.
    expect(addressedResponders(members, { text: "where are we?" })).toBeNull();
  });

  it("narrows to the mentioned members, in mention order", () => {
    expect(addressedResponders(members, { text: "@Writer then @Ann" })).toEqual([writer, ann]);
  });

  it("answers a reply with the Blob that was replied to", () => {
    expect(addressedResponders(members, { text: "say more", replyToAuthorId: ann.id })).toEqual([
      ann,
    ]);
  });

  it("lets an explicit mention win over the reply target", () => {
    expect(
      addressedResponders(members, { text: "@Researcher check this", replyToAuthorId: ann.id }),
    ).toEqual([researcher]);
  });

  it("expands @everyone back to all members", () => {
    expect(addressedResponders(members, { text: "@everyone ship it" })).toEqual(members);
  });
});

describe("namedResponders", () => {
  it("names only the Blobs singled out, by mention or by reply", () => {
    expect([...namedResponders(members, { text: "@Writer draft it" })]).toEqual([writer.id]);
    expect([...namedResponders(members, { text: "more", replyToAuthorId: ann.id })]).toEqual([
      ann.id,
    ]);
  });

  it("treats @everyone as addressing every member", () => {
    // Asking the room and being answered with silence is not an answer. The
    // risk is a chorus of near-identical replies, and the cure for that is
    // the prompt telling each to add what the others did not — not the app
    // deciding the user did not mean what they typed.
    expect(namedResponders(members, { text: "@everyone ship it" }).size).toBe(members.length);
  });

  it("names nobody when the message addresses nobody", () => {
    expect(namedResponders(members, { text: "where are we?" }).size).toBe(0);
  });
});

describe("conversation ids", () => {
  it("round-trips a group id and leaves a Blob id alone", () => {
    const id = groupConversationId("abc");
    expect(groupIdFromConversation(id)).toBe("abc");
    expect(groupIdFromConversation("abc")).toBeNull();
  });
});
