import { ModalShell } from "@/components/ModalShell";

interface SystemPromptModalProps {
  /** The Blob whose prompt this is; named in the aria label. */
  blobName: string;
  /** The prompt text, already built by the caller. */
  prompt: string;
  onClose: () => void;
}

/**
 * Read-only view of the prompt the Blob runs with.
 *
 * A dialog rather than the disclosure it replaces: the prompt is long enough
 * that expanding it in the settings column pushed everything below it off
 * screen, so reading it meant losing your place in the panel.
 *
 * What it shows is the real prompt with the saved facts stood down to a count
 * — the facts themselves are the Memories dialog's job. Two screens listing
 * the same facts means two places to keep in sync and a wall of text between
 * the reader and the prompt structure they opened this to see.
 */
export function SystemPromptModal({ blobName, prompt, onClose }: SystemPromptModalProps) {
  return (
    <ModalShell title="System prompt" ariaLabel={`${blobName} system prompt`} onClose={onClose}>
      <pre className="prompt-preview-body">{prompt}</pre>
    </ModalShell>
  );
}
