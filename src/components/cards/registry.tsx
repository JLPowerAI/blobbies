import type { ComponentType, ReactNode } from "react";
import { EventLine } from "@/components/cards/EventLine";
import { FileBubble } from "@/components/cards/FileBubble";
import { TextBubble } from "@/components/cards/TextBubble";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { Message } from "@/data/agents";
import type { MentionPalette } from "@/lib/mentions";

/**
 * Which view renders which kind of message.
 *
 * A table rather than a chain of conditionals in the transcript, for one
 * reason that is not tidiness: a transcript is a plain JSON file the user is
 * told they may edit, and a newer build can write kinds this one has never
 * heard of. A lookup has somewhere to put the miss — the placeholder below —
 * where a conditional falls through to `undefined` and takes the pane down
 * with it.
 */

/** Everything a card may be handed; each one takes what it needs. */
export interface CardContext {
  palette?: MentionPalette | undefined;
  /** Run this message's turn again. Only failed messages offer it. */
  onRetry?: (() => void) | undefined;
  /** Take a failed message out of the transcript for good. */
  onDismiss?: (() => void) | undefined;
}

interface CardEntry<K extends Message["kind"]> {
  /**
   * Renders in place of the whole message row: no bubble, no hover bar, no
   * reactions. Status lines, not speech.
   */
  standalone?: boolean;
  Card: ComponentType<CardContext & { message: Extract<Message, { kind: K }> }>;
}

const CARDS: { [K in Message["kind"]]: CardEntry<K> } = {
  text: { Card: TextBubble },
  file: { Card: FileBubble },
  event: { standalone: true, Card: EventLine },
};

/**
 * A message this build cannot draw: a kind from a newer version, a
 * hand-edited one, or a card that threw on the way to the screen.
 *
 * Deliberately does not print the offending kind or error. This is a line in
 * someone's conversation, not a log; the console has the detail, and a raw
 * type name here would read as damage rather than as a gap.
 */
function UnknownCard() {
  return (
    <p aria-live="polite" className="timestamp-divider card-unavailable" role="note">
      This message can't be shown in this version of Blobbies.
    </p>
  );
}

export interface RenderedCard {
  /** True when the card replaces the row rather than sitting inside it. */
  standalone: boolean;
  node: ReactNode;
}

export function messageCard(message: Message, context: CardContext = {}): RenderedCard {
  // The registry is keyed by the kinds the type knows about; a message read
  // back from disk can carry any string.
  const entry = CARDS[message.kind] as CardEntry<Message["kind"]> | undefined;
  if (entry === undefined) {
    return { standalone: true, node: <UnknownCard /> };
  }
  // Safe by construction: every entry in CARDS is checked against its own
  // variant where it is declared. Only the lookup loses that correlation.
  const Card = entry.Card as ComponentType<CardContext & { message: Message }>;
  return {
    standalone: entry.standalone === true,
    // Per card, not per transcript: a message that throws costs its own line
    // and nothing else. The pane keeps a boundary too, but that one catches
    // the list itself — reaching it would blank every message in the
    // conversation to report one bad row.
    node: (
      <ErrorBoundary fallback={<UnknownCard />}>
        <Card message={message} {...context} />
      </ErrorBoundary>
    ),
  };
}
