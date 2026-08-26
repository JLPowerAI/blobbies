import { Clock } from "lucide-react";
import type { Message } from "@/data/agents";

/** Event lines are status, not speech: no actions, reactions or bubble. */
export function EventLine({ message }: { message: Extract<Message, { kind: "event" }> }) {
  return (
    <p className="timestamp-divider transcript-event" role="status">
      {message.text}
      {message.subject === undefined ? null : (
        <>
          {" "}
          {/* The same clock the Routines list puts beside a routine, so the
              two read as the same object in two places. Decorative: the
              label right next to it already says what this is. */}
          <Clock className="transcript-event-icon" size={14} strokeWidth={1.8} aria-hidden="true" />{" "}
          <span className="transcript-event-subject">{message.subject.label}</span>
        </>
      )}
    </p>
  );
}
