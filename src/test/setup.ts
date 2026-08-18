import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
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

// This jsdom build ships no localStorage, which every preference reads
// through (`src/lib/preferences.ts`). A Map-backed stand-in, wiped between
// tests, makes those reads honest without leaking state across cases.
const preferences = new Map<string, string>();
if (globalThis.localStorage === undefined) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => preferences.get(key) ?? null,
      setItem: (key: string, value: string) => void preferences.set(key, value),
      removeItem: (key: string) => void preferences.delete(key),
    },
  });
}

beforeEach(() => {
  preferences.clear();
  // Every suite but the onboarding one asserts the app that the first-run
  // flow would otherwise cover on mount. Onboarding tests drop this flag.
  preferences.set("pref:onboarded", "true");
});

afterEach(() => {
  cleanup();
  // The store's in-memory fallback survives module reuse between tests;
  // wipe it so persisted state never leaks across test cases.
  clearFallbackBackend();
});
