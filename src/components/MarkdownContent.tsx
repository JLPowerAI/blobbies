import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink } from "@/components/ExternalLink";

const remarkPlugins = [remarkGfm];

/**
 * Renders an agent reply's markdown (GFM: lists, tables, code, strikethrough).
 *
 * react-markdown never emits raw HTML, so model output cannot inject markup.
 * Links open through ExternalLink (the webview must never navigate), and
 * images are rendered as links instead of fetched — a remote image in model
 * output is an exfiltration vector, not content.
 *
 * Memoized: the streaming transcript re-renders every delta, but only the
 * newest message's text actually changes.
 */
export const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="bubble-markdown">
      <Markdown
        remarkPlugins={remarkPlugins}
        components={{
          a: ({ href, children }) =>
            href === undefined ? children : <ExternalLink href={href}>{children}</ExternalLink>,
          img: ({ src, alt }) =>
            typeof src === "string" && src !== "" ? (
              <ExternalLink href={src}>{alt === undefined || alt === "" ? src : alt}</ExternalLink>
            ) : null,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
