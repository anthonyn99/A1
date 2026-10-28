# Moving programs to A1-Priv

**A1-Priv** is the private GitHub repo `anthonyn99/A1-Priv`, cloned to
`C:\Users\antho\Desktop\A1-Priv` and served from Cloudflare at
**https://a1-priv.av1.workers.dev/**. That host is a static-assets Worker on
account 1, deployed from this PC. Everything below moved in on 2026-10-10:

| Program | New address | Old A1 file |
| --- | --- | --- |
| TradeHub | https://a1-priv.av1.workers.dev/tradehub.html | `tradehub.html`, a redirect stub until 2026-10-22, now removed |
| Insight | https://a1-priv.av1.workers.dev/insight.html | `insight.html`, a redirect stub until 2026-10-22, now removed |
| Vault | https://a1-priv.av1.workers.dev/vault.html | `vault.html`, a redirect stub until 2026-10-22, now removed |
| Vault Launcher extension + Vault modules | `A1-Priv/Vault/` | `A1\Vault`, now a git-ignored junction to it |
| RiftIQ (second move) | https://a1-priv.av1.workers.dev/riftiq.html | `riftiq.html`, a redirect stub until 2026-10-22, now removed |
| Solace (second move) | https://a1-priv.av1.workers.dev/solace.html | `solace.html`, a redirect stub until 2026-10-22, now removed |
| OneInbox (third move, 2026-10-28) | https://a1-priv.av1.workers.dev/oneinbox.html | `oneinbox.html`, removed outright (no stub) |

A1 stays public on GitHub Pages. The moved pages still use A1's shared files
(LifeHub, Notebook, tabsync, dragsort, hoverfx, resizegrip, sweep). They load
them by absolute URL from `https://anthonyn99.github.io/A1/`, so a change in
A1 reaches them with no redeploy. A1-Priv's own README and CLAUDE.md cover
day-to-day work there.

## §0 Status

**Done 2026-10-10, all three phases, verified live.** To move another program,
follow "Moving another program later" at the bottom.

**Second move, same day: RiftIQ and Solace**, done with that recipe.
- warroom-api (it refuses unlisted origins) now allows this host. The other
  workers they call (proview-api, personal-ai) answer `*`, and
  taskhub-reminders already allowed it.
- RiftIQ had TradeHub's sign-in race (listeners attached before anonymous
  auth). It is fixed the same way, behind `_fbAuthed`.
- LifeHub's `MOVED` and Index's `MOVED_PROGRAMS` also mapped the old
  `warroom.html` (both removed 2026-10-22). Both stores were verified on the server.
- RiftIQ's live game card reads the local WarRoom Live Link proxy
  (127.0.0.1:2998), which accepts any origin. Brave asks once per site for
  local-network access, so allow it the first time on the new host.

**Third move, 2026-10-28: OneInbox**, done with that recipe, no stub.
- **oneinbox-api** pinned the GitHub origin twice: CORS, and the Gmail-connect
  popup's `postMessage` target. Both now take `ALLOWED_ORIGINS` (GitHub and
  this host); the popup posts to each, and the page only accepts the worker's
  origin. `APP_URL` in its wrangler.toml names the new page. The Google OAuth
  client needed nothing: the consent flow returns to the worker's own
  `/oauth/callback`. Guardian's lock (taskhub-reminders) already allowed the
  host. The worker deploys from GitHub Actions when `workers/**` reaches main.
- **Links:** LifeHub's default is the new address, and `MOVED_PAGES` in
  `LifeHub/lifehub.js` patches a stored tile still on the old one, once per
  sync, through the normal patch path (this rewrites the stored link; it is
  not a redirect). TaskHub's card deep link (`OI_openEmail`) opens the new
  address. OneInbox has no built-in TaskHub opener, so there was nothing else.
- **Already safe:** OneInbox's listeners wait for anonymous sign-in
  (`authReady`), so a fresh browser on the new host does not hit TradeHub's
  old race.
