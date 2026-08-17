import { memo, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink } from "@/components/ExternalLink";
import { Mention } from "@/components/Mention";
import type { MentionPalette } from "@/lib/mentions";
import { rehypeMentions } from "@/lib/rehype-mentions";

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
            const onLight = (props as Record<string, unknown>)["data-mention-on-light"];
            const onDark = (props as Record<string, unknown>)["data-mention-on-dark"];
            return typeof onLight === "string" && typeof onDark === "string" ? (
              <Mention colors={{ onLight, onDark }}>{children}</Mention>
            ) : (
              <span>{children}</span>
            );
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
