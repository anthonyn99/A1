# Testing checklist

Run top to bottom after the first deploy. Each item is observable — no guessing.

Legend: ✅ = already verified during the build · ☐ = for you to check once deployed

---

## A. Repository & build

- ✅ `npm run build` emits `dist/index.html` (TradeBoard) + `dist/finance/index.html` (Finance)
- ✅ Finance's module script and helper script both parse (`node --check`)
- ✅ All 103 `$('id')` lookups in Finance resolve to elements that exist
- ✅ No hardcoded credentials in the Worker
- ✅ No reference-app infrastructure in `Finance/finance.html`
- ✅ `TradeBoard/conf/token.txt` ignored and absent from git history
- ☐ GitHub Actions run is green after push (**Actions** tab)

---

## B. TradeBoard must be unchanged (regression)

The whole restructure is only safe if TradeBoard still behaves exactly as before.

- ✅ Files moved with `git mv` — history preserved (51 renames)
- ✅ Webull sync runs from the new path (`V1\TradeBoard\`), 0 crashes, full sync cycle completed
- ✅ Scheduled task repointed to the new path and verified `Running`
- ☐ TradeBoard loads at the site **root** URL (not `/tradeboard/`)
- ☐ App-lock password still accepted
- ☐ Existing trades/journal data still visible (same pinned Firestore doc)
- ☐ Webull sync still pushes — check `TradeBoard/wb_boot.log` for a recent `[cloud] Pushed to tradeboard/…`
- ☐ Desktop (Tauri) build still works: `npm run build:desktop`

---

## C. Finance — first run

- ☐ `/finance/` loads; lock screen appears
- ☐ Prompted to **create** a password (first time only)
- ☐ Password < 4 chars rejected; mismatch rejected
- ☐ After creating, app unlocks and the header shows a sync indicator
- ☐ Reload → stays unlocked (device is trusted)
- ☐ **Lock now** → locked again; password required
- ☐ Wrong password → shake animation + "Wrong password."

## D. Finance — password recovery

- ☐ **Email me the hint** → arrives at your email (only if a hint was set)
- ☐ **Forgot password?** → 6-char code arrives via Formspree
- ☐ Wrong code shows remaining attempts; 5 failures locks the code
- ☐ Correct code + new password → unlocked
- ☐ Code expires after 15 minutes

## E. Finance — biometrics (device-dependent)

- ☐ After a password unlock, offered Face ID / Touch ID / Windows Hello
- ☐ Enabling then locking shows **Unlock with …**
- ☐ Biometric unlock works
- ☐ **Remove …** requires verification first, then disappears from the lock screen

---

## F. Finance — data entry (works without Plaid)

- ☐ **+ Add entry** → expense saves; appears in the feed
- ☐ Income entry shows **green** and with a `+` sign
- ☐ Edit an entry → changes persist after reload
- ☐ Delete → confirmation modal → row disappears
- ☐ Month tiles (In / Out / Net) update immediately
- ☐ **Monthly history** expands and totals match the tiles

## G. Finance — CSV import

- ☐ Drop a real bank CSV → mapping panel shows detected columns
- ☐ Preview rows show money-out as `−`; flipping **Amounts** inverts them
- ☐ Re-importing the same file → all rows reported as "already imported"
- ☐ A near-duplicate is flagged for review; **Import** stays disabled until decided
- ☐ **Keep all** / **Mark all as duplicates** resolve every pending decision
- ☐ Headerless CSV (e.g. Wells Fargo) still detects date/amount/description

## H. Finance — derived features

- ☐ **Insights**: category bars and the 6-month trend render
- ☐ Savings rate is sane (not `NaN`/`Infinity` when income is 0)
- ☐ **Budgets**: add one → meter fills; ≥80% turns amber; >100% turns red and shows "over budget"
- ☐ **Recurring**: a merchant charged monthly is auto-detected with the right cadence
- ☐ Recurring rows drag to reorder; order survives reload
- ☐ **Cash**: add / deduct / set exact; deducting more than you hold is refused

## I. Finance — display mode

- ☐ Eye icon → month totals show plausible figures tagged **mock**
- ☐ Account balances and net worth blur
- ☐ Individual transaction amounts and cash stay readable (by design)
- ☐ Setting survives reload

---

## J. Plaid (after PLAID_SETUP)

- ☐ `GET /health` returns `"configured":{"plaid":true,"firebase":true,"kv":true}`
- ☐ **Connect** → Plaid Link opens
- ☐ Sandbox `user_good` / `pass_good` links successfully
- ☐ Institution appears under **Connected**
- ☐ Transactions and balances arrive within ~30s
- ☐ **Refresh** button spins, then reports synced
- ☐ Plaid rows are **read-only** (lock icon, no edit/delete)
- ☐ Card payments / transfers are chipped and excluded from In/Out totals
- ☐ Locking, then calling `/sync` → `lockRequired` (no data without a session)

---

## K. Responsive (Phase 10)

Check at 360px, 720px, 1024px, and desktop — plus a real phone if possible.

- ☐ **360px**: stat tiles drop to 2 columns; nothing overflows horizontally
- ☐ **720px**: monthly history stacks (month on its own line, three labelled figures beneath)
- ☐ Tab strip scrolls horizontally without breaking layout
- ☐ Modals fit the screen and scroll internally
- ☐ Inputs are 16px on touch (no iOS zoom-on-focus)
- ☐ Buttons are ≥42px tall on touch devices
- ☐ Safe-area insets respected on a notched phone (no content under the notch/home bar)
- ☐ `prefers-reduced-motion` disables animation

---

## L. Cross-app isolation

- ☐ Finance's password is independent of TradeBoard's (changing one doesn't affect the other)
- ☐ Finance cannot see TradeBoard data and vice versa (separate Firestore paths)
- ☐ Both apps work in the same browser simultaneously

---

## Quick commands

```powershell
cd C:\Users\vedap\Desktop\V1

npm run build                              # both apps
node --check workers/finance-api/src/index.js
curl https://finance-api.vedapatel05.workers.dev/health
cd workers/finance-api; npx wrangler tail  # live Worker logs
```
