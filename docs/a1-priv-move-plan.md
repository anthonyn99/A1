# Moving programs to A1-Priv

**A1-Priv** is the private GitHub repo `anthonyn99/A1-Priv`, cloned to
`C:\Users\antho\Desktop\A1-Priv` and served from Cloudflare at
**https://a1-priv.av1.workers.dev/**. That host is a static-assets Worker on
account 1, deployed from this PC. It moved in on 2026-10-10:

| Program | New address | Old A1 file |
| --- | --- | --- |
| TradeHub | https://a1-priv.av1.workers.dev/tradehub.html | `tradehub.html`, now a redirect stub |
| Insight | https://a1-priv.av1.workers.dev/insight.html | `insight.html`, now a redirect stub |
| Vault | https://a1-priv.av1.workers.dev/vault.html | `vault.html`, now a redirect stub |
| Vault Launcher extension + Vault modules | `A1-Priv/Vault/` | `A1\Vault`, now a git-ignored junction to it |

A1 stays public on GitHub Pages. The moved pages still use A1's shared files
(LifeHub, Notebook, tabsync, dragsort, hoverfx, resizegrip, sweep). They load
them by absolute URL from `https://anthonyn99.github.io/A1/`, so a change in
A1 reaches them with no redeploy. A1-Priv's own README and CLAUDE.md cover
day-to-day work there.

## §0 Status

**Done 2026-10-10, all three phases, verified live.** To move another program,
follow "Moving another program later" at the bottom.

## Why a Worker and not Cloudflare Pages

Pages always 308-redirects `/tradehub.html` to `/tradehub`. These pages, and
A1's LifeHub/tabsync, compare URLs by path: named-tab matching, app icons, and
the Plaid and Vault-cloud OAuth redirect URIs. With Pages, every LifeHub click
would have reloaded the open tab. A static-assets Worker with
`html_handling = "none"` serves every file at exactly the path GitHub Pages
used.

## What each phase did

### Phase 1: stand up A1-Priv (old pages untouched)
- Created the private repo, copied the pages and `Vault/`, and rewrote the
  shared-file `src`s to absolute A1 URLs.
- Publishing: `tools/deploy.mjs` builds an allowlisted `.deploy/` folder (the
  pages plus every file they reference) and runs `wrangler deploy` with this
  PC's wrangler OAuth login. Tests, docs and the extension's keyed files (like
  `vault-sync.js`) never reach the public host; the build refuses them.
- Auto-sync, same as A1:
  - Claude Code hooks: pull on session start and on each prompt; commit, push
    and deploy on Stop.
  - Logon watcher `tools/autosync.ps1` (Startup shortcut "A1-Priv-AutoSync"):
    a poll loop that commits and pushes within about 6 s, pulls every 3 min,
    and deploys after both.
  - Pre-commit: integrity check plus syntax gate.
- A1's `tools/notebook-stamp.js` also re-stamps `A1-Priv/tradehub.html`. The
  watcher there commits and deploys it.

### Phase 2: make the new origin work
- **App Check:** the owner added `a1-priv.av1.workers.dev` to reCAPTCHA key
  `6LeUyAstAAAA…` (the one manual step).
- **Workers** that pinned the GitHub origin now also allow the new one:
  taskhub-reminders, insight-api and trade-dashboard. The others answer `*`.
- **Plaid:** insight-api picks its redirect URI by request origin.
- **Extension:**
  - The manifest's hosts and content-script matches include the new host.
  - The relays (Launch Analysis, Open all) trust both origins.
  - "Never autofill inside Vault" covers both hosts.
  - The popup opens the new URL.
  - Biometric links are kept per hostname (a passkey belongs to the site that
    made it), and the unlock asserts the link's own `rpId`.
- **PWA manifests:** each page's inline manifest has its `id` and `start_url`
  on the new host.
- **Bug found and fixed:** TradeHub attached its Firestore listeners before
  anonymous sign-in finished. A browser without a saved sign-in got
  permission-denied, and Firestore never retries a listener, so live sync
  stayed dead that session. This happened on GitHub too; the move would have
  made every browser fresh. `init()` now waits for auth.

### Phase 3: cut over
- **LifeHub:** defaults moved to the new host, and the `MOVED` map rewrites
  stored tiles once, through the normal patch path. Verified on the server:
  `dashboards/lifehub` holds the new URLs.
- **Tony's TaskHub:** `LEGACY_PROGRAMS` (TradeHub, Vault) are on the new host
  with the old URLs in `prevUrls`. `MOVED_PROGRAMS` rewrites any of Tony's
  links on an old address, including the custom Insight link. Verified on the
  server: `dashboards/navorder` holds the new URLs.
- **Other A1 links:**
  - The `?goto=keychain` redirect.
  - The app-icon matcher, which accepts the new host.
  - The morning launcher's `TRADEHUB_URL`.
  - The TradeHub to MAGI hand-off needed no change: a cross-origin tab can
    still be re-targeted.
- **Redirect stubs** keep the query, hash and window.name. Bookmarks, installed
  PWAs and old extension builds still land.
- **Tests:** A1 suites that guard these programs read them from `../A1-Priv`
  via `tests/moved.js` and skip without it. The live CDP harness serves them
  from there too. The cleanup-rules "unused key" proof scans A1-Priv as well,
  or it could clear keys TradeHub still uses.

## Things that are per-origin (one time, expected)
- **Biometrics** are passkeys bound to the hostname. Turn Bio on again once in
  each moved program. Passwords are unchanged because they live in Firestore.
- **Local caches** (localStorage, Firebase's cache) start empty and refill from
  Firestore. The same goes for small per-device settings, like popup sizes and
  the last tab.
- **Vault cloud files:** each device reconnects Google Drive/Dropbox once on the
  new host, after the provider consoles list it (see the owner checklist in
  the session notes: Google OAuth origin and redirect, Dropbox redirect).
- **TradeHub's local journal snapshots** (IndexedDB) stay on the old origin. The
  Firestore snapshot copy is unaffected.
- **Tab de-duplication after a browser restart** (tabsync) only works within one
  origin. While the browser runs, named tabs still pair across origins.
- **Installed PWAs** of the old URLs still open, through the stub. Reinstall
  from the new URL for a clean app window.

## Moving another program later
1. Copy the page, plus any folder only it uses, into A1-Priv. Point its
   shared-file `src`s at `https://anthonyn99.github.io/A1/…` and check with
   `node tools/deploy.mjs --build`.
2. Fix its inline PWA manifest `id`/`start_url` and any self-URLs.
3. Add `https://a1-priv.av1.workers.dev` to every worker it calls that pins an
   origin (grep the worker for `ALLOWED`).
4. Add its old URL to LifeHub's `MOVED`, Index's `MOVED_PROGRAMS` (and
   `prevUrls` if it is a built-in button), and `tests/moved.js` / `cdp.js`'s
   `MOVED` patterns.
5. Replace the A1 copy with a redirect stub (copy one of the three).
6. Run both suites: `npm test` in A1 and in A1-Priv.
