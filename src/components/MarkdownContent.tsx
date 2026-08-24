import { memo, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink } from "@/components/ExternalLink";
import { Mention, mentionLabel } from "@/components/Mention";
import { AGENT_SHAPES, type AgentShape, AVATAR_TONES, type AvatarTone } from "@/data/agents";
import type { MentionPalette } from "@/lib/mentions";
import { rehypeMentions } from "@/lib/rehype-mentions";

/**
 * The avatar the plugin asked for, or nothing.
 *
 * Checked against the real tone and shape lists rather than cast: these arrive
 * as loose `unknown` props off a hast node, and BlobAvatar indexes its
 * gradient and path tables by them — an unrecognised value would index to
 * `undefined` and throw mid-render, taking the whole transcript with it.
 */
function avatarFrom(
  props: Record<string, unknown>,
): { tone: AvatarTone; shape: AgentShape } | null {
  const tone = props["data-mention-tone"];
  const shape = props["data-mention-shape"];
  if (!AVATAR_TONES.includes(tone as AvatarTone) || !AGENT_SHAPES.includes(shape as AgentShape)) {
    return null;
  }
  return { tone: tone as AvatarTone, shape: shape as AgentShape };
}

const remarkPlugins = [remarkGfm];

/**
 * Renders an agent reply's markdown (GFM: lists, tables, code, strikethrough).
 *
 * react-markdown never emits raw HTML, so model output cannot inject markup.
 * Links open through ExternalLink (the webview must never navigate), and
 * images are rendered as links instead of fetched — a remote image in model
 * output is an exfiltration vector, not content.
 *
 * `palette` (group chats only) colours `@Name` mentions in the mentioned
 * Blob's own colour, so "who is being addressed" is legible at a glance.
 *
 * Memoized: the streaming transcript re-renders every delta, but only the
 * newest message's text actually changes.
 */
export const MarkdownContent = memo(function MarkdownContent({
  text,
  palette,
}: {
  text: string;
  palette?: MentionPalette | undefined;
}) {
  // A new plugin array each render would re-parse every bubble on every delta.
  const rehypePlugins = useMemo(() => [rehypeMentions(palette)], [palette]);
  return (
    <div className="bubble-markdown">
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          a: ({ href, children }) =>
            href === undefined ? children : <ExternalLink href={href}>{children}</ExternalLink>,
          img: ({ src, alt }) =>
            typeof src === "string" && src !== "" ? (
              <ExternalLink href={src}>{alt === undefined || alt === "" ? src : alt}</ExternalLink>
            ) : null,
          // Only spans this file's own rehype plugin created carry these;
          // react-markdown emits none of its own, and model text can never
          // become an element.
          span: ({ children, ...props }) => {
            const bag = props as Record<string, unknown>;
            const onLight = bag["data-mention-on-light"];
            const onDark = bag["data-mention-on-dark"];
            if (typeof onLight !== "string" || typeof onDark !== "string") {
              return <span>{children}</span>;
            }
            const avatar = avatarFrom(bag);
            return (
              <Mention colors={{ onLight, onDark }} {...(avatar === null ? {} : { avatar })}>
                {/* The avatar replaces the "@", so the text loses it too. The
                    plugin always wraps a mention in a single text child. */}
                {avatar !== null && typeof children === "string"
                  ? mentionLabel(children)
                  : children}
              </Mention>
            );
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
