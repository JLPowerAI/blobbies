import type { CardContext } from "@/components/cards/registry";
import { MarkdownContent } from "@/components/MarkdownContent";
import { withMentions } from "@/components/Mention";
import type { Message } from "@/data/agents";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";

export function TextBubble({
  message,
  palette,
  onRetry,
  onDismiss,
}: CardContext & {
  message: Extract<Message, { kind: "text" }>;
}) {
  // An attachment-only message has no words, so it gets no empty bubble.
  if (!message.segments.some((segment) => segment.text !== "")) {
    return null;
  }
  // An ask renders as a highlighted card: the Blob paused its task and needs
  // the user — "action" means "do this yourself" (login, click, paste).
  const askClass =
    message.ask === undefined
      ? ""
      : message.ask === "action"
        ? " bubble-ask bubble-ask-action"
        : " bubble-ask";
  const quote =
    message.replyTo === undefined ? null : <span className="bubble-quote">{message.replyTo}</span>;

  if (message.author === "user") {
    return (
      <div className="bubble bubble-user">
        {quote}
        {/* The user's own words render verbatim; only the agent speaks markdown. */}
        {message.segments.map((segment) =>
          segment.accent === true ? (
            <span key={segment.text} className="bubble-accent">
              {segment.text}
            </span>
          ) : (
            // The user's own @mentions are highlighted too: they are what
            // actually decides who answers, so they must read as addressing.
            <span key={segment.text}>{withMentions(segment.text, palette)}</span>
          ),
        )}
      </div>
    );
  }

  // Each table becomes its own block: a bubble hugs its text and caps at a
  // fraction of the pane, which squeezes columns until headers wrap mid-word.
  const blocks = splitMarkdownBlocks(message.segments.map((segment) => segment.text).join(""));
  return (
    <div className="bubble-stack">
      {blocks.map((block, position) => (
        <div
          key={block.line}
          className={
            block.kind === "table"
              ? "bubble bubble-agent bubble-table"
              : `bubble bubble-agent${askClass}`
          }
        >
          {position === 0 ? quote : null}
          <MarkdownContent text={block.text} palette={palette} />
        </div>
      ))}
      {/* The turn did not finish, so the words above are an explanation and
          the only way on used to be retyping the question. */}
      {message.failed === true && (onRetry !== undefined || onDismiss !== undefined) ? (
        <div className="turn-failed-actions">
          {onRetry === undefined ? null : (
            <button type="button" className="turn-failed-action" onClick={onRetry}>
              Retry
            </button>
          )}
          {onDismiss === undefined ? null : (
            <button type="button" className="turn-failed-action" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
