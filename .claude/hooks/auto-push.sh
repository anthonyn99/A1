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
else
  echo '{"systemMessage":"Auto-committed locally, but git push failed (check network/auth) — run: git push"}'
fi
exit 0
