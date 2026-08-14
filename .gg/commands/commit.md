---
name: commit
description: Run checks, agent code review, commit with AI message, and push
---

1. Run quality checks: `pnpm lint:fix && pnpm rs:fmt` (auto-fix), then `pnpm check`
   (= lint + typecheck + test + rs:lint). Fix ALL errors before continuing.

2. Review changes: run git status and git diff --staged and git diff

3. Fast review gate (last check, not a deep audit - be fast): spawn ONE subagent with the
   full diff. Review ONLY the diff for real bugs, regressions, leftover debug code, and
   unintended changes. Score each 0-100 confidence (pre-existing issues and stylistic
   nitpicks = false positives, score low). Report ONLY issues >= 80 with file:line and a
   one-line fix. If none, reply "CLEAR".

4. If CLEAR: proceed straight to step 5 and push WITHOUT asking the user anything.
   If issues >= 80 were reported: STOP, show the issues, and ask exactly:
   "Want me to fix this first, or commit and push anyway?
   A) Fix it first, then commit & push
   B) Commit & push anyway"
   On A: fix, re-run step 1, then continue (no re-review). On B: continue as-is.

5. Stage relevant files with git add (specific files, not -A)

6. Commit message: start with a verb (Add/Update/Fix/Remove/Refactor), specific, one line

7. Commit AND push in one go - never pause for confirmation here:
   git commit -m "your generated message"
   git push
