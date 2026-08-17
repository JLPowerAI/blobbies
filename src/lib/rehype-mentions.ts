import type { MentionPalette } from "@/lib/mentions";
import { splitMentions } from "@/lib/mentions";

/** The slice of hast this plugin touches. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Verbatim by definition \u2014 an "@" in a code sample addresses nobody. */
const VERBATIM = new Set(["code", "pre"]);

/**
 * Wrap `@Name` mentions in a Blob's reply so they render in that Blob's
 * colour.
 *
 * A rehype plugin rather than a string replace, because the alternative is
 * injecting HTML into markdown, and react-markdown refuses raw HTML on
 * purpose: model output must never become markup. Here the span is a node we
 * build ourselves and the colours come from the roster, so nothing the model
 * wrote is ever interpreted.
 *
 * The colours ride as `data-` attributes and are turned into a `<Mention>` by
 * MarkdownContent's `span` override \u2014 a `style` string would have to survive
 * hast's CSS parsing, which is not somewhere to bet custom properties.
 */
export function rehypeMentions(palette: MentionPalette | undefined) {
  return () => (tree: HastNode) => {
    if (palette === undefined) {
      return;
    }
    const walk = (node: HastNode) => {
      const children = node.children;
      if (children === undefined || VERBATIM.has(node.tagName ?? "")) {
        return;
      }
      let changed = false;
      const next: HastNode[] = [];
      for (const child of children) {
        if (child.type !== "text" || typeof child.value !== "string") {
          walk(child);
          next.push(child);
          continue;
        }
        const parts = splitMentions(child.value, palette);
        if (parts.every((part) => part.colors === undefined)) {
          next.push(child);
          continue;
        }
        changed = true;
        for (const part of parts) {
          if (part.colors === undefined) {
            next.push({ type: "text", value: part.text });
            continue;
          }
          next.push({
            type: "element",
            tagName: "span",
            properties: {
              "data-mention-on-light": part.colors.onLight,
              "data-mention-on-dark": part.colors.onDark,
            },
            children: [{ type: "text", value: part.text }],
          });
        }
      }
      if (changed) {
        node.children = next;
      }
    };
    walk(tree);
  };
}
