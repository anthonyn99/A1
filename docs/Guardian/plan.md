# Guardian — one lock system for every A1 program

## Context
Today every program carries its own copy of the lock: 7 `window.Bio` copies, 5 `_mailRelay` copies, 2 `_pwReset` copies, and 5 different "is this device unlocked" models:
- Firestore `dashboards/applock` `v` plus `al_unlockedat_*` (index, shield, TradeHub/Vault/RiftIQ/Solace)
- `entry.lock.v` plus `tj_/bj_unlockedat_*` (journals)
- an exact-match `ml_unlocked_*` against `lockV` (MyList)
- the worker `ver` fingerprint (MAGI)
- worker session tokens (OneInbox, Insight)

Every program already shares one password backend: `workers/taskhub-reminders` (`jlock:<journal>:<entryId>`, PBKDF2-100k). Mail goes through `mailboxFor`: Tony → Formspree `xeedkebo`, Veda → `xzdlwaqg`.

Goal: one widget, **Guardian** (one folder, like LifeHub and Notebook), that every program calls. Same passwords and same biometrics, so neither of you notices the switch. Same features everywhere. Tony's theme on Tony's locks, Veda's theme on Veda's. Adding or removing a lock in any program becomes a few lines.

**Out of scope, per your answers:** StudyOS (`V1/`) is not touched. Vault's *master password* (the encryption KEK in `Vault/vault-crypto.js`) is encryption, not a lock, so it stays. Only Vault's app lock moves.

## User additions (mid-build)
1. All old per-program lock code is purged; guardian-wiring.test.js fails if any host keeps its own overlay/Bio/_mailRelay/_pwReset.
2. Upgradable in one place: every host loads the single live file with NO ?v= pin (wiring test forbids it); hosts only declare locks, so any Guardian change reaches all programs within Pages' 10-min cache. Legacy adoption lives in a marked section of guardian.js (no separate legacy.js), removed in Phase 6.

## Guardian design

**Files (3):**
- `Guardian/guardian.js`: core, UI and themes, inline CSS in shadow DOM.
- `Guardian/legacy.js`: one-time adoption of old markers and biometrics. It is fetched only when a device still has old keys, and deleted in Phase 6.
- `docs/Guardian/README.md`: the contract.

**Loading:**
- A1 pages: `<script src="Guardian/guardian.js?v=…">` in `<head>`. It must load before paint so a locked app never flashes its content.
- A1-Priv and ORCA: the absolute `https://anthonyn99.github.io/A1/Guardian/guardian.js` URL.
- `?v=` stamps are rewritten by extending `tools/notebook-stamp.js`, which already covers the A1-Priv sibling.

**API (sketch):**
```
Guardian.define(id, {owner:'tony'|'veda', label, journal='applock', entryId=id,
                     root?, hard?, allowRemove=true, bioNs?, legacy?, session?, backend?, onChange?})
Guardian.prepaint([ids])   // sync: hides roots from the cache before first paint
Guardian.gate(id)          // Promise<true>: resolves on unlock; rejects on Cancel (cancel = back to program)
Guardian.isUnlocked(id) / Guardian.status(id)
Guardian.manage(id)        // menu: Lock this device now · Register/Remove biometrics · Change password · Remove lock · Cancel
Guardian.setLock(id) / Guardian.lockNow(id|ids) / Guardian.verify(id) → password (Shield emergency/guard key)
Guardian.isOpen()          // LifeHub's lock check; replaces data-lock selectors
events: guardian:unlock / guardian:lock / guardian:change on window
```

**One version model:** the worker's `ver`, which is SHA-256 of the record's salt. Every set, change or reset mints a new salt, so a password change re-locks every device and invalidates every biometric. No Firestore is needed, so any program, ORCA included, can use it.

