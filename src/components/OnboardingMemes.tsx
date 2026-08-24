import { useEffect, useMemo, useState } from "react";

/**
 * Decoration for the first-run flow: blob memes in the window's corners,
 * swapped every few seconds.
 *
 * Captions have to stay true as well as funny — a joke about the product that
 * misdescribes it is just a wrong claim on the first screen. Hence "local
 * model" and the tinfoil hat rather than "no cloud": the default is a model on
 * this machine, and the cloud option is Tinfoil's sealed hardware.
 *
 * The GIFs are bundled rather than fetched, for two reasons: the app's CSP
 * only allows `img-src 'self'`, and a first run is exactly when a machine may
 * have no network — a row of broken images is a worse first impression than
 * no images at all.
 *
 * Every card also carries an emoji and a caption. The caption is the joke; the
 * emoji is the fallback if the GIF itself fails to decode, so a dead file
 * leaves a card with a punchline instead of a hole.
 */
interface Meme {
  id: number;
  src: string;
  emoji: string;
  caption: string;
}

// Eager glob so Vite emits every GIF as a hashed same-origin asset — which is
// what keeps them inside `img-src 'self'`.
const gifs = import.meta.glob("../assets/onboarding-memes/*.gif", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const gif = (id: number): string => gifs[`../assets/onboarding-memes/${id}.gif`] ?? "";

/**
 * The pool. Captions stay short — a card is a glance, not a paragraph — and
 * they all tell the same joke from different angles: the thing that keeps your
 * data private is a soft idiot living on your laptop.
 */
export const MEMES: Meme[] = [
  { id: 1, src: gif(1), emoji: "🍿", caption: "Reads your email. For fun." },
  { id: 2, src: gif(2), emoji: "👀", caption: "No telemetry. Still judging." },
  { id: 3, src: gif(3), emoji: "🧱", caption: "Local model. Local problems." },
  { id: 4, src: gif(4), emoji: "👅", caption: "Won't sell your data. Licks it." },
  { id: 5, src: gif(5), emoji: "😎", caption: "Offline and smug about it." },
  { id: 6, src: gif(6), emoji: "🕺", caption: "Nobody got the data. We dance." },
  { id: 7, src: gif(7), emoji: "👻", caption: "Ate your inbox. And the plate." },
  { id: 8, src: gif(8), emoji: "🟣", caption: "Runs locally. Thinks slowly." },
  { id: 9, src: gif(9), emoji: "🍖", caption: "Its cloud wears a tinfoil hat." },
  { id: 10, src: gif(10), emoji: "🫠", caption: "Data at rest. Blob at rest." },
  { id: 11, src: gif(11), emoji: "🤐", caption: "Signed an NDA with itself." },
  { id: 12, src: gif(12), emoji: "🥂", caption: "Deleted cookies. Kept the wine." },
  { id: 13, src: gif(13), emoji: "🫥", caption: "Secrets safe. It forgot them." },
  { id: 14, src: gif(14), emoji: "🛋️", caption: "Sealed in hardware. Cosy in there." },
  { id: 15, src: gif(15), emoji: "🍪", caption: "Wants cookies. Not those ones." },
  { id: 16, src: gif(16), emoji: "🥔", caption: "Understood nothing. Agreed." },
  { id: 17, src: gif(17), emoji: "🫧", caption: "Small model. Big feelings." },
  { id: 18, src: gif(18), emoji: "📵", caption: "Read receipts off. Forever." },
];

/**
 * Cards are placed one per corner, so two can never stack whatever the window
 * size — the alternative, random points with collision checks, is a lot of
 * arithmetic to arrive at the same four places.
 *
 * The top row sits below the traffic lights (y 12–34 in a 22px-inset title
 * bar), which are drawn over this same overlay.
 */
export const CORNERS = [
  { v: "top", h: "left" },
  { v: "top", h: "right" },
  { v: "bottom", h: "left" },
  { v: "bottom", h: "right" },
] as const;

interface Placed extends Meme {
  v: "top" | "bottom";
  h: "left" | "right";
  rotate: number;
}

/**
 * The last corner a single card used, and the memes that were on screen with
 * it. Module state, not a ref, because the overlay is remounted on every step
 * change and a ref would reset with it — which is exactly when a repeat is
 * most obvious: Next, and the card lands where it already was.
 */
let lastCorners: string[] = [];
let lastMemeIds: number[] = [];

export const cornerKey = (corner: { v: string; h: string }) => `${corner.v}-${corner.h}`;

/**
 * Fisher-Yates, not `sort(() => Math.random() - 0.5)`: that idiom is biased,
 * and over a few hundred deals it visibly favoured some corners over others.
 */
function shuffle<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]] as [T, T];
  }
  return out;
}

