import { Download } from "lucide-react";
import type { Message } from "@/data/agents";

export function FileBubble({ message }: { message: Extract<Message, { kind: "file" }> }) {
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
