# Bundled skills

Seeded into `~/.blobbies/skills/` on first launch, then never overwritten.

**A skill may only ask for tools a Blob actually has** (`src/lib/blob-tools.ts`).
Shipping Composio's own `composio-cli` skill here caused real damage: it
describes shell commands, a Blob had no shell, and Blobs answered *"I can walk
you through the composio commands"* — offering a capability they could not have.

`connected-apps` replaces it, written against the three meta-tools
(`app_find_tool`, `app_tool_schema`, `app_run_tool`) that do exist. Check any
new skill the same way before adding it.
