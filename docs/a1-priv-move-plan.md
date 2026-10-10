# Moving programs to A1-Priv

**A1-Priv** is the private GitHub repo `anthonyn99/A1-Priv`, cloned to
`C:\Users\antho\Desktop\A1-Priv` and served by Cloudflare Pages at
**https://a1-priv.pages.dev/**. Its first programs, moved on 2026-10-10, are
TradeHub (`tradehub.html`), Insight (`insight.html`), Vault (`vault.html`) and
the whole `Vault/` folder, which includes the Vault Launcher extension.

A1 stays public on GitHub Pages. The moved pages still use A1's shared files
(LifeHub, Notebook, tabsync, dragsort, hoverfx, resizegrip, sweep). They load
them by absolute URL from `https://anthonyn99.github.io/A1/`, so a change in
A1 reaches them with no redeploy.

## §0 Status

All three phases were built on 2026-10-10. To move another program later,
follow "Moving another program" at the bottom.

## Phases

### Phase 1 — Stand up A1-Priv (old pages untouched)
- Create the private repo and clone it to the Desktop.
- Copy the three pages and `Vault/` into it.
- Rewrite each shared-file `src` to its absolute A1 URL.
- Deploy: `tools/deploy.mjs` builds an allowlisted `.deploy/` folder (only the
  pages and the files they load, so no tests, docs or extension secrets). It
  then runs `wrangler pages deploy` on account 1, using the wrangler OAuth
  login on this PC.
- Auto-sync matches A1:
  - Claude Code hooks: pull on session start and prompt, commit + push +
    deploy on Stop.
  - Logon watcher `tools/autosync.ps1`: commits and pushes 3 s after each edit,
    pulls every 3 min, and deploys whenever HEAD differs from the last deploy.
  - Pre-commit integrity check and LF pinning.
- Done when all three pages serve from a1-priv.pages.dev.

### Phase 2 — Make the new origin work
- Every worker that pins `Access-Control-Allow-Origin` to GitHub Pages also
  accepts `https://a1-priv.pages.dev`: taskhub-reminders, insight-api,
  trade-dashboard, and any others the pages call.
- Insight's Plaid OAuth redirect moves to the new URL.
- App Check: the reCAPTCHA v3 key must list `a1-priv.pages.dev`. Only the
  owner can add it in Google's console; this is the one manual step.
- Verified headless against the live site: sign-in, a Firestore read, and the
  worker calls.

### Phase 3 — Cut over
- **LifeHub:** stored tiles that point at the old URLs are rewritten once to the
  new ones, the same way the legacy Shield link was migrated. The defaults
  change too.
- **Tony's TaskHub:** the `LEGACY_PROGRAMS` urls change, and the old urls go
  into `prevUrls` so stored buttons migrate.
- Every other A1 link (Keychain deep link, MAGI hand-offs, the trading
  launcher, the app-icon map) moves to the new URLs.
- The old `A1/tradehub.html`, `insight.html` and `vault.html` become tiny
  redirect stubs that keep the query and hash, so bookmarks and installed PWAs
  still land.
- `A1/Vault/` leaves A1. A git-ignored directory junction at `A1\Vault` points
  to `A1-Priv\Vault`, so the unpacked extension Brave loads from that path
  keeps working with no reinstall.
- A1 tests, README, CLAUDE.md and docs are updated to match.

## Things that are per-origin (expected, one time)
- **Biometrics** are WebAuthn passkeys bound to the hostname. Re-enable Bio once
  in each moved program. Passwords are unchanged because they live in
  Firestore.
- **Local caches** (localStorage, Firebase's IndexedDB) start empty and refill
  from Firestore on first open.
- **TradeHub's local journal snapshots** (IndexedDB `tradehub-journal-backups`)
  stay on the old origin. The Firestore snapshot copy is unaffected.
- **Tab de-duplication after a browser restart** (tabsync) works only within one
  origin. Index or LifeHub opening a moved program still reuses its named tab
  while the browser runs.

## Moving another program later
1. Copy the page, plus any folder only it uses, into A1-Priv. Point its
   shared-file `src`s at `https://anthonyn99.github.io/A1/…`.
2. Make sure `tools/deploy.mjs` picks it up. Root `*.html` files are
   automatic.
3. Add `https://a1-priv.pages.dev` to every worker it calls that pins an origin.
4. Change its links: LifeHub's `MOVED` map, Index's `LEGACY_PROGRAMS`
   (`prevUrls`), and anything else that greps for `<page>.html`.
5. Replace the A1 copy with a redirect stub.
