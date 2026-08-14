import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The HTTP capability scope is data, not code, so nothing else type-checks it.
 *
 * A single unparseable entry makes Tauri reject the whole scope at runtime and
 * every plugin request fails — which is exactly what happened: six bracketed
 * IPv6 patterns like "https://[::1]/**" are not valid URLPatterns, so web
 * search silently returned nothing in the packaged app while working fine in
 * the browser. These assertions run the same matcher Tauri uses.
 */

interface Capability {
  permissions: (
    | string
    | { identifier: string; allow?: { url: string }[]; deny?: { url: string }[] }
  )[];
}

const capability = JSON.parse(
  readFileSync(`${process.cwd()}/src-tauri/capabilities/default.json`, "utf8"),
) as Capability;

const httpScope = capability.permissions.find(
  (entry): entry is { identifier: string; allow?: { url: string }[]; deny?: { url: string }[] } =>
    typeof entry === "object" && entry.identifier === "http:default",
);

/** Allowed only when some allow pattern matches and no deny pattern does. */
function reachable(url: string): boolean {
  const allowed = (httpScope?.allow ?? []).some((entry) => new URLPattern(entry.url).test(url));
  const denied = (httpScope?.deny ?? []).some((entry) => new URLPattern(entry.url).test(url));
  return allowed && !denied;
}

describe("http capability scope", () => {
  it("every pattern parses, or Tauri discards the whole scope", () => {
    const invalid: string[] = [];
    for (const entry of [...(httpScope?.allow ?? []), ...(httpScope?.deny ?? [])]) {
      try {
        new URLPattern(entry.url);
      } catch {
        invalid.push(entry.url);
      }
    }
    expect(invalid).toEqual([]);
  });

  it("allows the hosts the web tools actually call", () => {
    expect(reachable("https://www.bing.com/search?q=ollama&setlang=en-US")).toBe(true);
    expect(reachable("https://lite.duckduckgo.com/lite/")).toBe(true);
    expect(reachable("https://example.com/page")).toBe(true);
  });

  it("blocks this machine and the local network, including on non-default ports", () => {
    for (const url of [
      // Blobbies' own Ollama endpoint: reachable, but never fetchable.
      "https://127.0.0.1:11434/api/tags",
      "https://localhost:3000/admin",
      "https://[::1]/x",
      "https://192.168.1.1/",
      "https://10.0.0.5/",
      "https://172.20.0.1/",
      // Cloud metadata, the classic SSRF target.
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/",
      "https://printer.local/",
    ]) {
      expect(reachable(url), url).toBe(false);
    }
  });
});
