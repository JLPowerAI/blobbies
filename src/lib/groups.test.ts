import { describe, expect, it } from "vitest";
import type { Agent } from "@/data/agents";
import {
  addressedResponders,
  groupConversationId,
  groupIdFromConversation,
  handoffTarget,
  isPass,
  namedResponders,
  owesAnswer,
  parseMentions,
  stripSelfMention,
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

describe("owesAnswer", () => {
  it("obliges the only Blob picked, not just the one addressed by name", () => {
    // PASS means "a colleague has this". With one Blob picked there is no
    // colleague, so a pass answers a direct question with silence — measured
    // on qwen3.5:2b, 3 of 5 runs on "what did hosting cost last month?".
    expect(owesAnswer({ addressed: false, pickedCount: 1 })).toBe(true);
    expect(owesAnswer({ addressed: true, pickedCount: 3 })).toBe(true);
    // Both at once is the ordinary case when the user names one Blob.
    expect(owesAnswer({ addressed: true, pickedCount: 1 })).toBe(true);
  });

  it("lets an unaddressed Blob stay out when colleagues were picked too", () => {
    // The behaviour this whole design protects: three "sounds good!" lines
    // under one answer is the noise the router exists to prevent.
    expect(owesAnswer({ addressed: false, pickedCount: 2 })).toBe(false);
    expect(owesAnswer({ addressed: false, pickedCount: 6 })).toBe(false);
    // Nobody picked: there is no turn to oblige, and the caller reports it.
    expect(owesAnswer({ addressed: false, pickedCount: 0 })).toBe(false);
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

describe("stripSelfMention", () => {
  it("drops a Blob signing its own name, in the shapes small models produce", () => {
    // Measured against qwen3.5:2b, which does this 3/3 no matter how the
    // prompt rule is worded — hence the code path.
    expect(stripSelfMention("@Ken I'll total those receipts.", "Ken")).toBe(
      "I'll total those receipts.",
    );
    expect(stripSelfMention("Ken: on it.", "Ken")).toBe("on it.");
    expect(stripSelfMention("@Ken — on it.", "Ken")).toBe("on it.");
    // Case-insensitive, since a model capitalises how it likes.
    expect(stripSelfMention("@ken here you go", "Ken")).toBe("here you go");
  });

  it("drops a sign-off at the end, where a 9b model puts it", () => {
    // Observed on qwen3.5:9b in the group sim: "Hi Ken! ... today? @Scout".
    expect(stripSelfMention("Ready to help. How can I assist today? @Scout", "Scout")).toBe(
      "Ready to help. How can I assist today?",
    );
    expect(stripSelfMention("What's on the agenda? @Quill", "Quill")).toBe("What's on the agenda?");
    // A trailing colleague mention is the hand-off this design runs on —
    // `handoffTarget` reads it, so eating it would silently stop the work.
    expect(stripSelfMention("Done — over to you. @Quill", "Scout")).toBe(
      "Done — over to you. @Quill",
    );
  });

  it("never eats a real hand-off or a lookalike name", () => {
    // handoffTarget reads a sentence-opening mention as "wake that Blob", so
    // a wrongly-stripped colleague mention would silently drop the hand-off
    // this whole design exists to make visible.
    expect(stripSelfMention("@Quill can you draft it?", "Ken")).toBe("@Quill can you draft it?");
    // Prefix of the Blob's own name: a different person entirely.
    expect(stripSelfMention("@Kendra has the file.", "Ken")).toBe("@Kendra has the file.");
    // The name mid-sentence is the Blob being talked about, not a signature.
    expect(stripSelfMention("Ask Ken about the invoice.", "Ken")).toBe(
      "Ask Ken about the invoice.",
    );
  });

  it("leaves a bare name that is part of the sentence", () => {
    // The first version of this stripped any leading name and corrupted all
    // three: a Blob talking about itself is not a Blob signing itself. Only a
    // separator after the name makes it a signature.
    expect(stripSelfMention("Ken's report is ready.", "Ken")).toBe("Ken's report is ready.");
    expect(stripSelfMention("Ken and Quill agree.", "Ken")).toBe("Ken and Quill agree.");
    expect(stripSelfMention("Ken? I think so.", "Ken")).toBe("Ken? I think so.");
  });

  it("keeps the reply when the name is all there is", () => {
    // A blank bubble is more confusing than a stray signature, and an empty
    // string here would be dropped as "nothing said".
    expect(stripSelfMention("@Ken", "Ken")).toBe("@Ken");
    // A Blob with no name configured cannot match anything.
    expect(stripSelfMention("@Ken hello", "  ")).toBe("@Ken hello");
  });

  it("treats a name with regex characters as literal text", () => {
    // Blob names come from user-editable config and reach a RegExp. `\b`
    // would never match after the `+`, silently disabling the strip for this
    // Blob; the lookahead does.
    expect(stripSelfMention("@C++ done.", "C++")).toBe("done.");
    // `.` must not act as "any character": `a.c` is a name, not a pattern.
    expect(stripSelfMention("@a.c hello", "a.c")).toBe("hello");
    expect(stripSelfMention("@abc hello", "a.c")).toBe("@abc hello");
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

  it("treats a question asked of the room as addressing all of it, @ or not", () => {
    // The reported failure: "anything cool I should know about everyone?" went
    // to the router as an ordinary question, which picks a few — and then the
    // group prompt's first PASS rule ("a colleague already answered it")
    // silenced every one of them but the first. A question asked of the room
    // came back as one reply and a "stayed out" note naming the rest.
    expect(
      addressedResponders(members, { text: "anything cool I should know about everyone?" }),
    ).toEqual(members);
    expect(addressedResponders(members, { text: "what's each of you working on?" })).toEqual(
      members,
    );
    expect(addressedResponders(members, { text: "any updates from you all?" })).toEqual(members);
  });

  it("leaves a room word that is not addressing the room to the router", () => {
    // Six serial turns on one local model is what a false positive costs, so
    // the word alone is not enough — it has to be the room being spoken to.
    expect(addressedResponders(members, { text: "everyones invited" })).toBeNull();
    expect(addressedResponders(members, { text: "does anyone know the price?" })).toBeNull();
    expect(addressedResponders(members, { text: "mail everyone@example.com" })).toBeNull();
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

  it("obliges every member when the room was asked without an @", () => {
    // Being brought in is an invitation; being asked is not. Without this the
    // members the router picked may each answer PASS — which is how a question
    // put to the room ends in one reply and three Blobs staying out.
    expect(namedResponders(members, { text: "what is everyone up to?" }).size).toBe(members.length);
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
