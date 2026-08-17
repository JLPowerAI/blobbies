import { BLOB_GRADIENTS } from "@/components/BlobAvatar";
import type { Agent } from "@/data/agents";

/**
 * The two colours a mention can be drawn in: one legible on a light
 * background, one on a dark one. A Blob's avatar gradient supplies both — the
 * deep end reads on white, the pale end on near-black — so a mention is
 * recognisably *that* Blob's colour in either theme without a second palette
 * to keep in sync.
 */
export interface MentionColors {
  onLight: string;
  onDark: string;
}

/**
 * `@everyone`, which belongs to no Blob — the app's own `--accent-link` pair,
 * so it reads as "the room" rather than as a member who happens to be blue.
 * Literal rather than a `var()`: these are read in JS to build the inline
 * custom properties, where a token name would resolve to nothing.
 */
const EVERYONE_COLORS: MentionColors = { onLight: "#0a5dc2", onDark: "#6cb2ff" };

/** Matched case-insensitively, like a member's name. */
const EVERYONE = "everyone";

/** A mention, or a run of ordinary text. `colors` set means it is a mention. */
export interface MentionPart {
  text: string;
  colors?: MentionColors;
}

/**
 * Lowercased name → colours, longest name first.
 *
 * Order matters: with members called "Ann" and "Ann Reviewer", matching the
 * shorter name first would colour half of the longer one and leave the rest
 * as plain text.
 */
export type MentionPalette = Map<string, MentionColors>;

export function mentionPalette(members: readonly Agent[]): MentionPalette {
  const entries: [string, MentionColors][] = members
    // A blank name would match at every "@", painting the whole transcript in
    // one Blob's colour. The roster should not hold one; this is the cheap
    // guarantee that it cannot matter if it does.
    .filter((member) => member.name.trim() !== "")
    .map((member) => {
      const [pale, deep] = BLOB_GRADIENTS[member.tone];
      return [member.name.toLowerCase(), { onLight: deep, onDark: pale }];
    });
  entries.push([EVERYONE, EVERYONE_COLORS]);
  entries.sort((left, right) => right[0].length - left[0].length);
  return new Map(entries);
}

/** True when `char` would make the mention part of a longer word. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\w@]/.test(char);
}

/**
 * Split text into plain runs and `@Name` mentions.
 *
 * Same matching rule as `parseMentions` in lib/groups — whole name, bounded by
 * non-word characters — so what is highlighted is exactly what would wake
 * somebody. Colouring a mention the router ignored, or leaving a real one
 * grey, would teach the user the wrong thing about who is being addressed.
 *
 * `partial` relaxes that for the composer only: a half-typed `@soc` at the
 * very end of the draft is coloured when exactly one name can still complete
 * it. Nothing is being addressed yet, but the user is mid-word and the colour
 * confirms who they are about to reach — and with one candidate there is no
 * wrong Blob to point at. Transcripts never pass it: a stored message is
 * finished text, where a partial addresses nobody.
 *
 * Returns a single plain part when there is nothing to highlight, so callers
 * on the hot path (every bubble, every keystroke while streaming) can skip
 * the wrapper elements entirely.
 */
export function splitMentions(
  text: string,
  palette: MentionPalette,
  options?: { partial?: boolean },
): MentionPart[] {
  const haystack = text.toLowerCase();
  // Lowercasing is not always length-preserving ("\u0130".toLowerCase() is two
  // code units), and every index below is shared between the two strings. On
  // the rare text where they diverge, highlight nothing rather than slice the
  // message at the wrong offsets.
  if (haystack.length !== text.length) {
    return [{ text }];
  }
  const parts: MentionPart[] = [];
  let at = 0;
  let plain = 0;
  while (at < text.length) {
    if (text[at] !== "@" || isWordChar(text[at - 1])) {
      at++;
      continue;
    }
    // Still being typed: everything after the "@" runs to the end of the
    // draft (text after it means the user moved on) and exactly one name can
    // still complete it. Checked BEFORE the exact match, because a short name
    // that prefixes a longer one would otherwise win: with Ann and Ann
    // Reviewer in the room, “@ann r” is unambiguously the latter, and
    // colouring “@ann” pink mid-word points at the wrong Blob.
    if (options?.partial === true) {
      const typed = haystack.slice(at + 1);
      const candidates = [...palette].filter(([name]) => name.startsWith(typed));
      const only = candidates.length === 1 ? candidates[0] : undefined;
      if (typed !== "" && only !== undefined) {
        if (at > plain) {
          parts.push({ text: text.slice(plain, at) });
        }
        parts.push({ text: text.slice(at), colors: only[1] });
        return parts;
      }
    }
    let hit: { name: string; colors: MentionColors } | undefined;
    for (const [name, colors] of palette) {
      const end = at + 1 + name.length;
      if (haystack.startsWith(name, at + 1) && !isWordChar(haystack[end])) {
        hit = { name, colors };
        break;
      }
    }
    if (hit === undefined) {
      at++;
      continue;
    }
    if (at > plain) {
      parts.push({ text: text.slice(plain, at) });
    }
    const end = at + 1 + hit.name.length;
    // Sliced from the original, not the lowercased copy: the mention keeps the
    // capitalisation the writer used.
    parts.push({ text: text.slice(at, end), colors: hit.colors });
    at = end;
    plain = end;
  }
  if (plain < text.length) {
    parts.push({ text: text.slice(plain) });
  }
  return parts;
}
