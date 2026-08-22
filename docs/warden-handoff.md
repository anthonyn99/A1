# Warden — build handoff

Context compiled 2026-08-21 for starting a fresh session. Self-contained; read
this first. (Supersedes `veda-vault-handoff.md`.)

---

## The goal

Build **Warden** — a complete duplicate of Tony's Vault program and its browser
extension, for Veda, in her visual identity, wired to her own accounts, ready to
live in **her own GitHub repository**.

Two deliverables:

| | Tony's (the model) | Veda's (to build) |
|---|---|---|
| PWA | `vault.html` + `Vault/*.js` | **`warden.html`** + `Warden/*.js` |
| Extension | `Vault/` ("Vault Launcher") | **`Warden/`** ("Warden Launcher") |

**Duplicate everything.** Same features, same behaviour, same desktop *and*
mobile polish. The only differences are the name, her palette, and which
accounts it points at.

Additionally: **Veda's Links moves out of `index.html` into Warden**, exactly as
Tony's Keychain/Links lives inside Vault rather than Index.

**Wire up automatically everything that can be.** Anything that genuinely
requires a human (creating accounts, pasting keys) gets collected into one clear,
concise instruction list at the END of the build — not scattered.

**NOT in scope:** changing Tony's Vault, his Launcher, or his data.

---

## Scale, and how to port (read before writing any code)

This is a **1.22 MB, 38-file** duplicate:

| File | Size |
|---|---|
| `vault.html` | 191 KB / 3,123 lines |
| `vault-ui.js` | 158 KB |
| `vault-cloud-ui.js` | 131 KB |
| `vault-id-ui.js` | 99 KB |
| `vault-cloud.js` | 76 KB |
| …33 more | ~570 KB |

**Do not hand-write this.** Almost all of it is a mechanical rename, and trying
to read and reproduce 1.2 MB will exhaust a session's context long before the
build is done. The strategy that works:

1. **Copy the files**, then rename with a script — a Node pass over
   `Vault/*` → `Warden/*` applying an ordered token map (`VaultCrypto`→
   `WardenCrypto`, `vault-`→`warden-`, `window.Vault`→`window.Warden`,
   localStorage `vault.`→`warden.`, and so on). Longest tokens first so
   `vault-pw-core` isn't half-renamed by the `vault-` rule.
2. **Verify the rename** rather than eyeballing it: `node --check` every JS file,
   assert zero remaining `/[Vv]ault/` matches outside comments that legitimately
   reference Tony's original, and confirm the file count and script tags match.
3. **Only then** hand-edit the genuinely new parts: the config block, the palette
   tokens, `warden.html`'s shell, the manifest, and `SETUP.md`.

Budget the session accordingly, and expect to phase it (see Build order).

## Naming / rename map

| Old | New |
|---|---|
| Vault (program) | **Warden** |
| `vault.html` | `warden.html` |
| `Vault/` (dir) | `Warden/` |
| `vault-*.js` | `warden-*.js` |
| "Launcher" (`V1/Launcher/`) | **"Warden Launcher"**, folded into `Warden/` |
| `window.Vault`, `VaultCrypto`, `VaultSession`, `VaultStore`, `VaultCloud`, `VaultDrag` | `Warden*` equivalents |
| localStorage `vault.*` keys | `warden.*` |

`V1/Launcher/` is **replaced**, not extended — its links-only popup becomes the
full Warden Launcher. Build it so the whole `Warden/` folder can be lifted into
Veda's repo untouched.

---

## Layout to produce

Mirror Tony's structure exactly. Note that in Tony's repo `Vault/` is *both* the
engine-module folder and the extension folder — the extension loads the same
`vault-*.js` files the page does. Keep that.

```
warden.html                 ← the PWA (her repo root)
Warden/
  manifest.json             ← extension (Warden Launcher)
  popup.html  popup.js  background.js  content.js
  oauth-silent.html
  icons/
  warden-crypto.js  warden-store.js  warden-session.js  warden-ui.js
  warden-pay.js  warden-pay-ui.js  warden-pay-panel.js
  warden-id.js  warden-id-ui.js  warden-id-panel.js  warden-id-files.js
  warden-pw-core.js  warden-pw.js
  warden-cloud.js  warden-cloud-ui.js
  warden-icons.js  warden-drag.js  warden-card-drag.js  warden-size.js
  warden-sync.js  warden-cardfill.js  warden-idfill.js  warden-bio-sync.js
  warden-ai-prompt.js
  *.test.js                 ← port the suites too
```

### PWA script load order (from `vault.html` — order matters)

