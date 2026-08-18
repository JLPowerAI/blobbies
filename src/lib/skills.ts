import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";

/**
 * Skills: folders of Markdown that tell a Blob how to do something.
 *
 * Only `name` and `description` cross this boundary — the Rust side parses
 * them out of each `SKILL.md`'s frontmatter, sanitised and capped. The body
 * and any `references/` stay on disk until whatever follows the skill reads
 * them, so a skill costs one prompt line until it is actually needed.
 */
export interface Skill {
  name: string;
  description: string;
}

/**
 * Installed skills, already sorted by name.
 *
 * The order comes from Rust and matters: this list lands in the system
 * prompt's stable prefix, which Ollama caches across turns. Re-sorting or
 * filtering it here per-turn would move the cache boundary and cost every
 * later turn — so callers pass it through untouched.
 *
 * A plain browser has no filesystem, so "no skills" is the only honest answer
 * there — same shape as `composioCliVersion` and `isOllamaInstalled`.
 */
export async function listSkills(): Promise<Skill[]> {
  if (!isTauri()) {
    return [];
  }
  try {
    return await invoke<Skill[]>("skills_list");
  } catch {
    return [];
  }
}

/** Render for the prompt's Skills section: one `name: what it does` line. */
export function skillLine(skill: Skill): string {
  return `${skill.name}: ${skill.description}`;
}
