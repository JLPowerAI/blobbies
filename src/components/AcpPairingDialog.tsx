import { createPortal } from "react-dom";
import type { AcpPairingRequest } from "@/lib/acp/useAcpBridge";

interface AcpPairingDialogProps {
  request: AcpPairingRequest;
  onApprove: () => void;
  onDeny: () => void;
}

/**
 * "An editor wants to talk to your Blobs."
 *
 * The one place a person decides whether a local process gets to drive Blobs —
 * their shell tools, their home folders, their MCP credentials — so it names
 * what is being granted and defaults to refusal: Escape, the backdrop and the
 * dialog's autofocused button all say no.
 *
 * The client's name is whatever that process claimed in `initialize`. React
 * escapes it and `useAcpBridge` strips control characters and clips the
 * length, so it cannot dress itself up as the surrounding copy.
 */
export function AcpPairingDialog({ request, onApprove, onDeny }: AcpPairingDialogProps) {
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss mirrors Escape
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the dialog
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onDeny();
        }
      }}
    >
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="An editor wants to connect"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onDeny();
          }
        }}
      >
        <h2 className="confirm-title">Let this editor talk to your Blobs?</h2>
        <p className="confirm-body">
          <strong>{request.name}</strong> is asking to chat with your Blobs from outside Blobbies.
          It gets the same Blobs, memories and tools you see here — including running commands in
          their home folders. Only allow it if you just set this up.
        </p>
        <div className="confirm-actions">
          <button
            type="button"
            className="modal-button"
            // biome-ignore lint/a11y/noAutofocus: the safe choice takes focus, so Enter refuses
            autoFocus
            onClick={onDeny}
          >
            Don't allow
          </button>
          <button type="button" className="modal-button" onClick={onApprove}>
            Allow
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
