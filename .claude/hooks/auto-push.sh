#!/usr/bin/env bash
# Auto-commit + push after Claude finishes a turn.
# No-op (clean exit, no empty commit) when the working tree has no changes.
# Wired up as a Stop hook in .claude/settings.json.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

# Nothing changed (tracked or untracked) -> do nothing, silently.
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  exit 0
fi

git add -A 2>/dev/null

# If staging produced nothing to commit (e.g. only ignored files), bail cleanly.
if git diff --cached --quiet 2>/dev/null; then
  exit 0
fi

if ! git commit -m "auto: claude code" >/dev/null 2>&1; then
  # Commit failed for some reason; don't block, just report.
  echo '{"systemMessage":"Auto-push: git commit failed — commit manually."}'
  exit 0
fi

if git push origin HEAD >/dev/null 2>&1; then
  echo '{"systemMessage":"Auto-committed and pushed to GitHub."}'
  exit 0
fi

# Push rejected -- most likely a collaborator pushed while this turn was running.
# Rebase our commit on top of theirs and try once more.
if git pull --rebase --quiet >/dev/null 2>&1 && git push origin HEAD >/dev/null 2>&1; then
  echo '{"systemMessage":"Auto-committed, rebased onto new upstream commits, and pushed to GitHub."}'
  exit 0
fi

git rebase --abort >/dev/null 2>&1
echo '{"systemMessage":"Auto-committed locally, but push failed (conflict with upstream, or network/auth) — run: git pull --rebase && git push"}'
exit 0
