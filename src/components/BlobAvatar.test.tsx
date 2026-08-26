import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BlobAvatar } from "@/components/BlobAvatar";
import type { Agent } from "@/data/agents";

describe("BlobAvatar", () => {
  it("draws a Blob whose tone and shape this build has never heard of", () => {
    // The roster is JSON on disk the user is told they may look at, and a
    // newer build can write a tone this one does not know. Falling back to the
    // default look is right; taking the window down over decoration is not.
    const odd = { tone: "sand", shape: "obelisk" } as unknown as Agent;
    expect(() => render(<BlobAvatar tone={odd.tone} shape={odd.shape} />)).not.toThrow();
  });

  it("still draws the tone it was asked for", () => {
    const { container } = render(<BlobAvatar tone="purple" shape="sphere" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
