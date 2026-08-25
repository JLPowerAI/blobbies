import { describe, expect, it, vi } from "vitest";
import {
  type ConversationEvent,
  hasConversationListeners,
  publishConversation,
  subscribeConversation,
} from "@/lib/conversation-bus";

const segment: ConversationEvent = { type: "segment", blobId: "a", text: "hi" };

describe("conversation bus", () => {
  it("delivers only to the conversation that was asked for", () => {
    const mine = vi.fn();
    const theirs = vi.fn();
    const offMine = subscribeConversation("a", mine);
    const offTheirs = subscribeConversation("group:g1", theirs);
    publishConversation("a", segment);
    expect(mine).toHaveBeenCalledWith(segment);
    expect(theirs).not.toHaveBeenCalled();
    offMine();
    offTheirs();
  });

  it("stops delivering after unsubscribe, and forgets the conversation", () => {
    const listener = vi.fn();
    const off = subscribeConversation("a", listener);
    expect(hasConversationListeners("a")).toBe(true);
    off();
    expect(hasConversationListeners("a")).toBe(false);
    publishConversation("a", segment);
    expect(listener).not.toHaveBeenCalled();
  });

  it("publishing with nobody listening is a no-op", () => {
    expect(() => publishConversation("nobody", segment)).not.toThrow();
  });

  it("keeps going when one listener throws", () => {
    const after = vi.fn();
    const offBad = subscribeConversation("a", () => {
      throw new Error("broken client");
    });
    const offGood = subscribeConversation("a", after);
    expect(() => publishConversation("a", segment)).not.toThrow();
    expect(after).toHaveBeenCalledWith(segment);
    offBad();
    offGood();
  });

  it("survives a listener unsubscribing during delivery", () => {
    const second = vi.fn();
    const offSecond = subscribeConversation("a", second);
    const offFirst = subscribeConversation("a", () => {
      offSecond();
    });
    publishConversation("a", segment);
    expect(second).toHaveBeenCalledTimes(1);
    offFirst();
  });
});
