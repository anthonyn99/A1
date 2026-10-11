# Guardian — the one A1 lock

Guardian is the lock for every A1 program: app locks, profile locks, journal-entry locks and TradeHub's tab locks, across A1 and A1-Priv, and the card on ORCA's gate. It is one file, [Guardian/guardian.js](../../Guardian/guardian.js). No program builds a lock of its own, and `tests/guardian-wiring.test.js` fails if one ever does again.

Two things are deliberately not on Guardian:
- **StudyOS (`V1/`):** it keeps its own backend.
- **Vault's master-password encryption:** `Vault/vault-bio.js` is a PRF-derived key, not a lock.

## Where it runs

| Program | Lock id(s) | Notes |
|---|---|---|
| index (TaskHub) | `tony_*` / `veda_*` / `profile_*` / `<p>_custom_<link>` | thin adapter keeps `alGate` / `alManage` / `alIsLocked` |
| MyJournal / Brainstorm | `tj:<entryId>` / `bj:<entryId>` (journal `tj` / `bj`) | a pane hides the locked editor; the Playbook instance (`pb:`) gets Guardian from `Notebook/notebook.js` |
| Plans (index) | `plans:<who>` | `bioOnly`: a consent check with no password |
| Shield | `tony_shield` / `veda_shield` | `offline:true`; `verify()` lifts Emergency Mode; the card says T/V, never the names |
| MyList | `mylist:profile_<p>` | separate passwords from index's profile locks |
| OneInbox | `tony_oneinbox` | `session` → oneinbox-api token; hard gate; no Remove |
| MAGI | `<p>_magi` | the picker stays; one record shared with index's MAGI nav gate |
| TradeHub (A1-Priv) | `tony_tradehub_standalone`, `tony_tradehub_tab_<tab>` | app lock and per-tab locks |
| Insight (A1-Priv) | `tony_insight` | `session` → insight-api token (Plaid); no Remove |
| Vault / RiftIQ / Solace (A1-Priv) | `tony_vault_standalone` / `tony_warroom_standalone` / `tony_solace_standalone` | hard gates |
| ORCA (Desktop\ORCA) | `<p>_orca` | `backend` over ORCA's own `/lock/*` routes (server sessions and passkeys) |

## Adding a lock to a program

1. Load the one live file, unpinned, in `<head>`. It must not be `defer`, so a locked app never flashes:
   - A1: `<script src="Guardian/guardian.js"></script>`
   - A1-Priv / ORCA: `<script src="https://anthonyn99.github.io/A1/Guardian/guardian.js"></script>`

   Never add `?v=` and never copy the file. Loading it unpinned is what makes one edit to Guardian reach every program within GitHub Pages' 10-minute cache.
2. Declare the lock, then gate on it:

```js
Guardian.define('tony_example', { owner: 'tony', label: 'Example', root: '#app', hard: true });
Guardian.prepaint();                       // sync: hides #app before first paint if this device is locked
Guardian.gate('tony_example').then(open => { if (open) boot(); });
someButton.onclick = () => Guardian.manage('tony_example');   // the lock menu, or "set a password"
```

3. Add the page to `HOSTS` in `tests/guardian-wiring.test.js`. If it hosts LifeHub, use `data-lock="guardian"`.

Removing a lock means deleting those lines. Nothing else in the program knows about passwords.

## What every lock gets

- **Unlock:** a password field with a show/hide eye. The eye is 36px, or 44px on touch screens. It never takes focus, so a phone keyboard stays up, and it keeps the caret where it was.
- **Caps Lock warning** on every password field.
- **Biometric unlock** (Face ID, Touch ID, Windows Hello, fingerprint).
- **Lock menu:**
  - Lock this device now
  - Register or remove biometrics
  - Change password: one atomic call that carries `current`
  - Remove lock (unless `allowRemove:false`)
  - Cancel
- **Recovery:**
  - "Email me my hint"
  - "Reset password" by an emailed 6-character code
  - New password + confirm + hint when setting or changing a password
