import { describe, expect, it } from "vitest";
import { memoryHome } from "@/lib/home";

/**
 * The browser-dev backend. The real (Rust) backend has its own tests in
 * src-tauri/src/home.rs; these pin the shared contract the tools rely on.
 */
describe("memoryHome", () => {
  it("writes, lists, reads and deletes", async () => {
    const home = memoryHome();
    await home.write("notes/today.md", "hello");
    await home.write("plan.md", "the plan");

    const root = await home.list();
    expect(root.map((entry) => `${entry.name}${entry.isDir ? "/" : ""}`)).toEqual([
      "notes/",
      "plan.md",
    ]);
    const notes = await home.list("notes");
    expect(notes.map((entry) => entry.name)).toEqual(["today.md"]);

    expect(await home.read("notes/today.md")).toBe("hello");
    await home.remove("plan.md");
    await expect(home.read("plan.md")).rejects.toThrow(/no such file/);
  });

  it("overwrites in place", async () => {
    const home = memoryHome();
    await home.write("a.txt", "one");
    await home.write("a.txt", "two");
    expect(await home.read("a.txt")).toBe("two");
    expect(await home.list()).toHaveLength(1);
  });

  it("removing a folder removes its files", async () => {
    const home = memoryHome();
    await home.write("dir/a.txt", "a");
    await home.write("dir/b.txt", "b");
    await home.remove("dir");
    expect(await home.list()).toEqual([]);
  });

  it("rejects escape attempts, matching the Rust backend's containment", async () => {
    const home = memoryHome();
    for (const path of ["../secrets", "a/../../b", ""]) {
      await expect(home.write(path, "x")).rejects.toThrow(/outside/);
    }
  });
});
