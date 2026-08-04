#!/usr/bin/env bash
# Pull collaborator commits from GitHub BEFORE Claude reads/edits files.
#
# Usage: git-sync.sh <throttle_seconds> <HookEventName>
#   throttle_seconds = 0  -> always fetch (SessionStart)
#   throttle_seconds > 0  -> skip if we already fetched that recently (UserPromptSubmit)
#
# Clean tree  -> pulls with --rebase and tells Claude which files changed.
# Dirty tree  -> does NOT touch the tree; warns Claude that it is behind.
# Offline/err -> silent no-op, never blocks the turn.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

THROTTLE="${1:-0}"
EVENT="${2:-SessionStart}"

GITDIR=$(git rev-parse --git-dir 2>/dev/null) || exit 0
STAMP="$GITDIR/claude-last-fetch"

if [ "$THROTTLE" -gt 0 ] && [ -f "$STAMP" ]; then
  now=$(date +%s)
  last=$(cat "$STAMP" 2>/dev/null || echo 0)
  [ $((now - last)) -lt "$THROTTLE" ] && exit 0
fi
date +%s >"$STAMP" 2>/dev/null

UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || exit 0
[ -n "$UPSTREAM" ] || exit 0
REMOTE="${UPSTREAM%%/*}"

# Offline / auth failure -> stay quiet rather than nagging every prompt.
git fetch --quiet "$REMOTE" >/dev/null 2>&1 || exit 0

BEHIND=$(git rev-list --count "HEAD..$UPSTREAM" 2>/dev/null || echo 0)
[ "$BEHIND" -eq 0 ] && exit 0

# Strip characters that would break the JSON we emit by hand.
clean() { tr -d '"\\\r' | tr '\n' ' '; }
AUTHORS=$(git log --format='%an' "HEAD..$UPSTREAM" 2>/dev/null | sort -u | clean)
FILES=$(git diff --name-only "HEAD..$UPSTREAM" 2>/dev/null | head -25 | clean)

if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  printf '{"systemMessage":"Behind origin by %s commit(s) (%s) — working tree dirty, not auto-pulling.","hookSpecificOutput":{"hookEventName":"%s","additionalContext":"GIT SYNC: this checkout is %s commit(s) BEHIND %s (authors: %s). The working tree has uncommitted changes so nothing was pulled automatically. Files changed on the remote: %s. Before reading or editing any of those files, resolve this first (commit or stash, then git pull --rebase)."}}\n' \
    "$BEHIND" "$AUTHORS" "$EVENT" "$BEHIND" "$UPSTREAM" "$AUTHORS" "$FILES"
  exit 0
fi

if git pull --rebase --quiet >/dev/null 2>&1; then
  printf '{"systemMessage":"Pulled %s new commit(s) from %s (%s).","hookSpecificOutput":{"hookEventName":"%s","additionalContext":"GIT SYNC: pulled %s new commit(s) from %s (authors: %s). Files updated: %s. Any copy of these files from earlier in this session is stale — re-read before editing."}}\n' \
    "$BEHIND" "$UPSTREAM" "$AUTHORS" "$EVENT" "$BEHIND" "$UPSTREAM" "$AUTHORS" "$FILES"
else
  git rebase --abort >/dev/null 2>&1
  printf '{"systemMessage":"git pull --rebase failed — %s commit(s) behind %s. Resolve manually.","hookSpecificOutput":{"hookEventName":"%s","additionalContext":"GIT SYNC: this checkout is %s commit(s) BEHIND %s (authors: %s) and the automatic rebase failed (likely a conflict). Files changed on the remote: %s. Tell the user and resolve before editing those files."}}\n' \
    "$BEHIND" "$UPSTREAM" "$EVENT" "$BEHIND" "$UPSTREAM" "$AUTHORS" "$FILES"
fi
exit 0