- **Mail routing:** every request carries `owner`, so Tony's mail goes to Tony's Formspree and inbox and Veda's to hers.
- **Themes:**
  - Tony: MAGI tokens with Inter and Manrope.
  - Veda: her TaskHub palette with Lora titles and Inter.
- **Phone layout:**
  - 46px buttons
  - 16px field text (no iOS zoom)
  - safe-area insets
  - on a short screen (keyboard up), the card scrolls instead of being clipped
- **One card at a time:** a second gate waits for the first card to close instead of dismissing it.

## `define(id, options)`

| option | default | meaning |
|---|---|---|
| `owner` | `veda` if the id contains "veda", else `tony` | theme, plus whose Formspree/inbox gets hints and reset codes |
| `ownerName` | Tony / Veda | how the card names the owner (Shield: `T` / `V`) |
| `label` | id | title on the card |
| `kind` | `profile` for `profile_*`, else `app` | wording: app, profile, entry or tab |
| `journal`, `entryId` | `applock`, id | the worker record `jlock:<journal>:<entryId>` |
| `root` | — | selector(s) hidden while locked (`prepaint`, `gate`, `onBlock`) |
| `hard` | false | no Cancel (a standalone page has nowhere to go back to) |
| `allowRemove` | true | false when the password authorises a server API |
| `offline` | false | keep a PBKDF2 verifier so `verify()` works with no network (Shield) |
| `bioOnly` | false | a biometric with no password behind it (Plans) |
| `session` | — | `{mint(pw), check(), end()}`: a server token the password mints |
| `backend` | the worker | `{status, verify, set, remove, hint, resetRequest, resetConfirm, bio?}`. `status` may return `unlocked` (server-held session); `bio.available` may rule biometrics out |
| `legacy` | — | old-lock adoption (see below) |
| `onChange(id, what)` | — | after set / change / reset / remove (`what`) |
| `onBlock(id, reason)` | hide `root` and gate | the lock became required while the page is open (`changed`, `locked`, `session`, `manual`) |

## API