**Local keys:**
- `gd.u.<j>:<e>`: unlocked at this ver.
- `gd.l.<j>:<e>`: "Lock this device now".
- `gd.c.<j>:<e>`: cached `{hasLock, ver}`.
- `gd.b.<j>:<e>`: `{credId, ver, prf?}`.
- All storage calls go through try/catch with a memory fallback (Veda's Brave blocks storage), plus a cookie mirror like today's `alDur`.

**Refresh:**
- The cached state decides instantly, so a device stays unlocked offline.
- A background `/auth/journal/status` runs on load and on visibilitychange (at most once a minute).
- If `ver` has changed, Guardian drops the unlock and the biometric and shows the gate. After the next password unlock it offers to re-register biometrics.
- With no cache, it fails closed.

**Features, built once:**
- Unlock with a show/hide toggle.
- Biometric unlock: WebAuthn with the *same credential ids* as today, so the same fingerprint or Face prompt.
- Set lock, with a hint.
- Change password: one atomic `set-lock` with `current`. This fixes the remove-then-set gap described under bugs.
- Remove lock.
- Lock this device now.
- Register and remove biometrics.
- "Email me the hint" (`/auth/journal/hint`).
- Reset by emailed code (`/auth/reset/request|confirm`).
- One `_mailRelay` fallback for Formspree.
- `owner` is always sent, so mail is routed to Tony's or Veda's Formspree and inbox.
- The client throttle stays at 5 wrong tries, then 30 seconds.

**Themes** (chosen by `owner`):
- **Tony (MAGI tokens from `magi.html:52-84`):** bg `#1a1a1d`, card `#232327`, `--bdl #45454c`, accent `#c0aeea`, red `#d68a7c`. Inter UI with Manrope titles. Buttons are 10px, 700, uppercase, radius 6. The dialog has a `rgba(0,0,0,.62)` blurred backdrop and radius 8. No gradients.
- **Veda (her TaskHub `VD_T` from `index.html:13438` and `brainstorm.css:40-63`):** bg `#1B1C1E`, card `#26272A`, border `#3D3E43`, accent `#8D769A` / `#A892B0`, text `#ECECEE` / `#AFB0B5`. Lora titles with Inter body. Radius 6.

**Adoption without visible change (`legacy.js`):**
- On first sight of an id, if the program's *old* "unlocked" test passes and the old version still matches, Guardian writes `gd.u` at the current `ver`. It also copies the old `bio_cred_<ns>_<id>` credential id (and PRF fields) into `gd.b`.
- The old tests are:
  - `al_unlockedat_*` ≥ `al_locks[id].v`
  - the journal's `entry.lock.v` (host passes `legacy.v`)
  - MyList's `lockV`
  - MAGI's `lock_session.ver`
- OneInbox and Insight keep their server session token through the `session` hook (`mint(pw)` / `check()` / `end()`), because the password authorises the Mail and Plaid APIs on the server.
- Old keys stay readable until Phase 6, then go to `cleanup-rules.json`, dry-run first.

**Shared ids stay shared.** index ↔ Shield (`al_*`) and index's `tony_magi` nav gate ↔ MAGI already share an unlock. Same id on the same origin means one unlock, as today.

**Transition safety:** until Phase 6, `onChange` still bumps `dashboards/applock` `v`, so any page not yet migrated still re-locks on a password change.

**Worker:** add `/auth/journal/status-many`, read-only with zero KV writes, so index Settings can show many locks in one call. It deploys through `deploy-workers.yml` and is covered by `auth.test.mjs`.

## Phases (each: build → test → commit/push → next)

**Phase 0: Core.**
- `git pull` in A1, A1-Priv and ORCA first.
- Build `Guardian/guardian.js`, `legacy.js`, the `status-many` route and the README.
- Tests:
  - `tests/guardian.test.js` (jsdom): version binding, stale bio, lock-now, offline cache, fail-closed, adoption from every legacy shape, owner routing.
  - `tests/live/guardian.live.js` (cdp, fake worker, fake `PublicKeyCredential`): every screen in both themes, with screenshots.
  - `tests/guardian-wiring.test.js`, modelled on `tests/lifehub-wiring.test.js`: a HOSTS list, and a check that no host keeps an inline `window.Bio` / `_mailRelay` / `_pwReset` / lock overlay.

**Phase 1: index.html (TaskHub) and Shield.**
- index: remove the lock CSS, Bio, overlay and AL code (`index.html:20517-21771`) and turn `AL_LABELS` into `Guardian.define` calls.
- Wire through Guardian:
  - the profile chooser and auto-landing (`16504`, `16609`)
  - the nav gates for TradeHub, Solace, MAGI, Shield, Vault and RiftIQ (`22598-22723`)
  - Rules and Reels
  - custom-link locks
  - the Settings "Profile Lock" and "Internal Programs" rows
- Shield: `window.AL` (`shield.html:1704-2320`) → Guardian. `verifyNow` → `Guardian.verify`, `lockA1Apps` → `Guardian.lockNow(ids)`. The offline verifier `sh_offline_*` becomes a Guardian `offline` option. `/shield/key` and emergency stay as host code.
- LifeHub: `lockedNow()` also asks `Guardian.isOpen()`. Remove `#applock-overlay` from hoverfx `data-roots`.

**Phase 2: Notebook.**
- Replace the per-entry lock IIFEs in `Notebook/apps/myjournal.js:3434-3964` and `brainstorm.js:3725-4258`, plus their overlays and CSS. Locks stay `jlock:tj|bj:<entryId>`, Tony and Veda themes.
- The host passes `entry.lock.v` for adoption. Keep `_tjLockCheck` / `_tjIsUnlocked` as thin wrappers so instancing (pb) and `notebook.js:263` still work.
- Remove index's `_mailRelay` (`5986`) and `_pwReset` (`19222`).
- OurJournal has no lock of its own; it stays covered by the journal app locks. Shared entries stay unlockable by both of you by design.
- Prove with `node tests/live/notebook-baseline.live.js`.

**Phase 3: MyList, OneInbox, MAGI.**
- MyList: `jlock:mylist:profile_*`. These are separate passwords from index's and stay separate.
- OneInbox: `session` hook to `oneinbox-api /lock/*`, `allowRemove:false`. Delete the dead `FORM_URL`.
- MAGI: the picker cards stay. Locked cards open Guardian. Remove `magi.html:27820-28630`'s lock UI.
- Run `magi-guard.live.js`.

**Phase 4: A1-Priv** (edit in `Desktop\A1-Priv`; its CLAUDE.md applies).
- TradeHub: the app lock and per-tab locks (`tony_tradehub_tab_<id>`). `TBTabGate` calls `Guardian.gate`.
- Insight: `session` hook to `insight-api`, no remove.
- Vault: app lock only.
- RiftIQ and Solace.
- Deploy through `tools/deploy.mjs`.
- Rewrite `tests/live/lock-bio-binding.live.js` to drive the real a1-priv pages, not A1's redirect stubs.

**Phase 5: ORCA** (Desktop\ORCA, branch `accounts`).
- The gate page loads Guardian by URL with a `backend` adapter that calls ORCA's own `/lock/*` routes. Server sessions (HttpOnly cookies), D1 WebAuthn and the existing passkeys stay. Tony's and Veda's cards get their themes.
- Retire `app/web/static/lock.js` and its CSS (`app.css:917-1090`).
- Deploy with `cd worker; npx wrangler deploy`.

**Phase 6: Cleanup and docs.**
- Remove `legacy.js` adoption once the live checks confirm it.
- Add old keys to `cleanup-rules.json` as dry-run: `al_*`, `tj_/bj_unlocked*`, `ml_unlocked_*`, `bio_cred_*`, `magi.*.lock_session`, and the `dashboards/applock` registry once nothing reads it.
- Delete stale comments repo-wide.
- Add a CLAUDE.md entry ("Adding a lock to a program → docs/Guardian/README.md").
- Write memory notes.

## Bugs to fix along the way
- **Change password is not atomic** (verify → remove-lock → set-lock in index, MyList and the A1-Priv pages). A failure in the middle leaves no lock. MyList also ignores the remove result (`mylist.html:2328`). Guardian replaces this with one `set-lock` call that sends `current`.
- **`tony_magi` has no `AL_LABELS` entry**, so the overlay falls back to the raw id in gold.
- **`lock-bio-binding.live.js` tests the redirect stubs**, not the real pages.
- **Stale comments** ("SHA-256", "gold for Tony", the `xeedkebo` comment in Insight, OneInbox's dead `formspree()`).
- **Double lock:** index's nav gate (`tony_tradehub`) and the A1-Priv standalone lock (`tony_tradehub_standalone`) are kept as-is, so nothing changes for you. I'll mention them as a possible merge later.

## Verification
- Every phase:
  - `npm test`, including the new Guardian unit and wiring tests and `workers/taskhub-reminders/auth.test.mjs`.
  - `node tests/live/guardian.live.js`.
  - The program's own live tests: notebook-baseline, magi-guard, lifehub-wiring and the rewritten lock-bio-binding.
  - The verify skill on index.
- **"No change for us" test:** seed each program's real legacy localStorage shapes (copied from the code paths above) in headless pages. Assert that the page opens unlocked with no prompt and the biometric is adopted. Then bump `ver` on the fake worker and assert re-lock, stale biometric and a re-register offer.
- **Mail routing:** worker unit tests on `mailboxFor` for Tony and Veda ids, plus the mocked live flows. Before sending a single real hint or reset email to each of you, I'll ask you.
- **Last step for you (only manual work):** open each program once on each device and confirm it opens without a prompt and biometrics still work.

## Progress (2026-10-10)
- Phase 0 DONE — Guardian/guardian.js, worker /auth/journal/status-many, tests (guardian.test.js, guardian-wiring.test.js, live/guardian.live.js).
- Phase 1 DONE — index app/profile/widget locks (thin adapter keeps alGate/alManage/…), Shield (window.AL shim, verify + offline). Fixed: new-device adoption hole; MyJournal never re-gated (position:fixed root vs offsetParent).
- Phase 2 DONE — MyJournal/Brainstorm entry locks (pane + Guardian card), Plans bio-only, index's Bio/_mailRelay/_pwReset deleted, Notebook loader brings Guardian to instances. Fixed: fresh-device landing waits for the worker; a late gate re-navigating into Tony's TaskHub while Veda was open; a stray `}` that dropped MyJournal's Edit toggle; Brainstorm locked-delete fails closed. notebook-baseline (NB_SKIP_LOCK=1 vs 47690e4): both journals byte-identical, 16 screenshots identical.
- Development note: the auto-committer ships every edit, so larger edits are built in a git worktree (Desktop\A1-gd), tested with A1_ROOT=..\A1-gd, then copied in.
- Phase 3 DONE — MyList (profile locks, legacy ml_unlocked/lockV), OneInbox (session hook: password mints the mailbox token; hard gate; no Remove; 401 re-locks), MAGI (picker kept, Guardian card over it; header padlock = Guardian menu; GID shared with index's tony_magi). Guardian gained a Caps Lock warning and closes an open unlock card when the lock is removed elsewhere. Fixed: MyList boot-before-`var G` ordering; MyList "no lock in synced state" adoption. tests/live/guardian-phase3.live.js replaces magi-forgot.live.js. Note for live tests: a reused CDP tab keeps sessionStorage, and Guardian mirrors its flags there — clear both stores.
- Phase 4 DONE — A1-Priv: TradeHub (app + per-tab locks; React tab layer is a thin Guardian client), Insight (session hook to insight-api, no Remove), Vault (app lock; the vault's own PRF biometric helper moved verbatim to Vault/vault-bio.js — it is encryption, not a lock), RiftIQ (wr-prelock + deferred boot kept), Solace. Guardian gained: legacy reads of alDur cookies, a bio-id override for tab locks, and a queue so a second gate waits for the first card instead of dismissing it. Test infra: cdp.js answers status-many with "no locks" unless a test supplies one; tests/moved.js honours A1_PRIV. tests/live/guardian-priv.live.js replaces lock-bio-binding.live.js.
- Phase 5 DONE — ORCA (Desktop\ORCA, accounts, 4bd7c29, deployed): static/lock.js keeps the picker and loads Guardian with a backend over ORCA's /lock/* routes (server sessions + server-verified passkeys stay). Guardian gained: server-held unlock state for backends, per-backend biometric availability. Also (user ask): the show/hide eye on every password field is hardened for desktop + phone — 36px/44px target, never steals focus (keyboard stays up), keeps the caret; phone fields 16px (no iOS zoom); the card scrolls on short screens and respects safe areas. tests/live/guardian-orca.live.js.
- Phase 6 DONE — stale comments fixed (LifeHub usage, ORCA relay); README rewritten as the final contract (hosts table, features, API, version model, the dated legacy-retirement checklist); CLAUDE.md entry; memory notes; temporary worktrees removed. Legacy adoption deliberately KEPT until 2026-11-10 (devices that haven't opened a program since the switch still need it); its keys are not in cleanup-rules.json yet because live code still reads them. Final sweep: A1 70/70 suites, A1-Priv 13/13, worker 61/61, every Guardian live suite + 14 regression suites green (magi-usage-sync's live-usage chip check fails identically on pre-Guardian MAGI — engine data, not Guardian).
