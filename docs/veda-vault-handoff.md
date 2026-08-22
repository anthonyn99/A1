# Veda's Vault — build handoff

Context compiled 2026-08-21 for starting a fresh session. Read this first; it is
self-contained.

## The goal

Build Veda a **full copy of the Vault program** — the whole thing (Keychain,
Passwords, Payments, ID Docs, Sensitive Info, Cloud), in her visual identity,
running as **her own standalone program on her own accounts**. Not a tab inside
Tony's `index.html`.

Tony builds it on his PC. Veda receives it, drops it in her own repo, fills in a
config block, and deploys to her own GitHub Pages.

**Explicitly NOT in scope for the build session:** changing Tony's own Vault. His
stays where it is.

---

## Why "her own program" and not a section of Index

This was decided after a security review. The short version:

Browser isolation is **per origin**, not per file. Every A1 app (`index.html`,
`vault.html`, `tradehub.html`, `riftiq.html`, `shield.html`, `insight.html`,
`oneinbox.html`, `solace.html`, `mylist.html`, `wellness.html`) is served from
the one origin `anthonyn99.github.io/A1` and shares one Firebase project
(`task-dashboard-d2b53`). They therefore share localStorage, IndexedDB and the
Firestore cache.

Firestore rules are `allow read, write: if request.auth != null` with **anonymous**
auth, so there is no per-person identity to enforce against — any app holding a
token for the project can fetch any `dashboards/*` document.

Putting Veda's vault on her own origin + her own Firebase project is what turns
"we trust each other" into a boundary the browser actually enforces. That is the
whole point of the exercise; don't quietly collapse it back into Index.

---

## Architecture you are building on

### The engine is already written and account-agnostic

Do **not** rewrite the vault engine. It is solid — 101 passing assertions across
its own suites. Reuse `Vault/*.js` as-is.

Load order matters (copied from `vault.html`):

```
vault-icons.js  vault-crypto.js  vault-pay.js  vault-id.js  vault-id-files.js
vault-store.js  vault-session.js  vault-drag.js  vault-cloud.js
vault-cloud-ui.js  vault-ui.js  vault-pay-ui.js  vault-id-ui.js
```

### The seam that makes local development possible

`vault-ui.js`'s `makeFirebaseBackend()` reaches Firestore through exactly two
globals defined by the **host page**:

```js
window._fbLoadVault()      // -> { config, items:{id->encDoc}, savedAt } | null
window._fbSaveVault(getState)   // debounced whole-doc setDoc
```

`VaultStore.memoryBackend()` implements the same contract in memory.

**This is the key fact for the build:** the entire app can be built and driven
locally against `memoryBackend()`, with no Firebase at all, then switched to her
project by changing config only.

### Crypto model (unchanged, do not touch)

```
master password ─PBKDF2(600k,SHA-256)→ KEK ─wraps→┐
recovery key    ─PBKDF2─────────────→ KEK ─wraps→┤ DEK (random AES-256-GCM)
biometric slot  ─WebAuthn PRF───────→ KEK ─wraps→┘   └─ encrypts every item
```

- Item doc: `{ id, kind, enc:{iv,ct}, updatedAt, deleted }`. **`kind` is plaintext**
  (routing); everything else — title, url, username, password, notes, tags,
  custom fields, TOTP — is inside `enc`.
- `config` holds salts, wrapped keys, a verifier, `securityStamp`, and `hint`.
- **`config.hint` is stored in PLAINTEXT** and is readable by anyone who can read
  the vault document. It must never be, or encode, the password.
- Auto-lock 30 min idle; clipboard cleared 30 s after copy; DEK is memory-only.

### Storage shape and its hard ceiling

`dashboards/vault_pw` is **ONE Firestore document**: `{ config, items:{...}, savedAt }`.
Firestore's per-document limit is **1 MiB**.

Passwords, cards and notes are fine at hundreds of entries. **ID Docs store
encrypted scans** — image blobs will blow the ceiling.

> **OPEN DECISION — settle before building.** If Veda wants ID Docs with real
> scans, the storage design must change (per-item documents, or blobs in a
> Cloudflare KV/R2 worker as `vault-id-files.js` already contemplates). Ask.

---

## What has to be swapped for her

There are only **8 account-bound values** in `vault.html`, plus one in a shared
module. Put them ALL in one commented config block at the top of her page.

| # | What | Current (Tony) | Where |
|---|------|----------------|-------|
| 1 | Firebase config (6 fields) | `task-dashboard-d2b53` | `vault.html` module script |
| 2 | App Check reCAPTCHA site key | `6LeUyAst…` | same block |
| 3 | Firestore vault doc | `dashboards/vault_pw` | `_fbLoadVault`/`_fbSaveVault` |
| 4 | Cloud settings doc | `dashboards/vault_cloud` | cloud glue |
| 5 | App-lock worker | `taskhub-reminders.av1.workers.dev` | `AL_WORKER` |
| 6 | App-lock entry id | `tony_vault_standalone` | `APPID` |
| 7 | App-lock email | `anthonypn99@gmail.com` | `AL_EMAIL` |
| 8 | App-lock Formspree form | `xeedkebo` | `AL_FORM` |

### ⚠ The one that is NOT in `vault.html`

`Vault/vault-ui.js` lines 93–94 hardcode the **master-password hint** recipient:

```js
var HINT_EMAIL = 'anthonypn99@gmail.com';
var HINT_FORM  = 'https://formspree.io/f/xeedkebo';
```

This is a **shared module**, so it cannot simply be edited for Veda without
changing Tony's too. **Parameterise it** — read from a host-page global (e.g.
`window.VAULT_HINT = { email, form }`) with the current values as the fallback so
Tony's build is unaffected.