```
icons → crypto → pay → id → id-files → store → session → drag
→ cloud → cloud-ui → ui → pay-ui → id-ui
```

### Extension popup load order (from `Vault/popup.html`)

```
size (in <head>) … icons → sync → card-drag → crypto → pay → id
→ pw-core → pw → pay-panel → id-panel → popup.js
```

Extension tabs: **Links · Passwords · Payments · ID Docs**.

Content scripts (from `Vault/manifest.json`): `warden-cardfill.js`,
`warden-idfill.js`, `warden-ai-prompt.js`, `content.js` on `<all_urls>`
(excluding her Pages origin), plus `warden-bio-sync.js` on her Pages origin only.

---

## ⚠ The architecture fact that drives most of the wiring

**A `chrome-extension://` page cannot satisfy Firebase App Check.** That is why
the extension never talks to Firestore directly — it goes through Cloudflare
Worker proxies that authenticate with a Firebase **service account** (bypassing
App Check and rules) and gate access behind a shared header key.

So the extension and the PWA **do share the same data**; they just reach it by
different routes:

| Data | PWA route | Extension route |
|---|---|---|
| Links | Firestore direct | `keychain-sync` worker → same doc |
| Passwords/vault | Firestore direct | `vault-pw-sync` worker → `dashboards/vault_pw` |
| Attachments | — | `vault-files` worker |

Warden needs **her own equivalents of all three workers**, pointed at her
Firestore docs, with her own service account and her own key.

### 🔴 Current shared-secret problem — do not copy this forward

Both existing launchers ship the **same** hardcoded key:

```
X-Vault-Key: vh-Ou55y3rGmjUn_ZGFTdSIFph2xN_OK
```

`keychain-sync` serves `/keychain` (Tony's Links) and `/links` (Veda's Links) and
today accepts that one key for both — an optional `LINKS_KEY` secret exists to
split them but **is not set**. Warden must be provisioned with its **own key**;
never reuse Tony's.

Because these keys are compiled into a distributable extension, treat them as
"gates a proxy to ciphertext", not as secrets protecting plaintext. That is
already true of the vault (`vault-pw-sync` serves only E2E ciphertext), and it
must stay true of Warden.

---

## Moving Veda's Links out of Index

Today: `dashboards/veda_links` ← written by `index.html` (`#vd-kc-root`,
`VDKC_DOC_PATH`, the `fb-vdkc-*` events) and read by `V1/Launcher`.

Target: Warden owns Links, as the first tab, exactly like Vault's Keychain tab.

Sequence that avoids data loss:
1. Build Warden's Links tab against the **same document shape**
   `{ connections, colmap, savedAt }` so existing data loads untouched.
2. Point it at **her** Firestore doc in **her** project (fresh path, e.g.
   `dashboards/warden_links`) and migrate the contents once.
3. Only then remove the Links tab from `index.html`. Removing it early strands
   her data in a project Warden no longer reads.
4. `index.html` also carries a write-barrier pattern for that doc
   (`_vdkcServerSeen` / pending writes) — Warden must keep an equivalent, see
   Landmine 4.

