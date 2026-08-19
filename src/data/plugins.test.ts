import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadPlugins, PLUGIN_CATEGORIES, type PluginDef } from "@/data/plugins";

/**
 * The catalog's invariants, held here because breaking them produces a tile
 * that looks perfectly fine and does nothing when clicked.
 */
const logosDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "logos");

describe("plugin catalog", () => {
  // The full catalog is a lazy chunk in the app; in tests it is just an await.
  let plugins: PluginDef[];
  beforeAll(async () => {
    plugins = await loadPlugins();
  });

  it("uses ids the Composio CLI will accept as toolkit slugs", () => {
    // The same charset `is_safe_slug` enforces in src-tauri/src/composio.rs
    // before the id reaches argv. A hyphenated id (`google-calendar`) is
    // refused there, which is how five tiles used to fail on click.
    const wrong = plugins.filter((plugin) => !/^[a-z0-9_]{1,64}$/.test(plugin.id));
    expect(wrong.map((plugin) => plugin.id)).toEqual([]);
  });

  it("ships a logo for every app", () => {
    // A missing file is an empty white square in the marketplace; the fetch
    // script writes one per id, so this catches a catalog edit made without
    // re-running it.
    const missing = plugins.filter((plugin) => !existsSync(join(logosDir, `${plugin.id}.svg`)));
    expect(missing.map((plugin) => plugin.id)).toEqual([]);
  });

  it("describes what each app does, not that it connects", () => {
    // Rows truncate around 45 characters, so a description that opens with
    // "Connect to Jira — …" spends the whole visible line restating the button
    // beside it. The useful verb has to come first.
    const boilerplate = plugins.filter((plugin) =>
      /^connect(s|ing)? to /i.test(plugin.description),
    );
    expect(boilerplate.map((plugin) => plugin.id)).toEqual([]);
    // Nor should it just repeat the name the row already shows.
    const restatesName = plugins.filter((plugin) =>
      plugin.description.toLowerCase().startsWith(plugin.name.toLowerCase()),
    );
    expect(restatesName.map((plugin) => plugin.id)).toEqual([]);
  });

  it("lists each app once, in a category that is rendered", () => {
    const ids = plugins.map((plugin) => plugin.id);
    expect(ids).toHaveLength(new Set(ids).size);
    const orphaned = plugins.filter((plugin) => !PLUGIN_CATEGORIES.includes(plugin.category));
    expect(orphaned.map((plugin) => plugin.id)).toEqual([]);
  });
});
