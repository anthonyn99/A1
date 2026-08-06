# =============================================================================
#  TradeBoard -> GitHub auto-sync
#  Builds the Cloudflare Pages output, commits any local changes, and pushes to
#  GitHub. Pushing to `main` then auto-deploys: Cloudflare Pages (site) + GitHub
#  Actions (Worker). Safe to run anytime.
#  Used by the Claude Code Stop hook (.claude/settings.json). Manual run:
#     powershell -NoProfile -ExecutionPolicy Bypass -File sync.ps1
# =============================================================================
$ErrorActionPreference = "SilentlyContinue"
Set-Location $PSScriptRoot

# Nothing to do if not a git repo.
git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) { exit 0 }

# Refresh the Cloudflare Pages output (public/index.html + headers) so the
# deployed site always matches the canonical tradeboard.html. Best-effort.
if (Test-Path "$PSScriptRoot/scripts/build.mjs") {
  node "$PSScriptRoot/scripts/build.mjs" 2>&1 | Out-Host
}

# Any changes (staged, unstaged, or untracked)?
$dirty = git status --porcelain
if (-not $dirty) {
  Write-Host "sync: nothing to commit."
} else {
  git add -A
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
  git commit -q -m "Auto-sync $stamp"
  Write-Host "sync: committed changes ($stamp)."
}

# Push only if a remote named 'origin' exists.
$hasRemote = git remote
if ($hasRemote -match "origin") {
  git push -q origin HEAD 2>&1 | Out-Host
  if ($LASTEXITCODE -eq 0) { Write-Host "sync: pushed to origin." }
  else { Write-Host "sync: push failed (is the GitHub remote set + authorized?)." }
} else {
  Write-Host "sync: no 'origin' remote yet - commit saved locally only."
}
