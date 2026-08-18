import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useExitAnimation } from "@/lib/useExitAnimation";

interface SystemPromptModalProps {
  /** The Blob whose prompt this is; named in the title and the aria label. */
  blobName: string;
  /** The exact text a turn would send, already built by the caller. */
  prompt: string;
  onClose: () => void;
}

/**
 * Read-only view of the exact prompt the Blob runs with.
 *
 * A dialog rather than the disclosure it replaces: the prompt is long enough
 * that expanding it in the settings column pushed everything below it off
 * screen, so reading it meant losing your place in the panel. It shares the
 * settings dialog's shell and dismissal (backdrop click, Escape, animated
 * exit) minus the rail, which has nothing to switch between here.
 *
 * Portalled to the body because its trigger lives inside the sliding details
 * panel: that panel is `overflow: hidden` and takes a `transform` when closed,
 * and a transformed ancestor becomes the containing block for `position:
 * fixed`, so the backdrop would be clipped to a 322px column and ride off
 * screen with the panel instead of covering the window.
 */
export function SystemPromptModal({ blobName, prompt, onClose }: SystemPromptModalProps) {
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
        aria-label={`${blobName} system prompt`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            requestClose();
          }
        }}
      >
        {/* Header outside the scroller: the settings dialog absolutely
            positions its close button inside the scrolling content, which is
            fine for a short pane but here the prompt always overflows — the
            way out would scroll off the top and strand the reader. */}
        <header className="prompt-modal-header">
          <h2 className="prompt-modal-title">System prompt</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close system prompt"
            onClick={requestClose}
          >
            <X size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>
        <div className="prompt-modal-body">
          <pre className="prompt-preview-body">{prompt}</pre>
        </div>
      </div>
    </div>,
    document.body,
  );
}
