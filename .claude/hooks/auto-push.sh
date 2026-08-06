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

# ── Guard: refuse to stage a nested git repository ─────────────────────────
# A directory containing its own .git is staged by `git add -A` as a GITLINK
# (mode 160000) — a bare commit pointer, not files. With no .gitmodules to
# resolve it, actions/checkout then hard-fails every CI run with:
#   fatal: No url found for submodule path '<dir>' in .gitmodules
#
# That is exactly how the V1 folder broke Pages build #2278 (commit 01d4f12).
# Catching it here turns a red pipeline into an actionable message.
nested=$(find . -mindepth 2 -maxdepth 3 -name .git -not -path './.git/*' 2>/dev/null | sed 's|/\.git$||; s|^\./||')
if [ -n "$nested" ]; then
  first=$(printf '%s' "$nested" | head -1)
  printf '{"systemMessage":"Auto-push STOPPED: nested git repo(s) found — %s. Staging would add a broken gitlink and fail CI. Either remove the inner .git to absorb the files, or add the path to .gitignore."}\n' \
    "$(printf '%s' "$nested" | tr '\n' ' ')"
  exit 0
fi

git add -A 2>/dev/null

# Belt-and-braces: if a gitlink reached the index anyway (e.g. a repo nested
# deeper than the scan above), unstage it rather than pushing a broken tree.
gitlinks=$(git diff --cached --numstat --diff-filter=AM 2>/dev/null | cut -f3 | while read -r f; do
  [ -n "$f" ] && [ "$(git ls-files -s -- "$f" 2>/dev/null | cut -d' ' -f1)" = "160000" ] && printf '%s\n' "$f"
done)
if [ -n "$gitlinks" ]; then
  printf '%s\n' "$gitlinks" | while read -r f; do git rm --cached -q -- "$f" 2>/dev/null; done
  printf '{"systemMessage":"Auto-push: unstaged gitlink(s) %s — a nested repo would have broken CI. Files were NOT committed; resolve the nested repo first."}\n' \
    "$(printf '%s' "$gitlinks" | tr '\n' ' ')"
fi

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