| call | what it does |
|---|---|
| `gate(id, {hard, message})` | resolves `true` when open (immediately if already), `false` on Cancel |
| `manage(id)` | the lock menu, or "set password" if there is no lock yet; resolves `'locked'` after "Lock this device now" |
| `setLock(id)`, `changePassword(id)`, `removeLock(id)` | each flow on its own |
| `verify(id, {title, message})` | always asks, ignoring the device's unlock, and resolves the password or `null` |
| `lockNow(id \| ids)` | drops THIS device's unlock only (and ends its `session`) |
| `forget(id, password?)` | the locked thing was deleted (a journal entry): drop its traces here, and on the server given the password |
| `isLocked`, `isUnlocked`, `mustBlock`, `status(id)` | synchronous answers from the cache |
| `refresh(ids?)` | checks the worker now. The cross-device "bell" (`dashboards/applock`, MyList's `lockV`) calls this |
| `prepaint(ids?)`, `hideRoot(id)`, `showRoot(id)` | the content a lock hides |
| `isOpen()`, `close()` | a card is up; LifeHub stays hidden while it is |
| `hasOffline(id)` | Shield's Security tab |
| `bio.available/label/isRegistered/register/remove/authenticate/hasPrf` | the biometric helpers |

Events on `window`: `guardian:ready`, `guardian:open` / `guardian:close`, `guardian:unlock`, `guardian:lock` (`{id, reason}`), `guardian:change`, `guardian:status`.

## How it decides (the version model)

- **The password version.**
  - Passwords live on the `taskhub-reminders` worker, in KV `jlock:<journal>:<entryId>` (PBKDF2-SHA256).
  - `/auth/journal/status-many` returns each lock's `ver`, a fingerprint of the record's salt. It is read-only and capped at 60 locks per call.
  - Every set, change or reset mints a new salt, so **`ver` is the password version**.
- **Unlocked per device.**
  - A device is unlocked while its marker `gd.u.<key>` equals `ver`.
  - The marker is mirrored in localStorage, sessionStorage, memory and a 400-day cookie, so it survives Brave's evictions. Veda's storage-blocked Brave still works for the session.
  - You type a password once per device and stay unlocked until the password changes or you press "Lock this device now".
- **Biometrics.**
  - A credential `gd.b.<key>` is bound to the `ver` it was enrolled under.
  - A password change anywhere voids it on every device.
  - The next password unlock then offers to register again (`gd.s.<key>`).
- **When it checks.**
  - Answers come instantly from the cache `gd.c.<key>`, which also keeps a device unlocked offline.
  - The worker is checked in the background on load, focus and visibility, at most every 3 minutes per lock.
  - A lock this device has never seen is checked first, and fails closed.
  - If a lock is removed while its card is up, the card closes and lets you in.
- **Mail.** The worker picks Tony's (`xeedkebo`) or Veda's (`xzdlwaqg`) Formspree and inbox from `owner`. Guardian posts the relay envelope itself when the worker can't send it.

## Legacy adoption — keep until 2026-11-10, then retire

The first time Guardian meets a lock on a device, the program's old record decides. That way the switch asked nobody for a password and kept every fingerprint (the credential ids are reused). Adoption runs once per lock per device (`gd.a.<key>`), so "Lock this device now" is never undone by it.

Helpers:
- `legacy.al(id, bioNs, bioId)`: `al_locks` plus `al_unlocked*`, also read from A1-Priv's `alDur` cookies.
- `legacy.marker(prefix, id, v, bioNs)`: the journals' `tj_` / `bj_` markers.
- `legacy.bioRec(ns, id, v)`.
- Per program `{open, locked, bio}`: MyList `ml_unlocked_*`, MAGI `magi.<p>.lock_session`, OneInbox / Insight session tokens.

**Retiring it** (once every device has opened every program since 2026-10-10; a month is ample):
1. Delete the `LEGACY ADOPTION` section and `legacy` from `guardian.js`, and every `legacy:` in the hosts.
2. Add the old keys to `cleanup-rules.json`, starting as dry-run:
   - `al_unlockedat_*`, `al_unlockedv_*`, `al_unlocked_*`
   - `tj_unlocked*`, `bj_unlocked*`, `ml_unlocked_*`
   - `magi.<p>.lock_session` / `.locked` / `.bio_ver`
   - `oneinbox_locked`, `insight_locked`
   - `bio_cred_applock_*`, `bio_cred_tj_*`, `bio_cred_bj_*`, `bio_cred_plans_*`, `bio_cred_shield_*`, `bio_cred_mylist_*`, `bio_cred_magi_*`, `bio_cred_oneinbox_*`
   - A1-Priv: `bio_cred_tradehub*_*`, `bio_cred_vaultlock_*`, `bio_cred_warroomlock_*`, `bio_cred_solacelock_*`, `bio_cred_insight_*`
   - **Never `bio_cred_vault_*`:** that is the vault's encryption.
3. Keep `al_locks`: it is the cross-device bell's cache.

`tests/cleanup-rules.test.js` refuses a listed key that live code still reads, which is why these keys are not in the registry yet.

## Tests

- `node tests/guardian.test.js` (jsdom, fake worker): version binding, adoption (including cookie-only), every flow, the eye on every screen, owner routing, sessions, server-held backends, offline verify, the gate queue.
- `CDP_ALLOW_FONTS=1 node tests/live/guardian.live.js`: real headless Edge, both themes, desktop and phone (touch), the eye, the short-screen scroll. Screenshots are saved.
- One live suite per program group:
  - `guardian-index`, `guardian-shield`, `guardian-journals`
  - `guardian-phase3` (MyList, OneInbox, MAGI)
  - `guardian-priv` (A1-Priv)
  - `guardian-orca` (needs `../ORCA`)
- `node tests/guardian-wiring.test.js`: every host loads the one unpinned file, and nothing else builds a lock.
- `node workers/taskhub-reminders/auth.test.mjs`: the `status-many` route.

Test infrastructure:
- `tests/live/cdp.js` answers `status-many` with "no locks" unless a test supplies an answer, so no test depends on the real lock records.
- `A1_PRIV` points the suites at another A1-Priv checkout.
- A reused CDP tab keeps sessionStorage, which Guardian mirrors into, so clear both stores between runs.

Build record: [plan.md](plan.md).