/**
 * `count` distinct memes in `count` distinct corners, each with a small
 * pinned-note tilt.
 *
 * Both lists drop what the previous deal used before shuffling, so a card
 * never appears twice running in the same corner (or with the same meme),
 * however you arrive at the step — Next, Back, or the rotation timer. With
 * four cards every corner is used regardless, so only the memes rotate.
 *
 * Exported for the test, which is the only way to assert the never-twice-
 * running property: it needs hundreds of draws, and the component renders one.
 */
export function deal(count: number): Placed[] {
  // Filtering can never empty these: `count` is at most 4 and the previous
  // deal held at most `count` of the 4 corners and 18 memes, so a fresh corner
  // exists whenever count < 4, and a fresh meme always does.
  const fresh = CORNERS.filter((corner) => !lastCorners.includes(cornerKey(corner)));
  const corners = shuffle(fresh.length >= count ? fresh : CORNERS);
  const memes = shuffle(MEMES.filter((meme) => !lastMemeIds.includes(meme.id)));

  const placed = corners.slice(0, count).flatMap((corner, index) => {
    const meme = memes[index];
    return meme ? [{ ...meme, ...corner, rotate: Math.random() * 7 - 3.5 }] : [];
  });
  lastCorners = placed.map(cornerKey);
  lastMemeIds = placed.map((meme) => meme.id);
  return placed;
}

/** How long a set stays up. Matches the CSS fade, which runs once per set. */
const ROTATE_MS = 7000;

interface OnboardingMemesProps {
  /**
   * How many corners to fill. The welcome screen is a title and one button,
   * so it can carry all four; every later step is asking for something, and a
   * single card beside it is flair rather than competition.
   */
  count: number;
}

export function OnboardingMemes({ count }: OnboardingMemesProps) {
  // Looping GIFs are the exact thing this preference asks you not to do, and
  // there is no pausing one from an <img>. Read once: an overlay that reshuffles
  // itself mid-flow because the OS theme changed is not worth a listener.
  const reduceMotion = useMemo(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const [picks, setPicks] = useState<Placed[]>(() => deal(count));
  // Bumped with every deal so the keys change, which remounts the cards and
  // replays their fade-in — the animation *is* the transition.
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (reduceMotion) {
      return;
    }
    const timer = setInterval(() => {
      setPicks(deal(count));
      setRound((current) => current + 1);
    }, ROTATE_MS);
    return () => clearInterval(timer);
  }, [reduceMotion, count]);

  if (reduceMotion) {
    return null;
  }

  return (
    // Decoration, and the jokes are not instructions: a screen reader reading
    // out four punchlines before the Get started button would be a worse
    // welcome than silence.
    <div className="onboarding-memes" data-count={picks.length} aria-hidden="true">
      {picks.map((meme) => (
        <div
          key={`${round}-${meme.id}`}
          className="onboarding-meme"
          data-v={meme.v}
          data-h={meme.h}
          style={{ "--meme-rot": `${meme.rotate}deg` } as React.CSSProperties}
        >
          <MemeCard meme={meme} />
        </div>
      ))}
    </div>
  );
}

function MemeCard({ meme }: { meme: Meme }) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      {failed ? (
        <span className="onboarding-meme-emoji">{meme.emoji}</span>
      ) : (
        <img
          className="onboarding-meme-gif"
          src={meme.src}
          alt=""
          onError={() => setFailed(true)}
        />
      )}
      <span className="onboarding-meme-caption">{meme.caption}</span>
    </>
  );
}
