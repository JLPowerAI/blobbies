import { describe, expect, it } from "vitest";
import { CORNERS, cornerKey, deal, MEMES } from "@/components/OnboardingMemes";

/**
 * The placement rules for the onboarding meme cards. These are properties of
 * many draws rather than of one, which is why they are tested against `deal`
 * directly: rendering the component gives you a single sample, and the whole
 * point is what happens over a run of steps.
 *
 * `deal` carries module state (the previous draw) by design, so these run in
 * sequence against a shared history — same as the real flow, where the history
 * is what survives the overlay being remounted on every step change.
 */
const DRAWS = 500;

describe("deal", () => {
  it("never repeats a corner or a meme back to back across next/back", () => {
    // The real sequence: the welcome screen deals four, then every later step
    // deals one, and going Back deals again — from the component's point of
    // view a step change is a fresh deal whichever direction it came from.
    deal(4);

    let previous = deal(1)[0];
    expect(previous).toBeDefined();

    for (let i = 0; i < DRAWS; i++) {
      const current = deal(1)[0];
      expect(current).toBeDefined();
      if (!current || !previous) {
        continue;
      }
      expect(cornerKey(current)).not.toBe(cornerKey(previous));
      expect(current.id).not.toBe(previous.id);
      previous = current;
    }
  });

  it("uses every corner and every meme", () => {
    const corners = new Set<string>();
    const memes = new Set<number>();

    for (let i = 0; i < DRAWS; i++) {
      for (const card of deal(1)) {
        corners.add(cornerKey(card));
        memes.add(card.id);
      }
    }

    expect(corners.size).toBe(CORNERS.length);
    expect(memes.size).toBe(MEMES.length);
  });

  it("fills all four corners with four distinct memes on the welcome screen", () => {
    const cards = deal(4);

    expect(cards).toHaveLength(4);
    expect(new Set(cards.map(cornerKey)).size).toBe(4);
    expect(new Set(cards.map((card) => card.id)).size).toBe(4);
  });

  it("gives every card a bundled GIF and a caption", () => {
    // A missing asset would still render — as an empty card with a punchline —
    // so nothing else in the suite would catch a rename of the GIF directory.
    for (const meme of MEMES) {
      expect(meme.src).not.toBe("");
      expect(meme.caption.length).toBeGreaterThan(0);
      expect(meme.emoji.length).toBeGreaterThan(0);
    }
  });
});
