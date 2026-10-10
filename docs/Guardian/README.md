# Guardian — the one A1 lock

Guardian is the lock screen for every A1 program. It covers app locks, profile locks, journal-entry locks and TradeHub tab locks, in both A1 and A1-Priv, plus ORCA's screens. It lives in one file, [Guardian/guardian.js](../../Guardian/guardian.js). Programs never build a lock of their own. `tests/guardian-wiring.test.js` fails if any page grows one again.

StudyOS (`V1/`) is deliberately not on Guardian. Neither is Vault's master-password encryption (`Vault/`), which is a PRF key, not a lock.

## Adding a lock to a program

1. Load the one live file, unpinned, in `<head>`. It must not be `defer`, so a locked app never flashes:
   - A1: `<script src="Guardian/guardian.js"></script>`
   - A1-Priv / ORCA: `<script src="https://anthonyn99.github.io/A1/Guardian/guardian.js"></script>`

   Never add `?v=` and never copy the file. Unpinned is what makes one edit to Guardian reach every program within GitHub Pages' 10-minute cache.
2. Declare the lock, then gate on it:

```js
Guardian.define('tony_example', { owner: 'tony', label: 'Example', root: '#app', hard: true });
Guardian.prepaint();                       // sync: hides #app before first paint if this device is locked
Guardian.gate('tony_example').then(open => { if (open) boot(); });
someButton.onclick = () => Guardian.manage('tony_example');   // lock menu / set a password
```

3. Add the page to `HOSTS` in `tests/guardian-wiring.test.js`.

Removing a lock from a program means deleting those lines. Nothing else in the program knows about passwords.

## `define(id, options)`

| option | default | meaning |
|---|---|---|
| `owner` | `veda` if the id contains "veda", else `tony` | theme, plus whose Formspree/inbox gets hints and reset codes |
| `label` | id | title on the card |
| `kind` | `profile` for `profile_*`, else `app` | wording: app, profile, entry or tab |
| `journal`, `entryId` | `applock`, id | the worker record `jlock:<journal>:<entryId>` |
| `root` | — | selector(s) hidden while locked |
| `hard` | false | no Cancel (a standalone page has nowhere to go back to) |
| `allowRemove` | true | false when the password authorises a server API (OneInbox, Insight) |
| `offline` | false | keep a PBKDF2 verifier so `verify()` works without network (Shield) |
| `session` | — | `{mint(pw), check(), end()}`: a server session token (OneInbox, Insight) |
| `backend` | the worker | `{status, verify, set, remove, hint, resetRequest, resetConfirm, bio?}` (ORCA's server) |
| `legacy` | — | old-lock adoption (see below) |
| `onChange(id, what)` | — | after set / change / reset / remove |
| `onBlock(id, reason)` | hide `root` and gate | the lock became required while the page is open |

## API

| call | what it does |
|---|---|
| `gate(id, {hard, message})` | resolves `true` when open (immediately if already), `false` on Cancel |
| `manage(id)` | opens the lock menu, or "set password" if there is no lock yet |
| `setLock(id)`, `changePassword(id)`, `removeLock(id)` | each flow on its own |
| `verify(id)` | always asks, ignoring the device marker, and resolves the password or `null`. Used by Shield's Emergency Mode and guard key |
| `lockNow(id \| ids)` | drops THIS device's unlock only |
| `isLocked`, `isUnlocked`, `mustBlock`, `status(id)` | synchronous answers from the cache |
| `refresh(ids?)` | checks the worker now. A host with a Firestore "lock bell" calls it when the bell rings |
| `isOpen()` | used by LifeHub to stay hidden over a lock |
| `bio.*` | biometric helpers, including PRF for Vault |

Events on `window`: `guardian:ready`, `guardian:open` / `guardian:close`, `guardian:unlock`, `guardian:lock` (`{id, reason}`), `guardian:change`, `guardian:status`.

## How it decides (the version model)

- **The password version.** Passwords live on the `taskhub-reminders` worker in KV `jlock:<journal>:<entryId>` (PBKDF2-SHA256). `/auth/journal/status-many` returns each lock's `ver`, a fingerprint of the record's salt. Every set, change or reset mints a new salt, so **`ver` is the password version**.
- **Unlocked per device.** A device is unlocked while its marker `gd.u.<key>` equals `ver`. The marker is mirrored in localStorage, sessionStorage, memory and a 400-day cookie. You enter a password once per device and stay unlocked until the password changes or you press "Lock this device now".
- **Biometrics.** A credential `gd.b.<key>` is bound to the `ver` it was enrolled under. A password change anywhere voids it on every device, and the next password unlock offers to register again (`gd.s.<key>`).
- **When it checks.** Answers come instantly from the cache `gd.c.<key>`, which also keeps devices unlocked offline. The worker is checked in the background on load, focus and visibility, at most every 3 minutes per lock. A lock this device has never seen is checked first and fails closed.
- **Change password.** This is one `set-lock` call carrying `current`, so a failure can never leave the lock removed.
- **Mail.** Hints and reset codes always send `owner`. The worker picks Tony's (`xeedkebo`) or Veda's (`xzdlwaqg`) Formspree and inbox, and Guardian relays the envelope when the worker can't send it itself.

## Legacy adoption (temporary — Phase 6 removes it)

The first time Guardian meets a lock on a device, the program's old record decides, so the switch asks nobody for a password and keeps every existing fingerprint or Face ID. The credential ids are reused.

Helpers:
- `Guardian.legacy.al(id, bioNs)`: the old app-lock check, `al_locks` plus `al_unlockedat_*`, including TradeHub-style cookie mirrors.
- `Guardian.legacy.marker(prefix, id, v, bioNs)`: the journals' `tj_` / `bj_` markers.
- `{open: () => '<ver>'}`: MAGI's session ver.

Adoption runs once per lock per device (`gd.a.<key>`), so "Lock this device now" is never undone by it.

## Tests

- `node tests/guardian.test.js`: jsdom against a fake worker. Covers version binding, adoption, every flow, owner routing, sessions, offline verify, and the ORCA backend.
- `CDP_ALLOW_FONTS=1 node tests/live/guardian.live.js`: real headless Edge, both themes, desktop and phone, with screenshots.
- `node tests/guardian-wiring.test.js`: every host loads the one unpinned file and nothing else builds a lock.
- `node workers/taskhub-reminders/auth.test.mjs`: the `status-many` route.

Build record and phases: [plan.md](plan.md).
