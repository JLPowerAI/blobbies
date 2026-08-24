import type { CSSProperties, ReactNode } from "react";
import { BlobAvatar } from "@/components/BlobAvatar";
import type { AgentShape, AvatarTone } from "@/data/agents";
import type { MentionColors, MentionPalette } from "@/lib/mentions";
import { splitMentions } from "@/lib/mentions";

/** `#rgb`, `#rrggbb` or `#rrggbbaa` — the only shape a palette produces. */
const HEX_COLOR = /^#[0-9a-f]{3}$|^#[0-9a-f]{6}$|^#[0-9a-f]{8}$/i;

/**
 * One `@Name`, in that Blob's own colour.
 *
 * The colour is passed as two custom properties rather than one resolved
 * value: the theme can change without React re-rendering the transcript, so
 * picking light-vs-dark here would leave every existing bubble wrong until
 * something else caused a repaint.
 *
 * Both are checked against a hex pattern first. Today they can only come from
 * `BLOB_GRADIENTS`, but this is the one place a *string* becomes a CSS value,
 * and a custom property is a value the stylesheet later interpolates — so the
 * choke point validates rather than trusting every future caller.
 */
export function Mention({
  colors,
  avatar,
  children,
}: {
  colors: MentionColors;
  /** Draws the Blob's own avatar where the "@" would be. */
  avatar?: { tone: AvatarTone; shape: AgentShape };
  children: ReactNode;
}) {
  if (!HEX_COLOR.test(colors.onLight) || !HEX_COLOR.test(colors.onDark)) {
    return <span className="mention">{children}</span>;
  }
  return (
    <span
      className={avatar === undefined ? "mention" : "mention mention-with-avatar"}
      style={
        {
          "--mention-on-light": colors.onLight,
          "--mention-on-dark": colors.onDark,
        } as CSSProperties
      }
    >
      {avatar === undefined ? null : (
        <BlobAvatar tone={avatar.tone} shape={avatar.shape} size={14} />
      )}
      {children}
    </span>
  );
}

/**
 * A mention's visible label: the name without the "@" that addressed it.
 *
 * Only for mentions drawn with an avatar — the face already says "this is a
 * Blob", which is the whole job the "@" was doing, and keeping both reads as a
 * stray character wedged between the icon and the name. The stored text is
 * untouched; this is a rendering choice.
 */
export function mentionLabel(text: string): string {
  return text.startsWith("@") ? text.slice(1) : text;
}

/**
 * Plain text with its mentions highlighted, for bubbles that are not markdown
 * (the user's own words render verbatim). Returns the string untouched when
 * there is nothing to highlight, so the common bubble adds no extra elements.
 *
 * `partial` is for the live composer only — see `splitMentions`.
 */
export function withMentions(
  text: string,
  palette: MentionPalette | undefined,
  options?: { partial?: boolean },
): ReactNode {
  if (palette === undefined) {
    return text;
  }
  const parts = splitMentions(text, palette, options);
  if (parts.length === 1 && parts[0]?.colors === undefined) {
    return text;
  }
  // Parts are positional slices of one immutable string: there is no stable
  // id to key by, and they can never reorder or be inserted between.
  return parts.map((part, index) =>
    part.colors === undefined ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: positional by construction
      <span key={`${index}-${part.text}`}>{part.text}</span>
    ) : (
      <Mention
        // biome-ignore lint/suspicious/noArrayIndexKey: positional by construction
        key={`${index}-${part.text}`}
        colors={part.colors}
        {...(part.avatar === undefined ? {} : { avatar: part.avatar })}
      >
        {part.avatar === undefined ? part.text : mentionLabel(part.text)}
      </Mention>
    ),
  );
}
