import {
  ArrowDown,
  ArrowUp,
  CornerUpRight,
  Download,
  Ellipsis,
  Monitor,
  Plus,
  Smile,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BlobAvatar } from "@/components/BlobAvatar";
import { MarkdownContent } from "@/components/MarkdownContent";
import { PillSelect } from "@/components/PillSelect";
import type { Agent, Message } from "@/data/agents";
import { listOllamaModels, type OllamaModel } from "@/lib/ollama";
import {
  configureTinfoilFromKeychain,
  listTinfoilModels,
  TINFOIL_MODEL_PREFIX,
  type TinfoilModel,
} from "@/lib/tinfoil";

interface ChatPaneProps {
  agent: Agent;
  messages: Message[];
  /** True while the Blob is generating a reply; shows the thinking blob. */
  thinking?: boolean;
  /** Ollama model tag driving replies; "" until one is chosen. */
  model: string;
  onModelChange: (model: string) => void;
  /** Whether the model may use chain-of-thought (slower, deeper). */
  reasoning: boolean;
  onReasoningChange: (on: boolean) => void;
  onSend: (text: string, replyTo?: string) => void;
  detailOpen: boolean;
  onToggleDetail: () => void;
  onOpenSettings: () => void;
}

/** Messages rendered initially; scrolling to the top reveals another page.
    Caps DOM size for long transcripts — markdown bubbles are expensive. */
