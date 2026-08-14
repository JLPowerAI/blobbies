import { ArrowUp, CornerUpRight, Download, Ellipsis, Monitor, Plus, Smile, X } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { BlobAvatar } from "@/components/BlobAvatar";
import type { Agent, Message } from "@/data/agents";

interface ChatPaneProps {
  agent: Agent;
  messages: Message[];
  onSend: (text: string, replyTo?: string) => void;
  detailOpen: boolean;
  onToggleDetail: () => void;
  onOpenSettings: () => void;
}

const REACTIONS: ReadonlyArray<{ emoji: string; name: string }> = [
  { emoji: "\u{1F44D}", name: "thumbs up" },
  { emoji: "\u{1F44E}", name: "thumbs down" },
  { emoji: "\u2764\uFE0F", name: "heart" },
  { emoji: "\u{1F602}", name: "laugh" },
  { emoji: "\u{1F389}", name: "celebrate" },
  { emoji: "\u{1F62E}", name: "surprised" },
];

/** Plain-text preview of a message, used for reply quoting. */
function messagePreview(message: Message): string {
  if (message.kind === "file") {
    return message.fileName;
  }
  return message.segments.map((segment) => segment.text).join("");
}

function TextBubble({ message }: { message: Extract<Message, { kind: "text" }> }) {
  return (
    <div className={message.author === "user" ? "bubble bubble-user" : "bubble bubble-agent"}>
      {message.replyTo === undefined ? null : (
        <span className="bubble-quote">{message.replyTo}</span>
      )}
      {message.segments.map((segment) =>
        segment.accent === true ? (
          <span key={segment.text} className="bubble-accent">
            {segment.text}
          </span>
        ) : (
          <span key={segment.text}>{segment.text}</span>
        ),
      )}
    </div>
  );
}

function FileBubble({ message }: { message: Extract<Message, { kind: "file" }> }) {
  return (
    <div className="bubble bubble-file">
      <span className="file-badge" aria-hidden="true">
        PDF
      </span>
      <span className="file-text">
        <span className="file-name">{message.fileName}</span>
        <span className="file-meta">{message.meta}</span>
      </span>
      <button
        type="button"
        className="icon-button file-download"
        aria-label={`Download ${message.fileName}`}
      >
        <Download size={15} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  );
}

interface MessageRowProps {
  message: Message;
  reaction: string | undefined;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
}

/** A bubble plus its hover/focus action bar, reaction picker and reaction badge. */
function MessageRow({
  message,
  reaction,
  pickerOpen,
  onTogglePicker,
  onReact,
  onReply,
}: MessageRowProps) {
  const side = message.kind === "text" && message.author === "user" ? "user" : "agent";
  return (
    <div className={`message-row message-row-${side}`}>
      <div className="message-actions" role="toolbar" aria-label="Message actions">
        <button type="button" className="icon-button message-action" aria-label="More options">
          <Ellipsis size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button message-action"
          aria-label="Reply"
          onClick={onReply}
        >
          <CornerUpRight size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button message-action"
          aria-label="React"
          aria-expanded={pickerOpen}
          onClick={onTogglePicker}
        >
          <Smile size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      {pickerOpen ? (
        <div className="reaction-picker">
          {REACTIONS.map((option) => (
            <button
              type="button"
              key={option.name}
              className="reaction-option"
              aria-label={`React with ${option.name}`}
              aria-pressed={reaction === option.emoji}
              onClick={() => onReact(option.emoji)}
            >
              {option.emoji}
            </button>
          ))}
        </div>
      ) : null}
      {message.kind === "text" ? (
        <TextBubble message={message} />
      ) : (
        <FileBubble message={message} />
      )}
      {reaction === undefined ? null : (
        <span className="bubble-reaction" role="img" aria-label={`Reacted with ${reaction}`}>
          {reaction}
        </span>
      )}
    </div>
  );
}

/** Solid microphone glyph; lucide only ships the outlined variant. */
function MicFilled({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15z" />
      <path d="M18.5 11.5a1 1 0 1 0-2 0 4.5 4.5 0 0 1-9 0 1 1 0 1 0-2 0 6.5 6.5 0 0 0 5.5 6.42V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.08a6.5 6.5 0 0 0 5.5-6.42z" />
    </svg>
  );
}

