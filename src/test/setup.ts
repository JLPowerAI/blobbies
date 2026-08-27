import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { clearFallbackBackend } from "@/lib/store";

// The DOM shims below are jsdom-only. A test file may opt into the node
// environment (`@vitest-environment node`) when a dependency needs a single
// consistent realm — Tinfoil's hpke transport does, since it checks
// `instanceof Uint8Array` and jsdom's TextEncoder returns a foreign-realm
// one. This setup still runs there, where `Element` does not exist.
const hasDom = typeof Element !== "undefined";

// jsdom implements scrollTop but not Element.scrollTo; map one to the other
// so scroll-follow logic runs (jsdom heights are 0, so it lands instantly).
if (hasDom && typeof Element.prototype.scrollTo !== "function") {
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
if (hasDom && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// jsdom ships no media stack, so the notification chime (`src/lib/sound.ts`)
// makes every notifying test print a "Not implemented" error through jsdom's
// virtual console — 72 of them across the suite, none of them a failure.
//
// A resolved promise is also the honest stand-in: `playChime` is already
// fire-and-forget and ignores rejection, so nothing branches on the result.
// This shims the missing browser API, exactly like the two scroll shims
// above; it does not suppress any error the app itself raises.
if (hasDom && typeof HTMLMediaElement !== "undefined") {
  HTMLMediaElement.prototype.play = function play() {
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause() {};
}

// Every preference reads through localStorage (`src/lib/preferences.ts`), and
// whether jsdom provides one varies by environment — the local build ships
// none, CI's does. Installing this Map-backed stand-in *unconditionally*
// makes both behave the same; a conditional shim silently seeded a Map
// nothing read, and the app saw an empty store.
const preferences = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => preferences.get(key) ?? null,
    setItem: (key: string, value: string) => void preferences.set(key, value),
    removeItem: (key: string) => void preferences.delete(key),
  },
});

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
