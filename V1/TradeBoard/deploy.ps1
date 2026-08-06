# ─────────────────────────────────────────────────────────────────────────────
#  DEPRECATED — TradeBoard now deploys via GitHub → Cloudflare Pages.
#
#  You no longer deploy manually. Pushing to GitHub `main` auto-deploys:
#    • the website  → Cloudflare Pages (Git integration)
#    • the Worker   → GitHub Actions (.github/workflows/deploy-worker.yml)
#  The Claude Code Stop hook + sync.ps1 push for you.
#
#  This script (old Firebase Hosting deploy) is kept only as a manual fallback
#  in case you ever need to publish to the legacy Firebase host. It does NOT
#  touch Cloudflare. Prefer `git push` (or letting sync.ps1 run).
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "deploy.ps1 is deprecated. Deployment is now GitHub -> Cloudflare Pages." -ForegroundColor Yellow
Write-Host "Just commit & push (sync.ps1 does this automatically). See README." -ForegroundColor Yellow
$ans = Read-Host "Still deploy to the LEGACY Firebase host? (y/N)"
if ($ans -eq "y") {
  node "$PSScriptRoot/scripts/build.mjs"
  firebase deploy --only hosting,firestore:rules
}
