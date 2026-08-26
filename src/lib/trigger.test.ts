import { describe, expect, it } from "vitest";
import {
  describeTrigger,
  MAX_ARRIVALS_PER_FIRE,
  MAX_FOLDER_LENGTH,
  MAX_TRACKED_FILES,
  newlyArrived,
  normalizeFolder,
  parseTrigger,
} from "@/lib/trigger";

const files = (...names: string[]) => names.map((name) => ({ name, isDir: false }));

describe("newlyArrived", () => {
  it("arms on the first poll without firing about files already there", () => {
    // The behaviour that decides whether this feature is usable: switching a
    // routine on beside a full folder must not fire about its history.
    const { seen, arrived } = newlyArrived(undefined, files("a.txt", "b.txt"));
    expect(arrived).toEqual([]);
    expect(seen).toEqual(["a.txt", "b.txt"]);
  });

  it("fires once for a new file and never again", () => {
    const first = newlyArrived(["a.txt"], files("a.txt", "b.txt"));
    expect(first.arrived).toEqual(["b.txt"]);
    const second = newlyArrived(first.seen, files("a.txt", "b.txt"));
    expect(second.arrived).toEqual([]);
    expect(second.seen).toEqual(["a.txt", "b.txt"]);
  });

  it("ignores directories: a folder appearing is not a delivery", () => {
    const { seen, arrived } = newlyArrived(
      ["a.txt"],
      [
        { name: "a.txt", isDir: false },
        { name: "archive", isDir: true },
      ],
    );
    expect(arrived).toEqual([]);
    expect(seen).toEqual(["a.txt"]);
  });

  it("prunes deletions, so a file delivered again is new again", () => {
    const removed = newlyArrived(["a.txt", "b.txt"], files("a.txt"));
    expect(removed.arrived).toEqual([]);
    expect(removed.seen).toEqual(["a.txt"]);
    expect(newlyArrived(removed.seen, files("a.txt", "b.txt")).arrived).toEqual(["b.txt"]);
  });

  it("caps one fire's arrivals and leaves the rest for the next tick", () => {
    const dropped = Array.from(
      { length: MAX_ARRIVALS_PER_FIRE + 3 },
      (_, index) => `f${index}.txt`,
    );
    const first = newlyArrived([], files(...dropped));
    expect(first.arrived).toHaveLength(MAX_ARRIVALS_PER_FIRE);
    // The overflow is deliberately not remembered: nothing is dropped, only
    // paced, so the next poll reports what this one could not.
    expect(first.seen).toEqual(first.arrived);
    const second = newlyArrived(first.seen, files(...dropped));
    expect(second.arrived).toHaveLength(3);
  });

  it("bounds what it remembers however big the folder gets", () => {
    const many = Array.from({ length: MAX_TRACKED_FILES + 50 }, (_, index) => `f${index}.txt`);
    expect(newlyArrived(undefined, files(...many)).seen).toHaveLength(MAX_TRACKED_FILES);
  });

  it("treats junk from the store as never having polled", () => {
    // A hand-edited routines file must not make a folder full of history fire.
    const junk = "not an array" as unknown as string[];
    expect(newlyArrived(junk, files("a.txt")).arrived).toEqual([]);
  });
});

describe("normalizeFolder", () => {
  it("cleans a typed path into a home-relative one", () => {
    expect(normalizeFolder("inbox")).toBe("inbox");
    expect(normalizeFolder("/inbox/")).toBe("inbox");
    expect(normalizeFolder("./notes/in")).toBe("notes/in");
    // Empty means the home folder itself, which is a legitimate choice.
    expect(normalizeFolder("")).toBe("");
  });

  it("refuses anything that could leave the home folder", () => {
    expect(normalizeFolder("../../etc")).toBeNull();
    expect(normalizeFolder("inbox/../../etc")).toBeNull();
    expect(normalizeFolder("in\\box")).toBeNull();
    expect(normalizeFolder("in\u0000box")).toBeNull();
    expect(normalizeFolder("x".repeat(MAX_FOLDER_LENGTH + 1))).toBeNull();
  });
});

describe("parseTrigger", () => {
  it("accepts a stored file trigger and normalises its folder", () => {
    expect(parseTrigger({ kind: "file", folder: "/inbox" })).toEqual({
      kind: "file",
      folder: "inbox",
    });
  });

  it("rejects anything else, so a bad row cannot fire a routine", () => {
    expect(parseTrigger(undefined)).toBeNull();
    expect(parseTrigger(null)).toBeNull();
    expect(parseTrigger("inbox")).toBeNull();
    expect(parseTrigger({ kind: "webhook", folder: "inbox" })).toBeNull();
    expect(parseTrigger({ kind: "file" })).toBeNull();
    expect(parseTrigger({ kind: "file", folder: "../secrets" })).toBeNull();
  });
});

describe("describeTrigger", () => {
  it("says where it is watching", () => {
    expect(describeTrigger({ kind: "file", folder: "inbox" })).toBe("When a file arrives in inbox");
    expect(describeTrigger({ kind: "file", folder: "" })).toBe(
      "When a file arrives in the home folder",
    );
  });
});