const MESSAGE_PAGE_SIZE = 50;

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
      {message.author === "user" ? (
        // The user's own words render verbatim; only the agent speaks markdown.
        message.segments.map((segment) =>
          segment.accent === true ? (
            <span key={segment.text} className="bubble-accent">
              {segment.text}
            </span>
          ) : (
            <span key={segment.text}>{segment.text}</span>
          ),
        )
      ) : (
        <MarkdownContent text={message.segments.map((segment) => segment.text).join("")} />
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
  /** Arrived after mount: plays the in-place jelly pop exactly once. */
  fresh: boolean;
  onTogglePicker: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
}

/** A bubble plus its hover/focus action bar, reaction picker and reaction badge. */
function MessageRow({
  message,
  reaction,
  pickerOpen,
  fresh,
  onTogglePicker,
  onReact,
  onReply,
}: MessageRowProps) {
  const side = message.kind === "text" && message.author === "user" ? "user" : "agent";
  return (
    <div className={`message-row message-row-${side}${fresh ? " message-fresh" : ""}`}>
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
          // Without this, the outside-click dismiss fires on pointerdown and
          // the click then re-toggles the picker straight back open.
          onPointerDown={(event) => event.stopPropagation()}
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
  thinking = false,
  model,
  onModelChange,
  reasoning,
  onReasoningChange,
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

  // Click anywhere outside the reaction picker (or Escape) dismisses it. The
  // opener buttons stopPropagation, so this never races the toggle.
  useEffect(() => {
    if (pickerFor === null) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest(".reaction-picker") === null) {
        setPickerFor(null);
      }
    };
    // globalThis: bare KeyboardEvent is React's type, shadowed by the import.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setPickerFor(null);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickerFor]);
  const [availableModels, setAvailableModels] = useState<OllamaModel[]>([]);
  const [tinfoilModels, setTinfoilModels] = useState<TinfoilModel[]>([]);
  /** How many trailing messages are rendered; grows as the user scrolls up. */
  const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE);
  /** Shows the floating "scroll to bottom" button while scrolled up. */
  const [showJump, setShowJump] = useState(false);
  /** Scroll geometry captured just before older messages mount, so the
      viewport can be re-anchored instead of jumping to the new top. */
  const loadAnchorRef = useRef<{ height: number; top: number } | null>(null);
  /** Replies that arrived while the user was scrolled up; drives the pill. */
  const [unseenCount, setUnseenCount] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Whether the view is close enough to the bottom to auto-follow. */
  const nearBottomRef = useRef(true);
  const prevMessageCount = useRef(messages.length);
  /** True while a programmatic smooth scroll is in flight; its intermediate
      scroll events must not be mistaken for the user scrolling up. */
  const autoScrollRef = useRef(false);
  const flipRects = useRef(new Map<string, DOMRect>());

  // Messages already on screen when this conversation opened. Anything newer
  // is "fresh" and pops in with the jelly animation — exactly once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot messages only when the conversation switches
  const initialIds = useMemo(() => new Set(messages.map((entry) => entry.id)), [agent.id]);

  /**
   * Load the downloaded models for the header picker.
   *
   * Also re-run on demand (see the select's handlers): fetching only at mount
   * leaves the list empty forever if Ollama was starting up at the time, and
   * stale after the user pulls or removes a model with the app open.
   */
  const refreshModels = useCallback(() => {
    void listOllamaModels().then(setAvailableModels);
    // Re-read the keychain instead of trusting in-memory session state: that
    // state can lag this mount (async startup load) and the keychain is the
    // source of truth for key removal too. Idempotent and local, so cheap.
    void configureTinfoilFromKeychain().then((hasKey) =>
      hasKey ? listTinfoilModels().then(setTinfoilModels) : setTinfoilModels([]),
    );
  }, []);

  useEffect(refreshModels, [refreshModels]);

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
    setUnseenCount(0);
    setVisibleCount(MESSAGE_PAGE_SIZE);
    setShowJump(false);
    // A page-load pending at switch time must not survive: its geometry
    // belongs to the old conversation, and a stale anchor blocks paging.
    loadAnchorRef.current = null;
    nearBottomRef.current = true;
  }, [agent.id]);

  // Older page mounted above the viewport: keep what the user was looking at
  // stationary by offsetting the scroll position with the added height.
  // biome-ignore lint/correctness/useExhaustiveDependencies(visibleCount): re-anchor exactly when the page mounts
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = loadAnchorRef.current;
    loadAnchorRef.current = null;
    if (el !== null && anchor !== null) {
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    }
  }, [visibleCount]);

  const scrollToLatest = (behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (el !== null) {
      autoScrollRef.current = behavior === "smooth";
      nearBottomRef.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
    setUnseenCount(0);
    setShowJump(false);
  };

  // Follow the conversation: sending your own message glides down to it (even
  // from scrolled-up), streaming growth sticks instantly while already at the
  // bottom, and anything arriving while scrolled up feeds the "new message"
  // pill instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies(scrollToLatest): stable helper
  useLayoutEffect(() => {
    const arrived = messages.length - prevMessageCount.current;
    prevMessageCount.current = messages.length;
    if (scrollRef.current === null) {
      return;
    }
    if (arrived > 0 && messages.at(-1)?.author === "user") {
      scrollToLatest("smooth");
      return;
    }
    if (nearBottomRef.current) {
      scrollToLatest("instant");
      return;
    }
    if (arrived > 0) {
      setUnseenCount((count) => count + arrived);
    }
  }, [messages]);

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
        <div className="chat-header-controls">
          <PillSelect
            id="header-thinking"
            label="Thinking"
            value={reasoning ? "on" : "off"}
            onChange={(value) => onReasoningChange(value === "on")}
          >
            <option value="off">Thinking off</option>
            <option value="on">Thinking on</option>
          </PillSelect>
          {/* Re-read the list as the menu opens: it may have been empty at
              mount (Ollama still starting) or gone stale since. */}
          <PillSelect
            id="header-model"
            label="Model"
            value={model}
            onChange={onModelChange}
            onOpen={refreshModels}
          >
            <option value="">Choose a model</option>
            {model !== "" &&
            !availableModels.some((entry) => entry.name === model) &&
            !tinfoilModels.some((entry) => `${TINFOIL_MODEL_PREFIX}${entry.id}` === model) ? (
              <option value={model}>{model}</option>
            ) : null}
            {availableModels.length > 0 ? (
              <optgroup label="Ollama — local">
                {availableModels.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {tinfoilModels.length > 0 ? (
              <optgroup label="Tinfoil — private cloud">
                {tinfoilModels.map((entry) => (
                  <option key={entry.id} value={`${TINFOIL_MODEL_PREFIX}${entry.id}`}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </PillSelect>
          <button
            type="button"
            className="icon-button"
            aria-label={detailOpen ? "Hide details panel" : "Show details panel"}
            aria-pressed={detailOpen}
            onClick={onToggleDetail}
          >
            <Monitor size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div
        className="message-scroll"
        role="log"
        aria-label="Messages"
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          // Near the top with older messages hidden: reveal another page.
          // The anchor guard also debounces re-entry while the page mounts.
          if (
            el.scrollTop < 200 &&
            visibleCount < messages.length &&
            loadAnchorRef.current === null
          ) {
            loadAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
            setVisibleCount((count) => count + MESSAGE_PAGE_SIZE);
          }
          // A glide we started passes through "scrolled up" positions; ignore
          // those until it lands so it isn't mistaken for user intent.
          if (autoScrollRef.current) {
            if (nearBottom) {
              autoScrollRef.current = false;
              setShowJump(false);
            }
            return;
          }
          nearBottomRef.current = nearBottom;
          setShowJump(!nearBottom);
          if (nearBottom) {
            setUnseenCount(0);
          }
        }}
      >
        <p className="timestamp-divider">9:41 AM</p>
        {(messages.length > visibleCount ? messages.slice(-visibleCount) : messages).map(
          (message) => (
            <MessageRow
              fresh={!initialIds.has(message.id)}
              key={message.id}
              message={message}
              reaction={reactions[message.id]}
              pickerOpen={pickerFor === message.id}
              onTogglePicker={() => setPickerFor(pickerFor === message.id ? null : message.id)}
              onReact={(emoji) => toggleReaction(message.id, emoji)}
              onReply={() => startReply(message)}
            />
          ),
        )}
        {/* Always mounted: reserves its space (nothing overlaps or jumps) and
            lets the blob fade in/out instead of popping with the DOM. */}
        <div
          className={thinking ? "thinking-row thinking-row-visible" : "thinking-row"}
          role="status"
          aria-hidden={!thinking}
          aria-label={thinking ? `${agent.name} is thinking` : undefined}
        >
          <BlobAvatar tone={agent.tone} shape={agent.shape} size={30} variant="thinking" />
        </div>
      </div>

      {unseenCount > 0 ? (
        <div className="new-messages-pill" role="status">
          <button type="button" className="new-messages-jump" onClick={() => scrollToLatest()}>
            <ArrowDown size={15} strokeWidth={2} aria-hidden="true" />
            {unseenCount === 1 ? "1 new message" : `${unseenCount} new messages`}
          </button>
          <button
            type="button"
            className="new-messages-dismiss"
            aria-label="Dismiss new message notice"
            onClick={() => setUnseenCount(0)}
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ) : showJump ? (
        // The "new message" pill above takes priority: both jump to the
        // bottom, but the pill also says why.
        <div className="scroll-bottom-wrap">
          <button
            type="button"
            className="scroll-bottom-button"
            aria-label="Scroll to bottom"
            onClick={() => scrollToLatest()}
          >
            <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ) : null}

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
