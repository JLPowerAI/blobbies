import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { clearFallbackBackend } from "@/lib/store";

// jsdom implements scrollTop but not Element.scrollTo; map one to the other
// so scroll-follow logic runs (jsdom heights are 0, so it lands instantly).
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = function scrollTo(
    this: Element,
    options?: ScrollToOptions | number,
  ) {
    if (typeof options === "object" && options !== null && typeof options.top === "number") {
      this.scrollTop = options.top;
    }
  } as Element["scrollTo"];
}

// Same gap: jsdom has no scrollIntoView, and keeping a highlighted row in
// view is a no-op in a zero-height layout anyway.
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

afterEach(() => {
  cleanup();
  // The store's in-memory fallback survives module reuse between tests;
  // wipe it so persisted state never leaks across test cases.
  clearFallbackBackend();
});
