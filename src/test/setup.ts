import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { clearFallbackBackend } from "@/lib/store";

afterEach(() => {
  cleanup();
  // The store's in-memory fallback survives module reuse between tests;
  // wipe it so persisted state never leaks across test cases.
  clearFallbackBackend();
});
