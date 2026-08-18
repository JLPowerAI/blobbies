import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useExitAnimation } from "@/lib/useExitAnimation";

interface ModalShellProps {
  /** Heading text, and the noun in the close button's label. */
  title: string;
  /** Short status shown beside the title, e.g. a count. */
  titleNote?: string;
  /** Full label for assistive tech, e.g. "Ken system prompt". */
  ariaLabel: string;
  children: ReactNode;
  onClose: () => void;
}

/**
 * Fixed-size dialog with a pinned header and a scrolling body.
 *
 * Shared by every panel-launched dialog so dismissal behaves identically:
 * backdrop click, Escape, and the same animated exit as the settings dialog.
 *
 * Two details are load-bearing, and both were bugs first:
 *
 * The header sits OUTSIDE the scroller. The settings dialog absolutely
 * positions its close button inside the scrolling content, which is fine for a
 * short pane, but these dialogs always overflow — the way out would scroll off
 * the top and strand the reader.
 *
 * It is portalled to the body because the triggers live inside the sliding
 * details panel: that panel is `overflow: hidden` and takes a `transform` when
 * closed, and a transformed ancestor becomes the containing block for
 * `position: fixed`, so the backdrop would be clipped to a 322px column and
 * ride off screen with the panel instead of covering the window.
 */
export function ModalShell({ title, titleNote, ariaLabel, children, onClose }: ModalShellProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { closing, requestClose, finishClose } = useExitAnimation(onClose);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss mirrors the Escape path
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the dialog itself
    <div
      className={closing ? "modal-backdrop modal-backdrop-closing" : "modal-backdrop"}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          requestClose();
        }
      }}
      onAnimationEnd={(event) => {
        // Wait for the backdrop's own fade-out, not bubbled child animations.
        if (closing && event.target === event.currentTarget) {
          finishClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={
          closing
            ? "settings-modal prompt-modal settings-modal-closing"
            : "settings-modal prompt-modal"
        }
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            requestClose();
          }
        }}
      >
        <header className="prompt-modal-header">
          <h2 className="prompt-modal-title">
            {title}
            {/* Inside the heading, so screen readers announce "Memories 6"
                as one thing rather than reading a stray number. */}
            {titleNote === undefined ? null : (
              <span className="prompt-modal-note">{titleNote}</span>
            )}
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label={`Close ${title.toLowerCase()}`}
            onClick={requestClose}
          >
            <X size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>
        <div className="prompt-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