**Decide:** does her Index keep a *link* to Warden where the Links tab used to
be? (Tony's Index has a Vault button that opens `vault.html`.) Recommended yes,
for symmetry.

---

## What has to be swapped for her

Put every one of these in **one commented config block** at the top of
`warden.html`, and a matching one in the extension.

### PWA (`warden.html`)

| # | What | Tony's value |
|---|---|---|
| 1 | Firebase config (6 fields) | project `task-dashboard-d2b53` |
| 2 | App Check reCAPTCHA site key | `6LeUyAst…` |
| 3 | Vault document | `dashboards/vault_pw` |
| 4 | Cloud settings document | `dashboards/vault_cloud` |
| 5 | Links document | `dashboards/keychain` (hers: `veda_links`) |
| 6 | App-lock worker | `taskhub-reminders.av1.workers.dev` |
| 7 | App-lock entry id | `tony_vault_standalone` |
| 8 | App-lock email / form | `anthonypn99@gmail.com` / `xeedkebo` |

### Extension (`Warden/`)

| # | What | Tony's value |
|---|---|---|
| 9 | Links proxy | `keychain-sync.av1.workers.dev/keychain` |
| 10 | Vault proxy | `vault-pw-sync.av1.workers.dev/vault` |
| 11 | Files proxy | `vault-files.av1.workers.dev/keychain/f/` |
| 12 | Shared header key | `vh-Ou55…` — **must be new for her** |
| 13 | `host_permissions` + content-script origins | `anthonyn99.github.io` |
| 14 | manifest name/description/icons | "Vault Launcher" |

### ⚠ One value lives in a SHARED module

`Vault/vault-ui.js:93-94` hardcodes the **master-password hint** recipient:

```js
var HINT_EMAIL = 'anthonypn99@gmail.com';
var HINT_FORM  = 'https://formspree.io/f/xeedkebo';
```

In Warden this becomes her own value. (In Tony's copy it should be
parameterised via a host-page global so the two don't drift — optional, and
only if touching his file is acceptable.)

Note: this hint is *client-side by design* — it lives in the vault's own config
document — and is a different path from the app-lock hint, which was already
moved server-side. `config.hint` is stored **in plaintext**; it must never be, or
encode, the password.

### Her identity

- Accent `#8D769A`. Body **Nunito**, display **Playfair Display**, mono
  **IBM Plex Mono**. Dark base `#1B1C1E` / surfaces `#26272A`/`#303135`/`#3A3B40`.
- `V1/Launcher/popup.html` is **already in her palette** — lift its `:root`
  block wholesale as the starting token set for both deliverables.
- Email `vedaapatel1605@gmail.com`, Formspree form `xzdlwaqg`.
- App-lock entry ids containing `veda` route to her automatically server-side;
  suggest `veda_warden_standalone`.

---

## Architecture you are building on

### Do not rewrite the engine

`Vault/*.js` is solid — 101 passing assertions. Port it by renaming, not
rewriting.

### The seam that makes local development possible

`vault-ui.js`'s `makeFirebaseBackend()` reaches Firestore through exactly two
globals defined by the host page:

```js
window._fbLoadVault()          // -> { config, items:{id->encDoc}, savedAt } | null
window._fbSaveVault(getState)  // debounced whole-doc setDoc
```

`VaultStore.memoryBackend()` implements the same contract in memory. **This is
how you build and verify the whole app locally with no Firebase at all**, then
switch to her project by config alone.

### Crypto model (unchanged — do not touch)

```
master password ─PBKDF2(600k,SHA-256)→ KEK ─wraps→┐
recovery key    ─PBKDF2─────────────→ KEK ─wraps→┤ DEK (random AES-256-GCM)
biometric slot  ─WebAuthn PRF───────→ KEK ─wraps→┘   └─ encrypts every item
```

- Item doc: `{ id, kind, enc:{iv,ct}, updatedAt, deleted }`. **`kind` is plaintext**;
  title, url, username, password, notes, tags, TOTP all live inside `enc`.
- Auto-lock 30 min idle; clipboard cleared 30 s after copy; DEK memory-only.

### Storage ceiling — already solved, don't redesign it

`dashboards/vault_pw` is **ONE Firestore document** and Firestore caps a document
at **1 MiB**. This is handled, and the design is worth understanding before you
touch anything:

- Passwords, cards and notes live in the document. Fine at hundreds of entries.
- **ID Docs and attachments do NOT.** `vault-id-files.js` encrypts the file with
  the session DEK and uploads the ciphertext to the `vault-files` Worker (KV).
  Only a small descriptor — key, IV, mime, size and a ~3 KB thumbnail — rides in
  the vault doc, itself inside the item's AES-GCM envelope. The upload carries no
  filename, no mime type and no item reference.
- Ciphertext is written to IndexedDB *before* the upload, so a failed upload is
  marked `pending` and retried with backoff rather than lost.

So ID Docs are safe to include as-is. The only consequence is that **her files
worker is required**, not optional. Keep the thumbnail budget small — that is
what protects the ceiling.

---

## Fixes already shipped — port these, don't regress them

All landed 2026-08-21, deployed and verified live. Copying an older pattern
reintroduces real holes.

### App-lock worker (`workers/taskhub-reminders/worker.js`)

1. **`set-lock` refuses blind overwrite** — changing an existing lock needs the
   current password (`current` field).
2. **`/auth/reset/request` no longer returns the code** — the worker emails it;
   reply is `{ok, emailed, to}`. Clients must NOT expect `rq.code`.
3. **`/auth/journal/hint` no longer returns hint text** — worker emails it.
4. **`/auth/journal/status`** — "does a lock exist", no email. Use for boot
   checks; calling `/hint` on boot emails on every page load.
5. **Throttle** — 8 wrong tries → 15 min lockout, separate namespace from
   mailers so a lockout never blocks reset.
6. **Owner routing** (`mailboxFor`): explicit `owner` → `JOURNAL_OWNER[journal]`
   → id contains "veda" → default Tony. Pass `owner:'veda'` explicitly from
   Warden and add a case to `workers/taskhub-reminders/auth.test.mjs`.

### Engine

- **Biometrics use WebAuthn PRF** — key derived by the authenticator each
  unlock, never stored. `enableBiometric()` refuses without PRF (`bio-no-prf`)
  unless `{allowStoredKey:true}`. Slots carry `kind:'prf'|'stored'`;
  `biometricNeedsPrfUpgrade()` + a one-time prompt migrates old slots.
- **Favicons drawn locally** (deterministic letter tiles). Do **not** reintroduce
  `google.com/s2/favicons` — it disclosed every saved domain to Google.

---

## Desktop + mobile parity (explicit requirement)

Warden must be as polished on a phone as Vault is. Port these patterns rather
than reinventing:

- **Sticky offsets are measured, not hardcoded** — `vault-ui.js`'s
  `updateStickyOffset()` and the `--kc-head-h` ResizeObserver block in
  `vault.html`; heads wrap to two lines on narrow screens. Use `Math.floor` on
  the measured height (rounding up shows a hairline seam).
- **`100dvh`, not `100vh`**, plus `env(safe-area-inset-*)` for iOS.
- **Media queries keyed on `pointer:coarse`, not width.** `V1/Launcher/popup.html`
  documents a real bug from getting this wrong: a `max-width:420px` rule matched
  the 352px desktop popup and hid its own resize grip, with no way to get it
  back. Touch targets ≥34px under `@media (pointer:coarse)`.
- **Tab bar and header actions are drag-reorderable** (`vault-drag.js`: mouse
  arms after 5px, touch on a 320ms long-press, edge auto-scroll), with order
  synced through the cloud settings doc.
- **Pull-to-refresh** — `bindPullToRefresh` in `vault-ui.js`.
- Extension popup: `<html>` is the sized element; nothing may be locked to the
  viewport or the popup can never shrink (see the long note in
  `V1/Launcher/popup.html`).

---

## Landmines (each cost real debugging time)

1. **App Check is the big one.** Every existing app shares ONE reCAPTCHA site
   key. Her project needs **its own key registered to HER origin**. It can fail
   **~an hour later, silently, while Auth still works** — "it worked when I
   tested" is not evidence. And the extension cannot use App Check at all, which
   is why the worker proxies exist.
2. **`file://` always shows "sync failed."** Firebase rejects that origin. Not a
   bug. Serve over `http://localhost` for real testing.
3. **Never edit repo files with PowerShell.** PS 5.1 `Get-Content`/`Set-Content`
   round-trips double-encode every non-ASCII character and still pass tests. Use
   Edit/Write or Node.
4. **Whole-doc `setDoc` means a failed load must block saves.** The vault writes
   the entire document; saving after a failed read erases real data. Port the
   write-barrier (`_mlLoadOk` / `_vdkcServerSeen` patterns).
5. **1 MiB per document** — see the ID Docs decision.
6. **Tony's repo auto-commits and pushes every turn** and pulls Veda's commits.
   Don't push/pull manually; expect files to change between turns.
7. **Headless Chrome ignores `--load-extension`.** The extension popup cannot be
   verified as a real extension locally — drive `popup.html` as a plain page with
   `chrome.*` stubbed instead.
8. **CDP port 9333 is taken** by a headless Edge; attaching hijacks its tab.

---

## What can and cannot be verified on Tony's PC

**Can — aim to finish all of this before handoff:**
- Every PWA flow in headless Chrome over a local static server against
  `memoryBackend()`: setup → unlock → add/edit/delete → search → lock → recovery
  reset → payments → notes.
- The extension popup as a plain page with stubbed `chrome.*` and a stubbed sync.
- All ported test suites in Node.

**Cannot — only provable on her side:**
- Her Firebase project, App Check key, Firestore rules.
- Her Cloudflare workers (need her account + a service account).
- GitHub Pages deploy — origin isolation is only real on her domain.
- Loading the extension unpacked; real autofill on real sites.
- Biometrics/PRF — needs a real authenticator.
- First genuine cross-device sync.

**Therefore ship a built-in diagnostic** distinguishing *auth failed* vs *App
Check rejected* vs *rules denied* vs *worker key rejected*. Without it all four
read as "sync failed", and App Check's delayed silent failure is the worst to
debug remotely.

---

## The manual-steps deliverable

The build ends by writing **`Warden/SETUP.md`** — one ordered checklist, concise,
no prose padding. It must cover at minimum:

1. Create her Firebase project; copy the 6 config values into the marked block.
2. Enable **Anonymous** auth.
3. Register a **reCAPTCHA v3 site key** for App Check, with **her Pages origin**
   in the allowed domains; paste it.
4. Publish Firestore rules.
5. Create a Firebase **service account**; note client email + private key.
6. Deploy her three Cloudflare workers (links / vault / files) with those secrets
   plus a **freshly generated** `X-Vault-Key`; paste the worker URLs and key into
   the extension config.
7. Create her GitHub repo, push, enable Pages, note the origin.
8. Re-check that the origin in step 3 matches step 7.
9. Load the extension unpacked (`chrome://extensions` → Developer mode → Load
   unpacked → `Warden/`).
10. Open Warden, set the master password, **write down the recovery key on paper**.
11. Optional: enable biometrics (needs a PRF-capable browser).

Every value the build cannot know must appear as an obvious placeholder
(`__FIREBASE_API_KEY__`) — never a silently-wrong default, and never Tony's real
value left in place.

---

## Test commands

```bash
node Vault/vault-crypto.test.js          # 42 assertions
node Vault/vault-session.test.js         # 59 (incl. PRF + upgrade path)
node Vault/vault-store.test.js
node Vault/vault-pay.test.js
node Vault/vault-id.test.js
node Vault/vault-idfill.test.js
node Vault/vault-cloud.test.js
node workers/taskhub-reminders/auth.test.mjs       # 33 — lock/reset/hint/routing
node workers/taskhub-reminders/lookahead.test.mjs
npm test                                 # repo-wide, includes syntax-check
```

Port each suite alongside its module. A `verify` skill drives pages in real
headless Chrome via CDP.

---

## Build order

Phase it. Each phase ends in a verifiable state, so a session that runs out of
room can hand over cleanly at a phase boundary.

**Phase 1 — port the engine.** Copy + scripted rename into `Warden/`. Port the
test suites. **Done when:** every renamed suite passes and `node --check` is
clean on all JS.

**Phase 2 — the page shell.** `warden.html` from `vault.html`: her palette
tokens, the single config block with `__PLACEHOLDER__` values, the Firebase glue
(`_fbLoadWarden`/`_fbSaveWarden`), app-lock UI, `window.Bio` (PRF version).
**Done when:** it loads over `http://localhost` against `memoryBackend()` and the
lock screen renders.

**Phase 3 — flows verified locally.** Drive it headlessly against
`memoryBackend()`: setup → unlock → add/edit/delete → search → lock → recovery
reset → payments → notes → ID Docs. **Done when:** every flow passes and both
desktop and coarse-pointer layouts are checked.

**Phase 4 — the extension.** `Warden/` manifest, popup, background, content
scripts, the four tabs, her config. **Done when:** `popup.html` drives as a plain
page with `chrome.*` stubbed (headless Chrome cannot load a real extension).

**Phase 5 — Links migration.** Warden's Links tab against the existing
`{connections, colmap, savedAt}` shape; migration path off `dashboards/veda_links`;
only afterwards remove the tab from `index.html`. **Done when:** her real
connections render in Warden.

**Phase 6 — handoff.** Write `Warden/SETUP.md`, confirm no placeholder is left
holding one of Tony's real values, and confirm the folder copies cleanly.

### Definition of done overall

- No `__PLACEHOLDER__` resolved to a Tony value anywhere.
- No `google.com/s2/favicons`, no `rq.code`, no `hd.hint` in any client code.
- No shared `X-Vault-Key` reused.
- Every ported suite green; `npm test` green.
- Desktop **and** `pointer:coarse` layouts verified.

## Decisions — defaults already chosen, override if wrong

A fresh session should **proceed on these defaults** rather than stopping to ask.
Only #2 and #3 are worth a human confirming first.

1. **ID Docs — INCLUDE.** Not an architectural problem; scans already go to the
   files worker (see Storage ceiling). Requires her files worker.
2. **Cloud tab — ASK.** ~207 KB of the port (`vault-cloud.js` +
   `vault-cloud-ui.js`) and it needs her own Google/Dropbox OAuth client ids.
   Dropping it removes a sixth of the build. Default if unanswered: **include the
   tab but leave it unconfigured**, so it is present and inert until she adds
   client ids.
3. **Cloudflare — ASK.** Default: **her workers on Tony's account** under new
   names (`warden-links`, `warden-pw-sync`, `warden-files`) with a freshly
   generated key. Far less setup, and the key is what actually separates them.
   Move to her own account later if she wants full independence.
4. **Index keeps a Warden button** where her Links tab was — mirrors Tony's Vault
   button.
5. **Password floor — raise to 12 characters** in Warden, with the existing
   passphrase hint. The security write-up tells her four words; 8 contradicts it.
6. **Build directly into `Warden/` + `warden.html`** at this repo's root, shaped
   exactly like her repo, so handoff is a straight copy. Do **not** nest it under
   `V1/`.