- **Per-origin, once:** the OneInbox lock's biometric (turn Bio on again), the
  account order and the signature-box height start fresh; the reinstalled PWA
  must come from the new address. Their old github.io copies are listed in
  `cleanup-rules.json`'s `moved-programs-old-origin`.
- **Tests:** OneInbox is in `tests/moved.js` / `cdp.js`'s `MOVED`; A1-Priv's
  `tests/wiring.test.js` §8 checks the worker, the deep link and that A1 has
  no copy; `tests/lifehub-wiring.test.js` checks the tile rewrite.

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
> **2026-10-22: every redirect is gone.** Tony asked for no redirects at all.
> The server copies of `dashboards/lifehub`, `lifehub_veda`, `navorder`,
> `main` and `vedasdash` were read and hold no old address, so LifeHub's
> `MOVED`, Index's `MOVED_PROGRAMS`, the `?goto=keychain` forward and every
> stub (A1's five and A1-Priv's `solace.html`) were removed. What follows is
> the record of how the cut-over was done.

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
- **Redirect stubs** kept the query, hash and window.name, so bookmarks, installed
  PWAs and old extension builds still landed. Tony had them removed on
  2026-10-22, after reinstalling the home-screen icons from the new address; an
  old address is now a GitHub 404.
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
  new host, after the provider consoles list it:
  - **Google Cloud Console** → Credentials → OAuth client
    `982539604706-vmc7tbc0…` → add the JavaScript origin
    `https://a1-priv.av1.workers.dev`, and the redirect URI
    `https://a1-priv.av1.workers.dev/Vault/oauth-silent.html`.
  - **Dropbox App Console** → app `cws7hl139d725oc` → OAuth 2 → add the
    redirect URI `https://a1-priv.av1.workers.dev/vault.html`.
- **Plaid OAuth banks** (Chase, Capital One, Wells Fargo): add
  `https://a1-priv.av1.workers.dev/insight.html` under Plaid Dashboard →
  Developers → API → Allowed redirect URIs. Until then those banks link
  without the OAuth redirect (insight-api's existing fallback), and every
  other bank is unaffected.
- **TradeHub's local journal snapshots** (IndexedDB) stay on the old origin. The
  Firestore snapshot copy is unaffected.
- **Tab de-duplication after a browser restart** (tabsync) only works within one
  origin. While the browser runs, named tabs still pair across origins.
- **Installed PWAs** of the old URLs no longer open (the stubs are gone).
  Reinstall from the new URL.

## Moving another program later
1. Copy the page, plus any folder only it uses, into A1-Priv. Point its
   shared-file `src`s at `https://anthonyn99.github.io/A1/…` and check with
   `node tools/deploy.mjs --build`.
2. Fix its inline PWA manifest `id`/`start_url` and any self-URLs.
3. Add `https://a1-priv.av1.workers.dev` to every worker it calls that pins an
   origin (grep the worker for `ALLOWED`).
4. Point every link at the new address directly. No redirects (Tony,
   2026-10-22). Change LifeHub's `DEFAULT_APPS` and TaskHub's built-in opener
   fallback, then edit the stored tiles themselves: in the LifeHub popup, or
   `LifeHub.update` from a page. Read `dashboards/lifehub`, `lifehub_veda` and
   `navorder` back from a headed off-screen browser (App Check refuses REST)
   to prove no old address is left. Add the page to `tests/moved.js` /
   `cdp.js`'s `MOVED` patterns, which only tell the tests where the code lives.
5. Delete the A1 copy. Don't leave a redirect stub.
6. Cleanup: give the page `<script src="https://anthonyn99.github.io/A1/sweep.js"
   data-program="<name>" defer></script>` (tests/cleanup-rules.test.js checks
   every A1-Priv page has it), and add its localStorage keys to the
   `moved-programs-old-origin` item in `cleanup-rules.json`: on github.io they
   are dead from the day of the move.
7. Run both suites: `npm test` in A1 and in A1-Priv.
