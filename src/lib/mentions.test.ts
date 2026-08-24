import { describe, expect, it } from "vitest";
import type { Agent } from "@/data/agents";
import { mentionPalette, splitMentions } from "@/lib/mentions";

const blob = (name: string, tone: Agent["tone"]): Agent => ({
  id: name.toLowerCase(),
  name,
  time: "Now",
  snippet: "",
  tone,
  shape: "sphere",
});

const palette = mentionPalette([blob("Ann", "pink"), blob("Ann Reviewer", "blue")]);
const plain = (text: string) => splitMentions(text, palette).map((part) => part.text);
const marked = (text: string) =>
  splitMentions(text, palette)
    .filter((part) => part.colors !== undefined)
    .map((part) => part.text);

describe("splitMentions", () => {
  it("marks a mention and leaves the rest of the sentence alone", () => {
    expect(plain("hey @Ann look at this")).toEqual(["hey ", "@Ann", " look at this"]);
    expect(marked("hey @Ann look at this")).toEqual(["@Ann"]);
  });

  it("prefers the longest matching name", () => {
    // With "Ann" matched first, "@Ann Reviewer" would colour three letters and
    // leave the surname grey \u2014 and point at the wrong Blob's colour.
    expect(marked("@Ann Reviewer please check")).toEqual(["@Ann Reviewer"]);
  });

  it("keeps the writer's capitalisation", () => {
    expect(marked("@ANN and @ann")).toEqual(["@ANN", "@ann"]);
  });

  it("colours @everyone, which belongs to no Blob", () => {
    const [part] = splitMentions("@everyone standup", palette);
    expect(part?.text).toBe("@everyone");
    expect(part?.colors).not.toEqual(palette.get("ann")?.colors);
  });

  it("ignores an @ that addresses nobody", () => {
    // Highlighting must match who actually gets woken (`parseMentions`), or
    // it teaches the user the wrong thing about who is being addressed.
    for (const text of ["mail ann@reviewer.example", "@Annabel is out", "read @docs"]) {
      expect(marked(text), text).toEqual([]);
    }
  });

  it("never lets a blank name swallow every @ in the transcript", () => {
    // "".startsWith at any offset is true, so an unnamed Blob in the palette
    // would paint the whole conversation in its colour.
    const blank = mentionPalette([blob("Ann", "pink"), { ...blob("x", "blue"), name: " " }]);
    expect(splitMentions("@Ann and @Zed and plain @", blank).filter((p) => p.colors)).toHaveLength(
      1,
    );
  });

  it("highlights nothing rather than mis-slicing text that lowercases longer", () => {
    // "\u0130".toLowerCase() is two code units, and the scan shares indices
    // between the original and the lowercased copy — off-by-one there would
    // cut the user's message mid-word.
    const text = "\u0130stanbul \u2014 @Ann take it";
    expect(splitMentions(text, palette)).toEqual([{ text }]);
  });

  it("colours a half-typed name in the composer, once one Blob can complete it", () => {
    // "@ann r" can only become Ann Reviewer, so the colour arrives with the
    // word instead of on its final character.
    const [part] = splitMentions("@ann r", palette, { partial: true });
    expect(part?.text).toBe("@ann r");
    expect(part?.colors).toEqual(palette.get("ann reviewer")?.colors);
  });

  it("falls back to the exact name when a partial is ambiguous", () => {
    // "@ann" could still become Ann Reviewer, but it is already a real mention
    // of Ann — so it is coloured as Ann, not left grey.
    expect(splitMentions("@ann", palette, { partial: true })[0]?.colors).toEqual(
      palette.get("ann")?.colors,
    );
  });

  it("never treats a partial as a mention outside the composer", () => {
    // Half a name that is nobody's whole name: coloured while being typed,
    // grey once sent, because a stored message addresses nobody with it.
    const solo = mentionPalette([blob("Social Blob", "pink")]);
    expect(splitMentions("@soc", solo, { partial: true })[0]?.colors).toBeDefined();
    expect(splitMentions("@soc", solo)[0]?.colors).toBeUndefined();
  });

  it("stops a composer partial at the caret, not mid-sentence", () => {
    // Text follows, so the user moved on: only the real mention it contains
    // is coloured, and never the trailing prose with it.
    expect(
      splitMentions("@ann r and more", palette, { partial: true }).filter((p) => p.colors),
    ).toEqual([{ text: "@ann", colors: palette.get("ann")?.colors }]);
  });

  it("returns one plain part when there is nothing to highlight", () => {
    // The hot path: every bubble, every streamed delta.
    expect(splitMentions("no mentions here", palette)).toEqual([{ text: "no mentions here" }]);
  });

  it("gives each Blob its own pair of theme colours", () => {
    const ann = palette.get("ann")?.colors;
    expect(ann?.onLight).not.toBe(ann?.onDark);
    expect(palette.get("ann reviewer")?.colors.onLight).not.toBe(ann?.onLight);
  });

  it("carries each Blob's avatar, so a mention can show its face", () => {
    // The same tone and shape the sidebar draws: one Blob, one look, rather
    // than a second palette to keep in sync.
    expect(palette.get("ann")?.avatar).toEqual({ tone: "pink", shape: "sphere" });
    // @everyone is the room, not a member — no face to show, colours only.
    expect(palette.get("everyone")?.avatar).toBeUndefined();
    expect(palette.get("everyone")?.colors).toBeDefined();
  });

  it("attaches the avatar to a finished mention, never to one being typed", () => {
    const [mention] = splitMentions("@Ann look", palette);
    expect(mention?.avatar).toEqual({ tone: "pink", shape: "sphere" });

    // The composer mirror sits behind the textarea and has to stay
    // character-identical to it; an avatar there would shift every glyph after
    // it out from under the real caret.
    const [typing] = splitMentions("@ann r", palette, { partial: true });
    expect(typing?.colors).toBeDefined();
    expect(typing?.avatar).toBeUndefined();
  });
});