/** Cap the composer's growth at five text lines (5 × 20px + block padding). */
const COMPOSER_MAX_HEIGHT = 112;

/** Single-line textarea height; above this the composer switches to the
    expanded layout (text on top, buttons on their own bottom row). */
const COMPOSER_LINE_HEIGHT = 32;

export function ChatPane({
  agent,
  messages,
  onSend,
  detailOpen,
  onToggleDetail,
  onOpenSettings,
}: ChatPaneProps) {
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyClosing, setReplyClosing] = useState(false);
  const [reactions, setReactions] = useState<Record<string, string>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [multiline, setMultiline] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const flipRects = useRef(new Map<string, DOMRect>());

  // Fresh conversation, fresh composer: clear the draft, reply chip and
  // reaction picker when switching Blobs so state never leaks across.
  // biome-ignore lint/correctness/useExhaustiveDependencies(agent.id): only the switch matters
  useEffect(() => {
    setDraft("");
    setReplyTo(null);
    setReplyClosing(false);
    setPickerFor(null);
    setMultiline(false);
    setReactions({});
  }, [agent.id]);

  // Auto-grow the textarea toward the cap, animating between the measured
  // heights. The transient `auto` never paints, so the height transition runs
  // from the previous pixel value to the new one.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) {
      return;
    }
    const previous = el.offsetHeight;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT);
    el.style.height = `${previous}px`;
    void el.offsetHeight; // commit the starting point before animating
    el.style.height = `${next}px`;
    el.style.overflowY = next >= COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
    // simplification: sticky until the draft is cleared — the expanded layout
    // widens the textarea, so re-measuring there would flip-flop for text that
    // only wraps at the narrow inline width.
    if (draft.length === 0) {
      setMultiline(false);
    } else if (next > COMPOSER_LINE_HEIGHT) {
      setMultiline(true);
    }
  }, [draft]);

  const hasDraft = draft.trim().length > 0;

  // FLIP: whenever a composer control lands somewhere new (layout switch or
  // reply chip appearing), glide it from its old position instead of
  // teleporting. Rects are recorded every render so they never go stale, but
  // glides only play when layout-changing state moved — animating per
  // keystroke would measure mid-transition rects and jitter the buttons on
  // every character. The send button's mic→arrow swap is deliberately not a
  // trigger: it has its own pop-in and the mic's small shift should be
  // instant.
  const flipTrigger = `${multiline}|${replyTo !== null}`;
  const lastFlipTrigger = useRef(flipTrigger);
  useLayoutEffect(() => {
    const form = composerRef.current;
    if (form === null) {
      return;
    }
    const shouldAnimate = flipTrigger !== lastFlipTrigger.current;
    lastFlipTrigger.current = flipTrigger;
    const reduced =
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const el of form.querySelectorAll<HTMLElement>("[data-flip]")) {
      const key = el.dataset.flip as string;
      const next = el.getBoundingClientRect();
      const prev = flipRects.current.get(key);
      flipRects.current.set(key, next);
      if (prev === undefined || !shouldAnimate || reduced || typeof el.animate !== "function") {
        continue;
      }
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      const grewBy = prev.width - next.width;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(grewBy) < 1) {
        continue;
      }
      // The textarea also changes width between layouts; animating the used
      // width lets its text (and caret) rewrap gradually instead of snapping.
      const animateWidth = Math.abs(grewBy) >= 1;
      const from: Keyframe = { transform: `translate(${dx}px, ${dy}px)` };
      const to: Keyframe = { transform: "translate(0, 0)" };
      if (animateWidth) {
        from.width = `${prev.width}px`;
        to.width = `${next.width}px`;
      }
      // Duration/easing must match --duration-compose/--ease-standard so the
      // glides land together with the textarea's height transition.
      el.animate([from, to], { duration: 160, easing: "cubic-bezier(0.3, 0, 0.2, 1)" });
    }
  });

  const send = () => {
    const text = draft.trim();
    if (text.length === 0) {
      return;
    }
    onSend(text, replyTo !== null && !replyClosing ? replyTo : undefined);
    setDraft("");
    closeReply();
  };

  // Animate the chip out; it unmounts when the exit animation finishes.
  // Where animations never run (reduced motion, jsdom), close immediately
  // since animationend would never fire.
  const closeReply = () => {
    if (replyTo === null) {
      return;
    }
    if (
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setReplyTo(null);
      return;
    }
    setReplyClosing(true);
  };

  const startReply = (message: Message) => {
    setReplyTo(messagePreview(message));
    setReplyClosing(false);
    setPickerFor(null);
    textareaRef.current?.focus();
  };

  const toggleReaction = (messageId: string, emoji: string) => {
    setReactions((previous) => {
      const next = { ...previous };
      if (next[messageId] === emoji) {
        delete next[messageId];
      } else {
        next[messageId] = emoji;
      }
      return next;
    });
    setPickerFor(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline; Escape cancels a reply.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape" && replyTo !== null) {
      closeReply();
    }
  };

  return (
    <section className="chat-pane" aria-label={`Conversation with ${agent.name}`}>
      <header className="chat-header" data-tauri-drag-region>
        {/* drag-region only fires on the element itself, so the header stays
            draggable around this identity button. */}
        <button
          type="button"
          className="chat-header-identity identity-button"
          aria-label={`${agent.name} settings`}
          onClick={onOpenSettings}
        >
          <BlobAvatar tone={agent.tone} shape={agent.shape} size={24} />
          <h1 className="chat-title">{agent.name}</h1>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={detailOpen ? "Hide details panel" : "Show details panel"}
          aria-pressed={detailOpen}
          onClick={onToggleDetail}
        >
          <Monitor size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </header>

      <div className="message-scroll" role="log" aria-label="Messages">
        <p className="timestamp-divider">9:41 AM</p>
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            reaction={reactions[message.id]}
            pickerOpen={pickerFor === message.id}
            onTogglePicker={() => setPickerFor(pickerFor === message.id ? null : message.id)}
            onReact={(emoji) => toggleReaction(message.id, emoji)}
            onReply={() => startReply(message)}
          />
        ))}
      </div>

      <form
        ref={composerRef}
        className={multiline || replyTo !== null ? "composer composer-expanded" : "composer"}
        onSubmit={submit}
      >
        {replyTo === null ? null : (
          <div
            className={replyClosing ? "composer-reply composer-reply-closing" : "composer-reply"}
            onAnimationEnd={() => {
              if (replyClosing) {
                setReplyTo(null);
                setReplyClosing(false);
              }
            }}
          >
            <CornerUpRight size={13} strokeWidth={1.8} aria-hidden="true" />
            <span className="composer-reply-text">{replyTo}</span>
            <button
              type="button"
              className="icon-button composer-reply-cancel"
              aria-label="Cancel reply"
              onClick={closeReply}
            >
              <X size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="composer-main">
          <button
            type="button"
            className="icon-button composer-add"
            aria-label="Add attachment"
            data-flip="add"
          >
            <Plus size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            className="composer-input"
            data-flip="input"
            placeholder={replyTo === null ? `Message ${agent.name}` : "Reply..."}
            aria-label={`Message ${agent.name}`}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={onComposerKeyDown}
          />
          {/* Plain dictate mic; fades in once the circle has become Send. */}
          <button
            type="button"
            className={
              hasDraft ? "composer-mic-plain" : "composer-mic-plain composer-mic-plain-hidden"
            }
            aria-label="Dictate message"
            aria-hidden={!hasDraft}
            tabIndex={hasDraft ? undefined : -1}
            data-flip="mic-plain"
          >
            <MicFilled size={18} />
          </button>
          {/* One circle, fixed position: its glyph cross-fades mic↔arrow. */}
          <button
            type={hasDraft ? "submit" : "button"}
            className="composer-mic"
            aria-label={hasDraft ? "Send message" : "Dictate message"}
            data-flip="mic"
          >
            <span className="composer-mic-glyph" data-visible={!hasDraft}>
              <MicFilled size={18} />
            </span>
            <span className="composer-mic-glyph" data-visible={hasDraft}>
              <ArrowUp size={17} strokeWidth={2.4} aria-hidden="true" />
            </span>
          </button>
        </div>
      </form>
    </section>
  );
}