Note this hint is a *different* thing from the app-lock hint, which was already
fixed server-side (see below). This one is client-side by design, because the
hint lives in the vault's own config document.

### Veda's identity

- Accent `#8D769A` (her purple). Body **Nunito**, display **Playfair Display**,
  chrome/mono **IBM Plex Mono** — matches her existing apps.
- Her email `vedaapatel1605@gmail.com`, her Formspree form `xzdlwaqg`.
- App-lock entry ids containing `veda` route correctly server-side (see below).
  Suggest `veda_vault_standalone`.

---

## Fixes already shipped (do not regress these)

All of this landed on 2026-08-21 and is **deployed and verified live**. If the
new build copies an older pattern it will reintroduce real holes.

### App-lock worker (`workers/taskhub-reminders/worker.js`) — deployed

1. **`set-lock` no longer allows blind overwrite.** Changing an existing lock
   requires the current password (`current` field). Creating one where none
   exists is still open (first-run).
2. **`/auth/reset/request` no longer returns the code.** The worker emails it and
   replies `{ok, emailed, to:"v***@…"}`. Clients must NOT expect `rq.code`.
3. **`/auth/journal/hint` no longer returns hint text.** The worker emails it.
4. **`/auth/journal/status`** added — "does a lock exist", no email. Use this for
   any boot-time check; calling `/hint` on boot would email on every page load.
5. **Server-side throttle** — 8 wrong tries → 15 min lockout, in a separate
   namespace from the mailers so a lockout never blocks the reset path.
6. **Owner routing** via `mailboxFor()`: explicit `owner` → `JOURNAL_OWNER[journal]`
   → id contains "veda" → default Tony.

> Any new lock id or journal must route to Veda. Pass `owner:'veda'` explicitly
> and add a case to `workers/taskhub-reminders/auth.test.mjs`.

### Client flows (all 9 apps)

Pages no longer mail hints/codes themselves and no longer read `rq.code` or
`hd.hint`. Copy the *current* `_pwReset` shape, not an old one.

### Vault engine

- **Biometrics use WebAuthn PRF.** The unlock key is derived by the authenticator
  each unlock and never stored. `enableBiometric()` refuses on browsers without
  PRF (`bio-no-prf`) unless `{allowStoredKey:true}`. Slots carry `kind:'prf'|'stored'`.
  `biometricNeedsPrfUpgrade()` + a one-time UI prompt migrates old slots.
- **Favicons are drawn locally** (deterministic letter tiles). Do not reintroduce
  `google.com/s2/favicons` — it disclosed every saved domain to Google.

---

## Landmines (each one cost real debugging time)

1. **App Check is the big one.** All existing apps share ONE reCAPTCHA site key.
   Veda's project needs **its own key, registered to HER origin**. It can fail
   **~an hour later, silently, while Auth still works** — so "it worked when I
   tested" is not evidence.
2. **`file://` always shows "sync failed."** Firebase rejects that origin. Not a
   bug. Serve over `http://localhost` for any real testing.
3. **Do not edit repo files with PowerShell.** PS 5.1 `Get-Content`/`Set-Content`
   round-trips double-encode every non-ASCII character and still pass tests. Use
   the Edit/Write tools or Node.
4. **Whole-doc `setDoc` means a failed load must block saves.** The vault writes
   the entire document; saving after a failed read erases real data. See the
   `_mlLoadOk` / write-barrier pattern in `index.html`.
5. **1 MiB per document** — see the ID Docs decision above.
6. **Tony's repo auto-commits and pushes every turn** via hooks, and pulls Veda's
   commits. Don't push/pull manually; expect files to change between turns.

---

## What can and cannot be verified on Tony's PC

**Can (aim to finish all of this before handoff):**
- Every UI flow, driven in headless Chrome over a local static server against
  `VaultStore.memoryBackend()` — this is the main verification strategy.
- The crypto/session/store suites (Node).
- Setup → unlock → add/edit/delete → search → lock → recovery-key reset.

**Cannot — only provable on her side:**
- Her Firebase project, App Check key, and the rules that go with it.
- GitHub Pages deploy (origin isolation is only real once it is on her domain).
- Biometrics/PRF — needs a real authenticator; headless cannot fake it.
- The first genuine cross-device sync.

**Therefore: ship a built-in diagnostic** that distinguishes *auth failed* vs
*App Check rejected* vs *rules denied*. Without it all three read as "sync
failed," and App Check's delayed, silent failure is the worst to debug remotely.

---

## Test commands

```bash
node Vault/vault-crypto.test.js          # 42 assertions
node Vault/vault-session.test.js         # 59 assertions (incl. PRF + upgrade)
node Vault/vault-store.test.js
node Vault/vault-pay.test.js
node Vault/vault-id.test.js
node workers/taskhub-reminders/auth.test.mjs      # 33 — lock/reset/hint/routing
node workers/taskhub-reminders/lookahead.test.mjs # KV write-rate safety
npm test                                 # repo-wide, includes syntax-check
```

There is also a `verify` skill that drives pages in real headless Chrome via CDP.

---

## Open questions for Tony/Veda before building

1. **ID Docs with real scans — yes or no?** Changes the storage design. (See 1 MiB.)
2. **Her own Cloudflare worker for the app lock, or reuse Tony's?** Reusing is
   fine security-wise (it only stores a salted PBKDF2 hash keyed by entry id, and
   routing already sends her mail to her). Her own is cleaner separation but is
   another account to set up.
3. **Does she want the Cloud tab** (Google Drive / Dropbox browser)? It is a
   large chunk of the program and needs her own OAuth client ids.
4. **Password floor** — the app currently accepts 8 characters. The security
   write-up tells her to use a four-word passphrase. Raise the minimum, or leave
   it as advice?
