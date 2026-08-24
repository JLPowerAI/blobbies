/**
 * What a Blob is doing *right now*, for the sidebar row (and anywhere else a
 * live turn is only visible as a status word).
 *
 * A leaf module on purpose: `Sidebar` renders these labels and must not pull
 * `lib/ai` — and with it gg-agent, the OpenAI SDK and zod — into the startup
 * chunk (see the bundle budget in CLAUDE.md). `lib/ai` emits the values; only
 * this file knows what they are called on screen.
 */

export type BlobActivity = "thinking" | "writing" | "searching" | "reading" | "looking" | "working";

/** Present tense with an ellipsis: it is still happening while it is on screen. */
const LABELS: Record<BlobActivity, string> = {
  thinking: "Thinking\u2026",
  writing: "Writing\u2026",
  searching: "Searching\u2026",
  reading: "Reading\u2026",
  looking: "Looking\u2026",
  working: "Working\u2026",
};

export function activityLabel(activity: BlobActivity): string {
  return LABELS[activity];
}

/**
 * The word for a tool call, by tool name. Only the tools whose work has an
 * everyday name are called out; everything else — file writes, routines,
 * roster edits, MCP and Composio calls — is "Working…", because a status word
 * the user has to decode is worse than a vague one they don't.
 */
const TOOL_ACTIVITY: Record<string, BlobActivity> = {
  web_search: "searching",
  app_find_tool: "searching",
  list_files: "reading",
  read_file: "reading",
  web_fetch: "reading",
  take_screenshot: "looking",
  run_subagent: "thinking",
};

export function activityForTool(toolName: string): BlobActivity {
  return TOOL_ACTIVITY[toolName] ?? "working";
}
