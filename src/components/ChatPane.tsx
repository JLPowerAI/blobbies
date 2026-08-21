import {
  ArrowDown,
  ArrowUp,
  CornerUpRight,
  Download,
  Ellipsis,
  FileText,
  Image as ImageIcon,
  Monitor,
  Plus,
  Smile,
  Square,
  TriangleAlert,
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
import { withMentions } from "@/components/Mention";
import { PillSelect } from "@/components/PillSelect";
import { type Agent, MAX_BLOB_NAME_LENGTH, type Message } from "@/data/agents";
import { type Attachment, MAX_ATTACHMENTS, type PickedFile } from "@/lib/attachments";
import { fileBadge, fileKind } from "@/lib/file-kind";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";
import { type MentionPalette, mentionPalette } from "@/lib/mentions";
import { listOllamaModels, type OllamaModel } from "@/lib/ollama";
import { imagePreview } from "@/lib/preview";
// Tinfoil's real module (attestation stack) is a lazy chunk; only the pure
// id helpers are static. The probe/model-list go through `import()`.
import type { TinfoilModel } from "@/lib/tinfoil";
import { isTinfoilModel, TINFOIL_MODEL_PREFIX } from "@/lib/tinfoil-model";

/**
 * Keychain probe + Tinfoil catalog load, module-scope so effects and
 * `useCallback`s can reference it without a dependency. The real tinfoil
 * module is only loaded when a probe actually runs (lazy provider chunk).
 */
const probeTinfoilModels = (set: (models: TinfoilModel[]) => void) =>
  void import("@/lib/tinfoil").then(async (tinfoil) => {
    const hasKey = await tinfoil.configureTinfoilFromKeychain();
    set(hasKey ? await tinfoil.listTinfoilModels() : []);
  });
interface ChatPaneProps {
  agent: Agent;
  messages: Message[];
  /**
   * Set when this pane is a group chat: the members share one transcript, so
   * every agent message names who said it and the composer can @ them.
   */
  group?: { id: string; name: string; members: readonly Agent[] };
  /** Rename the open group (its members move with it — see App.renameGroup). */
  onRenameGroup?: (name: string) => void;
  /**
   * This conversation's last save failed, so what is on screen is no longer
   * reaching disk. Almost always a transcript past the 8 MB slice cap.
   */
  notSaving?: boolean;
  /** True while the Blob is generating a reply; shows the thinking blob. */
  thinking?: boolean;
  /** In a group, which member is generating — `agent` is only the fallback. */
  thinkingAgent?: Agent;
  /** Ollama model tag driving replies; "" until one is chosen. */
  model: string;
  onModelChange: (model: string) => void;
  /** Whether the model may use chain-of-thought (slower, deeper). */
  reasoning: boolean;
  onReasoningChange: (on: boolean) => void;
  /** Files ride along with the message; the app saves them to the Blob's home. */
  onSend: (
    text: string,
    options?: { replyTo?: string; replyToId?: string; files?: readonly PickedFile[] },
  ) => void;
  /**
   * Ids of messages whose attachments are still being extracted — a PDF parse
   * or an OCR pass runs for seconds after the message is already on screen.
   */
  readingMessages?: readonly string[];
  /** Abort the in-flight reply, keeping any partial text. */
  onStop?: () => void;
  /** The Blob paused mid-task and waits on the user (ask_user). */
  waitingAsk?: "question" | "action" | undefined;
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
  if (message.kind === "event") {
    return message.text;
  }
  const text = message.segments.map((segment) => segment.text).join("");
  // An attachment-only message has no words to quote; its files name it.
  return text.trim() === ""
    ? (message.attachments ?? []).map((entry) => entry.name).join(", ")
    : text;
}

/**
 * How long a send waits for a thumbnail that is still rendering.
 *
 * Sending within a moment of picking is normal, and a thumbnail takes tens of
 * ms; waiting means the picture arrives with the message instead of a beat
 * later. Past this the message goes without it.
 */
const PREVIEW_WAIT_MS = 400;

/** Human-readable file size, matching the Files panel's format. */
function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * One attached file, shown as the thing it is: a picture for an image, a card
 * with icon and size for everything else.
 *
 * Rendered outside the text bubble (a sibling in the message row), because an
 * image wants no padding, no background and its own width — nesting it in a
 * bubble boxes every photo in a grey frame.
 */
function AttachmentView({ attachment, reading }: { attachment: Attachment; reading: boolean }) {
  // The name the user picked; `photo.png.txt` is our storage detail.
  const label = attachment.label ?? attachment.name;
  const kind = fileKind(label);

  // Only ever a data: image URL. Previews are read back from the plain-JSON
  // transcript, an editable file on disk, and this value goes straight into
  // `src` — an edited one must not be able to name any other scheme.
  const preview =
    attachment.preview?.startsWith("data:image/") === true ? attachment.preview : undefined;

  if (preview !== undefined) {
    return (
      <img className="attachment-image" src={preview} alt={label} title={label} draggable={false} />
    );
  }
  return (
    <span className={`attachment-card attachment-kind-${kind}`}>
      <span className="attachment-card-icon" aria-hidden="true">
        {kind === "image" ? (
          <ImageIcon size={18} strokeWidth={1.8} />
        ) : (
          <FileText size={18} strokeWidth={1.8} />
        )}
        <span className="attachment-card-badge">{fileBadge(label)}</span>
      </span>
      <span className="attachment-card-text">
        <span className="attachment-card-name">{label}</span>
        <span className="attachment-card-size">
          {reading ? "reading…" : fileSize(attachment.bytes)}
        </span>
      </span>
    </span>
  );
}

/** How long a silence before the transcript earns a new time divider. */
const TIME_DIVIDER_GAP_MS = 5 * 60_000;

/** "9:41 AM" — the wall-clock style the transcript dividers use. */
function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Tuesday, 12 August" — marks a message from a later day. */
function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/**
 * Divider text for a message, or null when it closely follows the previous
 * one on the same day. Like a messenger transcript, the time appears at the
 * start of the conversation and again after a silence or an overnight break —
 * not on every message. Legacy entries without a timestamp never get one and
 * never break the chain: the previous message's time simply carries forward.
 */
function dividerLabel(previous: number | null, ms: number): string | null {
  if (previous === null) {
    return clockLabel(ms);
  }
  if (new Date(previous).toDateString() !== new Date(ms).toDateString()) {
    return dayLabel(ms);
  }
  return ms - previous >= TIME_DIVIDER_GAP_MS ? clockLabel(ms) : null;
}

function TextBubble({
  message,
  palette,
}: {
  message: Extract<Message, { kind: "text" }>;
  palette?: MentionPalette | undefined;
}) {
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
  /** In a group, the Blob that said it — its name and face go above the bubble. */
  author?: Agent | undefined;
  /** In a group, the members' colours — highlights `@Name` in the text. */
  palette?: MentionPalette | undefined;
  reaction: string | undefined;
  pickerOpen: boolean;
  /** Arrived after mount: plays the in-place jelly pop exactly once. */
  fresh: boolean;
  /** The cursor is known to be elsewhere: suppresses a latched :hover. */
  stale: boolean;
  /** This message's attachments are still being extracted. */
  reading: boolean;
  onEnter: () => void;
  onTogglePicker: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
}

/** A bubble plus its hover/focus action bar, reaction picker and reaction badge. */
function MessageRow({
  message,
  author,
  palette,
  reaction,
  pickerOpen,
  fresh,
  stale,
  reading,
  onEnter,
  onTogglePicker,
  onReact,
  onReply,
}: MessageRowProps) {
  // Event lines are status, not speech: no actions, reactions or bubble.
  if (message.kind === "event") {
    return (
      <p className="timestamp-divider transcript-event" role="status">
        {message.text}
      </p>
    );
  }
  const side = message.kind === "text" && message.author === "user" ? "user" : "agent";
  return (
    <div
      // CSS :hover reveals the action bar; .message-row-stale hides it again
      // on every row that isn't the one the cursor last entered. Both are
      // needed: measured in the app's webview, a bar faded in by :hover stays
      // painted on rows that no longer match it, so sweeping down the
      // transcript left every bar showing until each was hovered again.
      className={`message-row message-row-${side}${fresh ? " message-fresh" : ""}${
        stale ? " message-row-stale" : ""
      }`}
      data-message-id={message.id}
      // pointerover, not pointerenter: it bubbles from the markdown children,
      // so entering the row anywhere claims it in one delegated listener.
      onPointerOver={onEnter}
    >
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
      {author === undefined || message.kind !== "text" || message.author !== "agent" ? null : (
        <span className="message-author">
          <BlobAvatar tone={author.tone} shape={author.shape} size={18} />
          {author.name}
        </span>
      )}
      {message.kind !== "text" || (message.attachments ?? []).length === 0 ? null : (
        <span className="message-attachments">
          {(message.attachments ?? []).map((attachment) => (
            // Keyed on the name the user picked, which does not change when the
            // saved name settles from `photo.png` to `photo.png.txt` — keying on
            // the saved name would remount the <img> and flash the picture.
            <AttachmentView
              key={attachment.label ?? attachment.name}
              attachment={attachment}
              reading={reading}
            />
          ))}
        </span>
      )}
      {/* The bubble and its hover bar share one line: the line hugs the
          bubble, so the bar can sit beside it, vertically centered — right of
          agent bubbles, left of user ones — instead of above it. */}
      <div className="message-line">
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
        {/* An attachment-only message has no words, so it gets no empty bubble. */}
        {message.kind !== "text" ? (
          <FileBubble message={message} />
        ) : message.segments.some((segment) => segment.text !== "") ? (
          <TextBubble message={message} palette={palette} />
        ) : null}
      </div>
      {reaction === undefined ? null : (
        <span className="bubble-reaction" role="img" aria-label={`Reacted with ${reaction}`}>
          {reaction}
        </span>
      )}
    </div>
  );
}

/** How many members the @-menu offers at once; the group cap is six. */
const MAX_MENTION_OPTIONS = 6;

/**
 * The "@name" being typed at the caret.
 *
 * Anchored to the start of a word, so an email address mid-sentence never
 * opens the menu. Spaces are part of the captured prefix because Blob names
 * routinely contain them ("Social Blob", "AI News Blob") — stopping at the
 * first space made the menu vanish halfway through typing the very names it
 * exists to complete.
 *
 * What closes the menu instead is having no match: the caller keeps it open
 * only while some member's name still starts with the prefix, so ordinary
 * prose after an "@" dismisses it within a word or two.
 */
const MENTION_TOKEN = /(?:^|\s)@([^@\n]*)$/u;

/** Cap the composer's growth at five text lines (5 × 20px + block padding). */
const COMPOSER_MAX_HEIGHT = 112;

/** Single-line textarea height; above this the composer switches to the
    expanded layout (text on top, buttons on their own bottom row). */
const COMPOSER_LINE_HEIGHT = 32;

export function ChatPane({
  agent,
  messages,
  notSaving = false,
  group,
  onRenameGroup,
  thinking = false,
  thinkingAgent,
  model,
  onModelChange,
  reasoning,
  onReasoningChange,
  onSend,
  onStop,
  waitingAsk,
  readingMessages = [],
  detailOpen,
  onToggleDetail,
  onOpenSettings,
}: ChatPaneProps) {
  const [draft, setDraft] = useState("");
  /** Files picked but not sent yet; they are saved only once the message goes.
      Keyed by id, not name: picking the same file twice is two chips. */
  const [attached, setAttached] = useState<
    { id: string; file: File; preview?: string; pending: Promise<string | undefined> }[]
  >([]);
  /** True while a drag hovers the composer, so the drop target is visible. */
  const [dragging, setDragging] = useState(false);
  /** The message being replied to: its preview, and its id — which is what
      routes the reply to one member in a group. */
  const [replyTo, setReplyTo] = useState<{ id: string; preview: string } | null>(null);
  /** Open @-mention menu: the partial name typed so far, or null. */
  const [mention, setMention] = useState<string | null>(null);
  /**
   * Highlighted option, or null for none.
   *
   * Null while the menu is merely *listing* who is here (a bare “@”): with a
   * first option pre-highlighted, the list reads as a choice already made
   * before the user has expressed any preference. Typing a prefix is that
   * preference, and highlights the best match.
   */
  const [mentionIndex, setMentionIndex] = useState<number | null>(null);
  /** Where the caret goes once a completed mention has rendered. */
  const pendingCaret = useRef<number | null>(null);
  /**
   * The group name being edited, or null when the field just shows the real
   * one. Dropping back to null on blur is what puts a rejected rename (empty,
   * or a name another group already has) back to the name that stuck.
   *
   * Mirrored in a ref because Escape has to blur to leave the field, and the
   * blur handler runs with the render's closure — reading state there would
   * commit the very edit Escape just abandoned.
   */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const nameDraftRef = useRef<string | null>(null);
  const editName = (value: string | null) => {
    nameDraftRef.current = value;
    setNameDraft(value);
  };
  const [replyClosing, setReplyClosing] = useState(false);
  const [reactions, setReactions] = useState<Record<string, string>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  /** Row the cursor is over: id, null for none, undefined until it first
      moves — see the effect below. */
  const [hoverId, setHoverId] = useState<string | null | undefined>(undefined);
  const [multiline, setMultiline] = useState(false);

  /** A reply is streaming and can be aborted (Escape, or the send circle). */
  const canStop = thinking && onStop !== undefined;

  // Escape interrupts the reply from anywhere in the app, matching the
  // circle. Registered only while a turn is in flight, and it yields to
  // whatever else owns Escape right now — an open modal, palette or picker —
  // so the key never aborts generation when the user meant "close this".
  useEffect(() => {
    if (!canStop || pickerFor !== null) {
      return;
    }
    // globalThis: bare KeyboardEvent is React's type, shadowed by the import.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && document.querySelector("[aria-modal='true']") === null) {
        onStop?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canStop, pickerFor, onStop]);

  // Rows claim the cursor on pointerover (see MessageRow); this is the other
  // half — anything entered outside a row means no row holds it. pointerover
  // bubbles all the way up, so moving to the sidebar, composer or header
  // releases the last row. Deliberately not a leave event: measured in the
  // app's webview, entering fires reliably on every row and its markdown
  // children, while the matching leave is what goes missing.
  useEffect(() => {
    const clear = (event: Event) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest("[data-message-id]") === null
      ) {
        setHoverId(null);
      }
    };
    const clearAll = () => setHoverId(null);
    window.addEventListener("pointerover", clear);
    document.addEventListener("mouseleave", clearAll);
    window.addEventListener("blur", clearAll);
    return () => {
      window.removeEventListener("pointerover", clear);
      document.removeEventListener("mouseleave", clearAll);
      window.removeEventListener("blur", clearAll);
    };
  }, []);

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
  /** The coloured copy of the draft sitting under the textarea. */
  const mirrorRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Whether the view is close enough to the bottom to auto-follow. */
  const nearBottomRef = useRef(true);
  const prevMessageCount = useRef(messages.length);
  /** True while a programmatic smooth scroll is in flight; its intermediate
      scroll events must not be mistaken for the user scrolling up. */
  const autoScrollRef = useRef(false);
  /**
   * Whether a pane resize is in flight, and whether it should hold the bottom.
   *
   * `null` when idle. Set once at the start of a resize burst and read for its
   * duration, because the reflow fires scroll events that would otherwise
   * rewrite the answer halfway through.
   */
  const resizingRef = useRef<boolean | null>(null);
  const flipRects = useRef(new Map<string, DOMRect>());

  /** What "this conversation" means here: one Blob, or one group. */
  const conversationKey = group?.id ?? agent.id;

  // Mention colours, groups only: a 1-to-1 chat has nobody to address, so
  // there is nothing to disambiguate and "@" is just a character.
  //
  // Keyed by what the palette is actually built from, not by the array: the
  // parent rebuilds `group` inline every render, so array identity changes on
  // every streamed delta — and a new palette invalidates MarkdownContent's
  // plugin memo, re-parsing every bubble in the transcript with it.
  const members = group?.members;
  const signature = members
    ?.map((member) => `${member.id}:${member.name}:${member.tone}`)
    .join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` is the stable form of `members`
  const palette = useMemo(
    () => (members === undefined ? undefined : mentionPalette(members)),
    [signature],
  );

  // Messages already on screen when this conversation opened. Anything newer
  // is "fresh" and pops in with the jelly animation — exactly once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot messages only when the conversation switches
  const initialIds = useMemo(() => new Set(messages.map((entry) => entry.id)), [conversationKey]);

  // Time dividers per message id, computed over the WHOLE transcript (not the
  // visible slice) so paging older messages in keeps each divider anchored to
  // the message it belongs to.
  const dividers = useMemo(() => {
    const byId = new Map<string, string>();
    let previous: number | null = null;
    for (const entry of messages) {
      if (entry.timestampMs === undefined) {
        continue;
      }
      const label = dividerLabel(previous, entry.timestampMs);
      previous = entry.timestampMs;
      if (label !== null) {
        byId.set(entry.id, label);
      }
    }
    return byId;
  }, [messages]);

  /**
   * Load the downloaded models for the header picker.
   *
   * Also re-run on demand (see the select's handlers): fetching only at mount
   * leaves the list empty forever if Ollama was starting up at the time, and
   * stale after the user pulls or removes a model with the app open.
   */
  const refreshModels = useCallback(() => {
    void listOllamaModels().then(setAvailableModels);
    // The keychain probe is memoized per session (see tinfoil.ts): reading
    // the keychain can prompt for the device password, so it happens at most
    // once, and never at mount unless a Tinfoil model is already selected.
    probeTinfoilModels(setTinfoilModels);
  }, []);

  // On mount, list local models always but only probe the keychain when the
  // saved model needs it — otherwise wait for the user to open the picker.
  // biome-ignore lint/correctness/useExhaustiveDependencies(model): mount-only probe; the picker's onOpen re-runs it
  useEffect(() => {
    void listOllamaModels().then(setAvailableModels);
    if (isTinfoilModel(model)) {
      probeTinfoilModels(setTinfoilModels);
    }
  }, []);

  // Fresh conversation, fresh composer: clear the draft, reply chip and
  // reaction picker when switching Blobs so state never leaks across.
  // biome-ignore lint/correctness/useExhaustiveDependencies(conversationKey): only the switch matters
  useEffect(() => {
    setDraft("");
    setAttached([]);
    setDragging(false);
    setMention(null);
    // Inlined rather than through `editName`: a non-stable function in here
    // is one the dependency lint has to be argued with.
    nameDraftRef.current = null;
    setNameDraft(null);
    setReplyTo(null);
    setReplyClosing(false);
    setPickerFor(null);
    setHoverId(undefined);
    setMultiline(false);
    setReactions({});
    setUnseenCount(0);
    setVisibleCount(MESSAGE_PAGE_SIZE);
    setShowJump(false);
    // A page-load pending at switch time must not survive: its geometry
    // belongs to the old conversation, and a stale anchor blocks paging.
    loadAnchorRef.current = null;
    nearBottomRef.current = true;
    // Same for a resize still in flight. Its settle timer would otherwise fire
    // against the new conversation and overwrite the line above with the old
    // one's geometry, leaving a chat that opens at the bottom convinced the
    // user had scrolled up.
    resizingRef.current = null;
  }, [conversationKey]);

  // Older page mounted above the viewport: keep what the user was looking at
  // stationary by offsetting the scroll position with the added height.
  // biome-ignore lint/correctness/useExhaustiveDependencies(visibleCount): re-anchor exactly when the page mounts
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = loadAnchorRef.current;
    loadAnchorRef.current = null;
    if (el !== null && anchor !== null) {
      // `behavior: "instant"`, because the pane sets `scroll-behavior: smooth`
      // and would otherwise animate this correction — turning a page-in that
      // should be invisible into a visible slide.
      el.scrollTo({ top: anchor.top + (el.scrollHeight - anchor.height), behavior: "instant" });
    }
  }, [visibleCount]);

  // Hold the bottom while the pane is resized.
  //
  // Showing or hiding a side panel animates the chat's width for 260ms, and a
  // narrower pane wraps the same text into more lines. The transcript grows
  // downward from a fixed scrollTop, so the newest message walks up off the
  // bottom edge — the view scrolls itself while the user is doing nothing but
  // opening a sidebar, and the "jump to latest" arrow appears over a
  // conversation they never left.
  //
  // The burst has to be treated as one gesture, exactly as a programmatic
  // glide is. Each reflow frame fires a scroll event, and by the time the
  // observer runs, that handler has already recorded the grown transcript as
  // "user scrolled up" — so pinning on `nearBottomRef` alone reads a flag the
  // resize itself just falsified, and does nothing. Deciding once, at the
  // start of the burst, is what makes it hold.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver !== "function") {
      return;
    }
    let settle: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      // First frame of the burst: was the user following the conversation
      // before any of this reflow happened?
      if (resizingRef.current === null) {
        resizingRef.current = nearBottomRef.current;
      }
      if (resizingRef.current) {
        // `behavior: "instant"` rather than assigning `scrollTop`, which the
        // pane's own `scroll-behavior: smooth` turns into an animation: the
        // correction then chases the reflow a frame behind, which is the
        // spring — content lands, then visibly slides down to settle. The
        // keyword overrides the stylesheet, so each frame is placed outright.
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
        // Called every frame of the transition, which is fine: React bails
        // out of re-rendering when the state is already `false`.
        setShowJump(false);
      }
      clearTimeout(settle);
      // Comfortably past the 260ms panel transition, so a burst is not split
      // into two and judged twice.
      settle = setTimeout(() => {
        // WebKit can leave the scroll extent stale after a width transition:
        // the last per-frame pin read `scrollHeight` mid-reflow, so scrollTop
        // can sit past the final, shorter content — a pane that shows blank
        // until the user scrolls and the engine re-clamps (seen live in the
        // Tauri webview, 2026-08-19). One clamp at settle ends the burst at a
        // position that actually exists, without stealing a scrolled-up
        // user's position (it only corrects overscroll).
        const max = el.scrollHeight - el.clientHeight;
        if (el.scrollTop > max) {
          el.scrollTo({ top: max, behavior: "instant" });
        }
        resizingRef.current = null;
        nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }, 320);
    });
    observer.observe(el);
    return () => {
      clearTimeout(settle);
      observer.disconnect();
    };
  }, []);

  const scrollToLatest = (behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (el !== null) {
      autoScrollRef.current = behavior === "smooth";
      nearBottomRef.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior });
      if (behavior === "instant") {
        // WebKit can report a stale scroll extent at pin time: a conversation
        // switch measures scrollHeight mid-swap (old messages tearing down,
        // new ones with async layout still settling), so the pin lands past
        // the real content — overscroll, the thread pushed up with blank
        // below, and the engine does not re-clamp until the first user scroll
        // (seen live in the Tauri webview, same family as the resize-burst
        // clamp below). One re-pin two frames later, when layout has settled,
        // lands on the extent that actually exists. Guarded by nearBottomRef
        // so a user who scrolled up inside those two frames is not yanked.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const settled = scrollRef.current;
            if (settled !== null && nearBottomRef.current) {
              settled.scrollTo({ top: settled.scrollHeight, behavior: "instant" });
            }
          }),
        );
      }
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
    const latest = messages.at(-1);
    if (arrived > 0 && latest?.kind === "text" && latest.author === "user") {
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
    // A completed mention asked for the caret to land mid-draft; the value is
    // on screen now, so this is the first moment the range is valid.
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    // Past five lines the textarea scrolls; the mirror has to scroll with it
    // or the colours drift away from the words they belong to.
    if (mirrorRef.current !== null) {
      mirrorRef.current.scrollTop = el.scrollTop;
    }
    // simplification: sticky until the draft is cleared — the expanded layout
    // widens the textarea, so re-measuring there would flip-flop for text that
    // only wraps at the narrow inline width.
    if (draft.length === 0) {
      setMultiline(false);
    } else if (next > COMPOSER_LINE_HEIGHT) {
      setMultiline(true);
    }
  }, [draft]);

  const hasDraft = draft.trim().length > 0 || attached.length > 0;

  /** Take picked or dropped files, up to the cap; the rest are dropped here
      rather than sent and rejected one by one downstream. */
  const addFiles = (picked: FileList | readonly File[] | null) => {
    // A group has no home folder to save into, so a file dropped or pasted
    // here would be shown as a chip and then silently discarded on send. The
    // attach button is already hidden; this is the same rule for every other
    // way a file can arrive.
    if (picked === null || group !== undefined) {
      return;
    }
    // The thumbnail promise is started here and kept on the entry, so a send
    // that lands before it resolves can await it rather than shipping the
    // message without its picture.
    const incoming = [...picked].map((file) => ({
      id: crypto.randomUUID(),
      file,
      pending: imagePreview(file),
    }));
    if (incoming.length === 0) {
      return;
    }
    setAttached((previous) => [...previous, ...incoming].slice(0, MAX_ATTACHMENTS));
    textareaRef.current?.focus();
    // Thumbnails fill in behind the tiles. Object URLs would be faster, but
    // they need revoking on every removal path; these are small and the same
    // data URL the sent message will carry.
    for (const entry of incoming) {
      void entry.pending.then((preview) => {
        if (preview === undefined) {
          return;
        }
        setAttached((previous) =>
          previous.map((item) => (item.id === entry.id ? { ...item, preview } : item)),
        );
      });
    }
  };

  /** The circle shows Stop only with an empty composer: a draft typed mid-turn
      is a follow-up that steers the running loop, so Send must stay reachable. */
  const showStop = canStop && !hasDraft;

  // FLIP: whenever a composer control lands somewhere new (layout switch or
  // reply chip appearing), glide it from its old position instead of
  // teleporting. Rects are recorded every render so they never go stale, but
  // glides only play when layout-changing state moved — animating per
  // keystroke would measure mid-transition rects and jitter the buttons on
  // every character. The send button's mic→arrow swap is deliberately not a
  // trigger: it has its own pop-in and the mic's small shift should be
  // instant.
  const flipTrigger = `${multiline}|${replyTo !== null}|${attached.length > 0}`;
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
    // Files alone are a valid message: "here, look at this".
    if (text.length === 0 && attached.length === 0) {
      return;
    }
    const replying = replyTo !== null && !replyClosing ? replyTo : undefined;
    const reply =
      replying === undefined ? {} : { replyTo: replying.preview, replyToId: replying.id };
    // Cleared first, so the composer empties on this frame however long the
    // thumbnails take.
    const sending = attached;
    setDraft("");
    setAttached([]);
    setMention(null);
    closeReply();

    if (sending.length === 0) {
      onSend(text, reply);
      return;
    }
    // The thumbnail rides along: the composer already made it, and rebuilding
    // it after the send is what made the picture pop in a beat late. Sending
    // within a few hundred ms of picking is normal, so an unresolved one is
    // awaited rather than dropped.
    void Promise.all(
      sending.map(async ({ file, preview, pending }) => {
        // A picture is worth a short wait, never a stuck send.
        const settled =
          preview ??
          (await Promise.race([
            pending.catch(() => undefined),
            new Promise<undefined>((resolve) => setTimeout(resolve, PREVIEW_WAIT_MS, undefined)),
          ]));
        return { file, ...(settled === undefined ? {} : { preview: settled }) };
      }),
    ).then((files) => onSend(text, { ...reply, files }));
  };

  /**
   * Members whose name starts with what has been typed after the "@".
   *
   * Empty means the menu is closed — which, with spaces allowed in the prefix,
   * is also what dismisses it when the "@" turns out to be prose rather than
   * an address.
   */
  const mentionMatches =
    mention === null || group === undefined
      ? []
      : group.members
          .filter((member) => member.name.toLowerCase().startsWith(mention.toLowerCase()))
          .slice(0, MAX_MENTION_OPTIONS);

  /**
   * Track the partial "@name" the caret sits in, so the member list can offer
   * completions. Only ever the token being typed — an "@" the caret has moved
   * away from is finished text, not a menu.
   */
  const trackMention = (value: string, caret: number) => {
    if (group === undefined) {
      return;
    }
    const typed = MENTION_TOKEN.exec(value.slice(0, caret));
    const prefix = typed?.[1] ?? null;
    setMention(prefix);
    setMentionIndex(prefix === null || prefix === "" ? null : 0);
  };

  /** Replace the half-typed "@na" under the caret with the member's full name. */
  const completeMention = (name: string) => {
    const field = textareaRef.current;
    const caret = field?.selectionStart ?? draft.length;
    const typed = MENTION_TOKEN.exec(draft.slice(0, caret));
    if (typed === null) {
      return;
    }
    const start = caret - typed[0].length + (typed[0].startsWith("@") ? 0 : 1);
    setDraft(`${draft.slice(0, start)}@${name} ${draft.slice(caret)}`);
    setMention(null);
    // Put the caret after the inserted name, not at the end of the draft:
    // mentions are often typed mid-sentence. Handed to the layout effect
    // below rather than set from a frame callback — anything typed before that
    // frame ran landed at the old caret, scrambling the words after it.
    pendingCaret.current = start + name.length + 2;
    field?.focus();
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
    setReplyTo({ id: message.id, preview: messagePreview(message) });
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
    // The @-menu owns the arrows, Tab, Enter and Escape while it is open:
    // Enter must complete the mention, not send a half-typed one.
    if (mentionMatches.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        // From "nothing highlighted", Down takes the first option and Up the
        // last — either arrow is a deliberate first move.
        setMentionIndex((index) => {
          if (index === null) {
            return event.key === "ArrowDown" ? 0 : mentionMatches.length - 1;
          }
          const step = event.key === "ArrowDown" ? 1 : mentionMatches.length - 1;
          return (index + step) % mentionMatches.length;
        });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        // Tab always completes — that is what Tab means in a list like this.
        // Enter only completes something actually highlighted, so pressing it
        // against a bare “@” sends the message instead of picking for you.
        const picked =
          mentionIndex === null
            ? event.key === "Tab"
              ? mentionMatches[0]
              : undefined
            : mentionMatches[mentionIndex];
        if (picked !== undefined) {
          event.preventDefault();
          completeMention(picked.name);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    // Enter sends; Shift+Enter inserts a newline; Escape cancels a reply
    // (unless a reply is streaming — then the window handler stops it).
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape" && !canStop && replyTo !== null) {
      closeReply();
    }
  };

  return (
    <section
      className="chat-pane"
      aria-label={group === undefined ? `Conversation with ${agent.name}` : `Group ${group.name}`}
    >
      <header className="chat-header" data-tauri-drag-region>
        {/* drag-region only fires on the element itself, so the header stays
            draggable around this identity button. */}
        {group === undefined ? (
          <button
            type="button"
            className="chat-header-identity identity-button"
            aria-label={`${agent.name} settings`}
            onClick={onOpenSettings}
          >
            <BlobAvatar tone={agent.tone} shape={agent.shape} size={24} />
            <h1 className="chat-title">{agent.name}</h1>
          </button>
        ) : (
          <div className="chat-header-identity">
            <span className="chat-group-faces" aria-hidden="true">
              {group.members.slice(0, 3).map((member) => (
                <BlobAvatar key={member.id} tone={member.tone} shape={member.shape} size={24} />
              ))}
            </span>
            {/* The title is the rename field: there is nowhere else to edit
                it, and a name nobody can change stays "New Group" forever.
                Commit on blur or Enter; Escape abandons the edit. */}
            <input
              className="chat-title chat-title-input"
              aria-label="Group name"
              value={nameDraft ?? group.name}
              maxLength={MAX_BLOB_NAME_LENGTH}
              onChange={(event) => editName(event.currentTarget.value)}
              onBlur={() => {
                if (nameDraftRef.current !== null) {
                  onRenameGroup?.(nameDraftRef.current);
                }
                editName(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  editName(null);
                  event.currentTarget.blur();
                }
              }}
            />
            <span className="chat-group-count">
              {group.members.length === 1 ? "1 Blob" : `${group.members.length} Blobs`}
            </span>
          </div>
        )}
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
          {/* The details panel is one Blob's memories, files and routines —
              there is no group-wide version of it. */}
          {group === undefined ? (
            <button
              type="button"
              className="icon-button"
              aria-label={detailOpen ? "Hide details panel" : "Show details panel"}
              aria-pressed={detailOpen}
              onClick={onToggleDetail}
            >
              <Monitor size={17} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : null}
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
          // Reflow from a pane resize is not the user scrolling: the scroll
          // events it fires would flip this to "scrolled up" and raise the
          // jump arrow over a conversation nobody left.
          if (resizingRef.current !== null) {
            return;
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
        {(messages.length > visibleCount ? messages.slice(-visibleCount) : messages).flatMap(
          (message) => [
            ...(dividers.has(message.id)
              ? [
                  <p className="timestamp-divider" key={`${message.id}-divider`}>
                    {dividers.get(message.id)}
                  </p>,
                ]
              : []),
            <MessageRow
              fresh={!initialIds.has(message.id)}
              key={message.id}
              message={message}
              author={
                message.kind === "text"
                  ? group?.members.find((member) => member.id === message.authorId)
                  : undefined
              }
              palette={palette}
              reaction={reactions[message.id]}
              pickerOpen={pickerFor === message.id}
              stale={hoverId !== undefined && hoverId !== message.id}
              reading={readingMessages.includes(message.id)}
              onEnter={() => setHoverId(message.id)}
              onTogglePicker={() => setPickerFor(pickerFor === message.id ? null : message.id)}
              onReact={(emoji) => toggleReaction(message.id, emoji)}
              onReply={() => startReply(message)}
            />,
          ],
        )}
        {/* Always mounted: reserves its space (nothing overlaps or jumps) and
            lets the blob fade in/out instead of popping with the DOM. */}
        <div
          className={thinking ? "thinking-row thinking-row-visible" : "thinking-row"}
          role="status"
          aria-hidden={!thinking}
          aria-label={thinking ? `${(thinkingAgent ?? agent).name} is thinking` : undefined}
        >
          <BlobAvatar
            tone={(thinkingAgent ?? agent).tone}
            shape={(thinkingAgent ?? agent).shape}
            size={30}
            variant="thinking"
          />
        </div>
        {waitingAsk === "action" ? (
          <div className="ask-action-bar" role="status">
            <span>{agent.name} needs you to do something above.</span>
            <button type="button" className="modal-button" onClick={() => onSend("Done.")}>
              Done
            </button>
          </div>
        ) : null}
        {/* Sits in the transcript flow, under the last message, because that
            is where the unsaved messages are. `alert`, not `status`: this is
            about to cost the user data, and it stays until a save succeeds. */}
        {notSaving ? (
          <div className="not-saving-bar" role="alert">
            <TriangleAlert size={15} strokeWidth={2} aria-hidden="true" />
            <span>
              This conversation is too long to save. New messages stay on screen but will be lost
              when you quit — start a new chat to keep them.
            </span>
          </div>
        ) : null}
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
        className={[
          "composer",
          multiline || replyTo !== null || attached.length > 0 ? "composer-expanded" : "",
          dragging ? "composer-dragging" : "",
        ]
          .filter((entry) => entry !== "")
          .join(" ")}
        onSubmit={submit}
        // Dropping a file anywhere on the composer attaches it. preventDefault
        // on dragover is what makes the drop fire at all; without it the
        // webview navigates away to the file instead.
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
      >
        {attached.length === 0 ? null : (
          <ul className="composer-attachments" aria-label="Attached files">
            {attached.map(({ id, file, preview }) => (
              <li key={id} className={preview === undefined ? "composer-file" : "composer-thumb"}>
                {preview === undefined ? (
                  <>
                    <span
                      className={`attachment-card-icon attachment-kind-${fileKind(file.name)}`}
                      aria-hidden="true"
                    >
                      <FileText size={16} strokeWidth={1.8} />
                      <span className="attachment-card-badge">{fileBadge(file.name)}</span>
                    </span>
                    <span className="composer-file-text">
                      <span className="attachment-card-name">{file.name}</span>
                      <span className="attachment-card-size">{fileSize(file.size)}</span>
                    </span>
                  </>
                ) : (
                  <img src={preview} alt={file.name} title={file.name} draggable={false} />
                )}
                <button
                  type="button"
                  className="icon-button attachment-remove"
                  aria-label={`Remove ${file.name}`}
                  onClick={() =>
                    setAttached((previous) => previous.filter((entry) => entry.id !== id))
                  }
                >
                  <X size={12} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
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
            <span className="composer-reply-text">{replyTo.preview}</span>
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
        {mentionMatches.length === 0 ? null : (
          <ul className="composer-mentions" aria-label="Mention a Blob">
            {mentionMatches.map((member, index) => (
              <li key={member.id}>
                <button
                  type="button"
                  className={
                    index === mentionIndex
                      ? "composer-mention composer-mention-active"
                      : "composer-mention"
                  }
                  // The textarea would blur before the click landed, and the
                  // blur closes the menu.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => completeMention(member.name)}
                >
                  <BlobAvatar tone={member.tone} shape={member.shape} size={18} />
                  {member.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-main">
          {/* Both, or neither: a file is saved in one Blob's home folder and
              read back from there at turn time, and a group has no home of its
              own — so a group pane takes no files by any route (drag and paste
              are refused in `addFiles` for the same reason). */}
          {group === undefined ? (
            <>
              <button
                type="button"
                className="icon-button composer-add"
                aria-label="Add attachment"
                data-flip="add"
                disabled={attached.length >= MAX_ATTACHMENTS}
                onClick={() => fileInputRef.current?.click()}
              >
                <Plus size={16} strokeWidth={2} aria-hidden="true" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="visually-hidden"
                aria-label="Attach files"
                onChange={(event) => {
                  addFiles(event.currentTarget.files);
                  // Reset so picking the same file twice in a row still fires.
                  event.currentTarget.value = "";
                }}
              />
            </>
          ) : null}
          {/* The field is the textarea plus a coloured copy of the draft
              underneath it, so the mentions you are typing already carry
              their Blob's colour. A textarea cannot hold styled runs at all,
              and a contenteditable would cost IME handling, undo and paste
              sanitising — for a highlight.

              The wrapper carries `data-flip` in the textarea's place: it
              occupies exactly the box the textarea used to, so the composer's
              FLIP glides are unchanged. */}
          <div className="composer-field" data-flip="input">
            {/* `partial`: the name being typed is coloured as soon as one Blob
                can complete it, so the colour arrives with the word rather
                than on its final character. */}
            {palette === undefined || draft === "" ? null : (
              <div className="composer-mirror" aria-hidden="true" ref={mirrorRef}>
                {withMentions(draft, palette, { partial: true })}
              </div>
            )}
            <textarea
              ref={textareaRef}
              rows={1}
              className={
                palette === undefined ? "composer-input" : "composer-input composer-input-mirrored"
              }
              placeholder={
                replyTo !== null
                  ? "Reply..."
                  : group === undefined
                    ? `Message ${agent.name}`
                    : `Message ${group.name} \u2014 @ a Blob to ask just them`
              }
              aria-label={`Message ${group === undefined ? agent.name : group.name}`}
              value={draft}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                trackMention(event.currentTarget.value, event.currentTarget.selectionStart);
              }}
              // The caret can leave a half-typed mention without the text
              // changing at all — an arrow key or a click closes the menu.
              onSelect={(event) =>
                trackMention(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onBlur={() => setMention(null)}
              onKeyDown={onComposerKeyDown}
              // Keeps the coloured mirror aligned once the draft outgrows the
              // five-line cap and the textarea starts scrolling.
              onScroll={(event) => {
                if (mirrorRef.current !== null) {
                  mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
                }
              }}
              // A pasted file attaches; every paste without one (plain text,
              // a link) falls through to the default handler untouched.
              onPaste={(event) => {
                if (event.clipboardData.files.length > 0) {
                  event.preventDefault();
                  addFiles(event.clipboardData.files);
                }
              }}
            />
          </div>
          {/* One circle, fixed position: its glyph cross-fades arrow↔stop.
              With an empty composer mid-reply it is the Stop button (Escape
              does the same), so the control that starts a turn also ends it.
              Idle with nothing typed it is a disabled Send — there is no
              dictation to offer yet. */}
          <button
            type={hasDraft ? "submit" : "button"}
            className="composer-mic"
            aria-label={showStop ? "Stop replying" : "Send message"}
            data-flip="mic"
            data-stop={showStop}
            disabled={!hasDraft && !showStop}
            onClick={showStop ? onStop : undefined}
          >
            <span className="composer-mic-glyph" data-visible={!showStop}>
              <ArrowUp size={17} strokeWidth={2.4} aria-hidden="true" />
            </span>
            <span className="composer-mic-glyph" data-visible={showStop}>
              <Square size={11} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </span>
          </button>
        </div>
      </form>
    </section>
  );
}
