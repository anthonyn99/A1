# Notebook — the journals as one independent program (living plan)

> **This file is the hand-off between sessions.** Each phase is built in its own
> Claude Code session. A new session starts by reading **§0 Hand-off** and ends by
> rewriting it. Nothing needed to continue lives anywhere else.

---

## 0. Hand-off — read this first

**Last updated:** 2026-10-09. **Phases 0–5 are done.** Both journals are Notebook apps that
index.html mounts, with no journal code left in index. Notebook can also mount MyJournal
into any other program under its own key and store (an *instance*). The contract is
[README.md](README.md). The "before" state is still the git tag **`notebook-p0`**, and
every on-purpose difference is a rule in the baseline suite's `EXPECTED`.

**Next: Phase 6** (see §4): TradeHub's Playbook on a Notebook instance:
`Notebook.mount({app:'myjournal', key:'pb', store:'tradehub_playbook', container, title:'Playbook',
templates:['page'], pinned:[{id:'daily-reminder', title:'Daily Reminder'}], onSave})` plus
`window.NotebookFirebase = () => ({ db, fs })`. The live test
`tests/live/notebook-host.live.js` shows the whole shape on a throwaway host.

Method, as in Phases 2–4: one scripted, asserted step, then the baseline, then commit.
Write scratch scripts with the Write tool (bash heredocs mangle escapes, twice this
session), expect CRLF in some test files, and wrap every long command in `timeout`. The
baseline and the other live tests share one CDP browser (port 9333), so run them one at
a time.

Before starting any phase: `git pull`; run `node tests/run-all.js`; then
`node tests/live/notebook-baseline.live.js` (about 10 minutes; it must already
pass on a clean checkout, otherwise fix the harness first).

At the end of every phase: baseline suite passes, `node tests/run-all.js` passes,
commit + push, rewrite this §0.

---

## 1. What Tony asked for (2026-10-09)

- MyJournal out of index.html into its own folder, working like LifeHub: an
  independent program that has **no page of its own** and only runs when a
  program calls it. You can't open a notebook.html, but you can open it from
  TaskHub and TradeHub.
- Then he widened it: **Brainstorm Journal and OurJournal come out too**, as one
  program called **Notebook**. Veda's side gets reconnected so it looks unchanged.
- Each program that calls Notebook keeps **its own documents**, and every program
  gets the same features. A change to Notebook reaches every program at once.
- Tony's TaskHub keeps working exactly as now: memory, Firebase sync, everything.
- TaskHub settings: MyJournal is no longer an internal program. It shows as an
  external program but still opens inside TaskHub.
- **TradeHub's Playbook tab** (the tab keeps its name) becomes a MyJournal holding
  TradeHub's own documents. It covers the pinned **Daily Reminder** (keeps that
  title) and every other playbook page, converted to MyJournal pages. The Daily
  Reminder stays pinned at the top, can't be deleted, and keeps feeding the
  morning auto-launch.
- Adding Notebook to any future program must be easy, and OurJournal must be
  ready to be offered to other programs later.
- Fix bugs found along the way, including the identical ones in Brainstorm
  (Tony approved). Don't break anything. Never restyle Veda's side.

Answers Tony gave while planning:
- One shared engine: Brainstorm moves into Notebook as well.
- Fix the identical Brainstorm bugs.
- Keep the title "Daily Reminder".

## 2. Architecture

```
Notebook/
  notebook.js        loader + public API (window.Notebook), host contract, version stamp
  notebook.css       shared shell + DOCX CSS (still #tj-root/#bj-root scoped)
  core/fb.js         journal Firebase layer: write guards, upsert/retry, images, per-store
                     load/save/flush/order/delete/listen, _fbOJ/_fbViz adapters
  core/docx.js       the DOCX editor module (APPS registry → register())
  core/oj.js         OurJournal engine
  core/viz.js        VizEngine (whiteboard/mind map)
  core/jguard.js     JGuard + the journal touch-drag helper
  core/lock.js       entry lock UI/flow per lock namespace (tj / bj / pb)
  apps/myjournal.js  + .css   the tj app, parameterised by store
  apps/brainstorm.js + .css  the bj app, unchanged behaviour
```

| Host | App | key | Store (Firestore) | OurJournal |
|---|---|---|---|---|
| index.html, Tony | myjournal | tj | `dashboards/tony_journal` (unchanged) | yes |
| index.html, Veda | brainstorm | bj | `dashboards/journal` (unchanged) | yes |
| tradehub.html, Playbook | myjournal | pb | `dashboards/tradehub_playbook` (new) | no |

- **`key`** is the DOM/CSS/localStorage prefix, so tj and bj keep every id, rule and
  saved key they have today (`tony_journal_v3`, `docx_*_tj`, `tj_unlockedat_*`,
  `oj_cache_tj`, …). Nothing a device remembers is lost.
- **Loading.** Hosts load `Notebook/notebook.js?v=<hash>` as a classic
  **synchronous** script, placed where the journal code sits today. index.html's
  execution order stays identical, which matters because app-lock, NavOrder and the
  profile code call and wrap journal functions while the page parses. The `?v=`
  stamp (the same trick as dragsort.js, commit da5004d) beats GitHub Pages' 10-minute
  cache. `tools/notebook-stamp.js` rewrites every host's `?v=` from a hash of the
  folder, and a test fails when a stamp is stale.
- **Firebase.** Notebook borrows the host's app and Firestore: first
  `window.NotebookFirebase()`, otherwise the `[DEFAULT]`-app discovery LifeHub uses
  (`LifeHub/lifehub.js` openFirestore). Both hosts are on gstatic 12.12.0. Only with
  neither does it start its own app.
  - index.html keeps its own infrastructure, and Notebook takes it through a host
    adapter: `_freshGet`/`_fbIsServerSnap` (server-confirmed reads),
    `_fbWatchStall`/`_fbStopStall` (the stall popup), and `_a1b` (the A1Backup tap).
    Notebook has small fallbacks for hosts without them (TradeHub).
  - index's idle teardown (~13401, it resets `_tjServerSeen`/`_bjServerSeen`) calls
    `Notebook.hostTeardown()`.
- **Borrowed from the host if present, otherwise a fallback.** `uiAlert`/`uiConfirm`/
  `uiPrompt`/`uiForm`, `TNI` icons, `Bio` (biometrics hidden if absent),
  `_pwReset`/`_mailRelay` (forgot-password hidden if absent), `A1Drag`, `A1Resize`,
  React (boards only).
- **Standalone guard.** Nothing renders until a host calls `Notebook.mount()`.

### End state of index.html

After Phase 3 there is **no journal code in index.html**: no journal apps, DOCX,
OurJournal, VizEngine, JGuard, journal Firebase functions, or journal CSS/HTML. That
is roughly 23,000 of its 45,500 lines. What remains is the host side, about 40–60
lines:
- the script tag and two `Notebook.mount(...)` calls
- the nav buttons that open it (`showTonyJournal`, `showBrainstormJournal`, now
  calling `Notebook.show(key)`)
- settings and app-lock rows
- `_fbFlushAll` calling `Notebook.flushAll()`
- the teardown hook
- the host helpers TaskHub's own app lock also uses: `Bio`, `_pwReset`,
  `_mailRelay`, the modals and `TNI`

`tests/notebook-wiring.test.js` enforces this. It fails if a host defines
`_tjApplyRemote`, `_bjApplyRemote`, `window.OJ =`, `VizEngine`, `JGuard`, the DOCX
module, a `#tj-root`/`#bj-root` style rule, or a journal Firestore path. The
`hoverfx.js data-roots` list is host config and is allowed.

## 3. Cut list (index.html as of tag `notebook-p0`)

Line numbers drift as the file changes, so grep the identifier before cutting.

**Moves to Notebook (journal-owned):**

| Lines | What | Goes to |
|---|---|---|
| 105, 132, 136, 222, 226 | `#tj-root`/`#bj-root` rules in the global sheet (glow, fixed root, font) | notebook.css / app css |
| 5653–5741 | `.tji`/`.bji` icon sizing, bottom-bar width cap | app css |
| 10696–10727 | `_bj/_tjServerSeen` write guards + queues | core/fb.js |
| 11650–13034 | Firebase: Brainstorm block, `_fbWriteRetry`/`_fbUpsert` (journal-only), sanitize, image docs (`_jImg*`, `_compactImages`), `_fbViz`, `_fbOJ`, MyJournal block, AI prompt/tools docs | core/fb.js |
| 20451–20563 | `_attachJournalTouchDrag` | core/jguard.js |
| 20564–20902 | JGuard | core/jguard.js |
| 20903–22793 | VizEngine CSS + core + boards | core/viz.js (+css) |
| 22794–23759 | OurJournal `oj-css` + engine | core/oj.js |
| 23761–29493 | Brainstorm Journal CSS, `#bj-root` HTML, app IIFE, lock IIFE | apps/brainstorm.* (except `_pwReset`, below) |
| 29496–34798 | MyJournal CSS, `#tj-root` HTML, app IIFE, lock IIFE | apps/myjournal.* (except the TaskHub-owned parts, below) |
| 34804–35730 | `docx-css-tony`, `docx-css`, responsive CSS, journal shell CSS | notebook.css / apps |
| 35731–40357 | DOCX module | core/docx.js |
| 41227–41340 | `mjd-css` + MJDocsUI rail (OurJournal plugs into it) | apps/myjournal.* |
| 44861–44862 | `.vd-settings-gear` inside the journal roots | app css |

**Stays in index.html (TaskHub's own, currently inside journal scripts):**
- `_tonyNav`, `_updateTonyNavActive`, `_hideTonyNav`, `showTonyJournal`,
  `hideTonyJournal`, `tjSwitchTo` (in the MyJournal script, ~34145–34256)
- `window._fbFlushAll` (~33620). It is called by Brainstorm, both TaskHubs and
  pagehide (13497, 41487), so it becomes a host function calling
  `Notebook.flushAll()`.
- `window._pwReset` (inside Brainstorm's lock IIFE, ~28992). App-lock uses it at
  42593.
- `_a1SweepFirestore.ready` (13527) switches from `_tjServerSeen` to
  `_thServerSeen`. `tests/cleanup-rules.test.js:122` is updated.

**Host-side references into journal code** (each becomes a Notebook API call or
stays as host config):
- 6095, 6099: Tony's nav button / option `brainstormjournal`
- 14354–14364 (`_vedaNav`), 15864 (`showBrainstormJournal('veda')`)
- 17622–17663: the profile switch hides `bj-root`/`tj-root` and removes `tj-nav-title`
- 17836: `_tjApplyTheme`
- 41180: `_MODAL_OVERLAYS` lists `bj-lock-overlay`/`tj-lock-overlay`
- 42082–42084: `AL_APP_ROOTS`
- 42288: `alNavAppToId`
- 42342: `#bj-root` row check
- 42681–42690: the app-lock wrap of `showTonyJournal`
- 43785–43789: NavOrder `brainstormjournal`
- 44270: `['#bj-root','journal']`
- 45552: hoverfx `data-roots`

**Tests that grep index.html for journal code** (they follow the code into Notebook/):
- journal-images (`_tjExtractHtmlImages`)
- viz-board
- sync-guard (`_tjServerSeen`, `_bjServerSeen`)
- cleanup-rules (`_a1SweepFirestore`)
- archive-visibility (`_tjCompactImages`, `_tjStripEntry`)
- trash-purge-guard
- hoverfx-wiring
- backup-measure
- syntax-check `ROOT_SCRIPTS`
- `backup.js` 135/150 lists `tony_journal`; the path is unchanged, so it stays

## 4. Phases

### Phase 0 — Baseline and safety net ✅ 2026-10-09
- `tests/live/fake-firebase.js`: an in-memory Firestore served as the Firebase SDK
  (real merge/update/deleteField/metadata semantics, a write log, survives reloads,
  `__fakeFs.remote()` for "another device"). Reusable by any live test.
- `tests/live/notebook-baseline.live.js`: one scripted session per journal (Tony →
  MyJournal, Veda → Brainstorm), recorded from tag `notebook-p0` and from the
  working copy, then diffed. It records every Firestore write, every lock/AI worker
  request, the localStorage keys and caches, a per-step DOM/style snapshot, and 18
  byte-compared screenshots. The session covers:
  - open from the server, open an entry, edit and type, add a tag, search
  - new page, trash, restore, a remote rename
  - lock set (hint prompt), the lock re-showing on another device, wrong then
    right password
  - AI Format, OurJournal new page and leave
  - tablet and phone sizes, reload
- This plan, the cut list (§3) and a CLAUDE.md pointer.

### Phase 1 — Shared engines out, verbatim ✅ 2026-10-09
- Move DOCX (CSS + IIFE), OurJournal engine + `oj-css`, VizEngine + CSS, JGuard and
  the touch-drag helper into `Notebook/core/*` and `notebook.css`, byte for byte.
  `notebook.js` loads them synchronously at the same spot.
- Move `_fbOJ`/`_fbViz` into `core/fb.js` behind the host adapter.
- Turn the DOCX `APPS` registry into `register(app, cfg)`. tj and bj register exactly
  today's config. `_docxRebindImages` routes through the registry (it hardcodes
  `_bjBindImg`/`_tjBindImg` today).
- Add the stamp tool and a first `tests/notebook-wiring.test.js`. Update the
  index-grepping tests.

How it was built:
- **Loading.** `notebook.js` uses `document.write` while the page parses (a classic
  external script, same origin, so Chrome's write intervention does not apply). Its
  tags are therefore parsed next, blocking and in order, right where the old blocks
  were. After parsing, it appends ordered `async=false` elements instead.
  - Two groups: `core` loads by itself where the touch-drag helper sat (jguard.js,
    viz.css, viz.js, oj.css, oj.js, fb.js). `docx` loads where `docx-css-tony` sat,
    via `Notebook.load('docx')` (notebook.css, core/docx.js). That keeps every sheet's
    cascade position.
  - The four DOCX/shell `<style>` blocks became one `notebook.css`. Nothing referenced
    their ids.
- **Firestore accessors.** `_fbViz`/`_fbOJ` double as "Firebase ready" signals:
  VizEngine's `fbReady()` and OJ's `fb()` test whether they exist. So fb.js only
  defines `Notebook.fb.install(api)`, and index's Firebase `init()` calls it at the
  spot the accessors were built.
  - `db` is passed as a getter, because a teardown swaps `db` without re-running
    init(). The old closures saw the new one, and so must these.
- **DOCX registry.** `Notebook.docxApps` is core/docx.js's `APPS`. Each config gains
  `bindImg: '_tjBindImg'`/`'_bjBindImg'`, and both hardcoded binder pairs route
  through it (`_docxRebindImages` and `wireImageDelegation`).
  - An app registered after DOMContentLoaded initialises on arrival
    (`Notebook._docxInitApp`).
  - core/docx.js still has `app === 'tj'` branches: AI tools/prompt savers, sync
    setter, saved/error event names, the journal name, A1Resize and the rename target.
    Phase 4 moves them into the config.
- **Stamp.** `tools/notebook-stamp.js` hashes `Notebook/` into every host's `?v=`.
  `.githooks/pre-commit` re-stamps automatically when `Notebook/` is staged, and the
  wiring test fails on a stale stamp.
  - `syntax-check.js` parses every `Notebook/**/*.js`.
  - viz-board and undo-history now read `Notebook/`.
- **Harness fix.** Even on a clean checkout, the baseline's screenshots were not
  byte-repeatable: Veda's nav button borders drift up to 2 levels per channel on
  about 150 px between runs. Screenshots now match within ±2 per channel, the drift
  is printed as `near …`, and a real difference still fails (checked with a
  swapped shot).
- Verified: the baseline matches `notebook-p0` (writes, requests, storage, every step,
  20 shots, no new page errors). A headless smoke check covered the engines,
  accessors, registry and stylesheet order. Pages serves `Notebook/`.

### Phase 2 — Brainstorm Journal into `apps/brainstorm.js` ✅ 2026-10-09
- Move the bj CSS, HTML (the app builds `#bj-root` on mount), app IIFE and lock IIFE.
  `_pwReset` stays in index.
- Index mounts `{app:'brainstorm', key:'bj', store:'journal'}`. Paths and keys are
  unchanged, and the screenshots must be byte-identical.
- Identical bug fixes, approved by Tony:
  - locked-entry delete uses `BJ_AUTH` out of scope (~26214), so it always says
    "Network error"
  - change-password ignores the remove-lock result
  - set/remove/change skip `tlAuthPost`
  - native `prompt()` for Journal Entries links
  - attachment size guard and escaped file name, if the same code is present

How it was built:
- **Mount.** `Notebook.mount(cfg)` records the config under `Notebook.mounts[key]` and
  loads the app's GROUPS entry with `load()`, so during parsing it is written in place
  (stylesheet, then script) like the core group. `apps/brainstorm.js` first inserts
  `#bj-root`'s markup before its own <script> tag, then runs the old IIFE unchanged.
  `Notebook.registerDocx('bj', …)` moved to the end of brainstorm.js, so bj now
  registers before tj. That turned out harmless.
- **CSS.** The two bj `<style>` blocks became `apps/brainstorm.css`. The `.bji` icon-sizing
  block from index's icon sheet goes first in it (no property collides). The mixed
  selectors that also name other roots (lines 105/132/226, the 2000px cap, the settings
  gear) stay in index until Phase 3.
- **`_pwReset`** is now a small host `<script>` right after the mount.
- **Not moved: Brainstorm's Firestore block.** It shares `_fbWriteRetry`, `_fbUpsert`,
  the `_jImg*` image docs and `_compactImages` with MyJournal's, and its server-seen
  guard with the teardown and the sync-guard tests. Moving it alone would have split
  those helpers between two homes for one phase, so both blocks move together in Phase 3.
- **Fixes**, all in brainstorm.js:
  - The sidebar's locked delete called `blIsUnlocked` *and* `BJ_AUTH`, both inside the lock
    IIFE, so the click threw before asking anything. The lock code now hands out
    `_bjLock = { post, isUnlocked, errText }`.
  - set, remove and change go through `blAuthPost`.
  - Change-password is one `set-lock` with `current` (the worker verifies it), so there
    is no moment with no lock.
  - `_bjFileTooBig` refuses files over 650 KB with a clear dialog, in all three entry
    points (page chip, attach input, drop). The page file chip now escapes its name with
    `_bjEsc` (it only escaped `"`). Brainstorm had no native `prompt()`.
- **Baseline.** It gained `change-pw` and `locked-delete` steps (21, 22) at the very end
  of each journal's session, so a now-working delete changes no earlier step. Its three
  Phase 2 `EXPECTED` rules are the only differences from `notebook-p0`.
  - Harness fix: `diff()` stopped collecting after 60 differences, so differences past
    that point (the store, recorded last) passed unseen. It now collects all of them
    and caps only the printing.
- Other tests that read Brainstorm code now read `Notebook/apps/brainstorm.js` too
  (trash-purge-guard, viz-board). The wiring test checks the mount, the moved pieces
  and that `_pwReset` stays the host's.

### Phase 3 — MyJournal into `apps/myjournal.js` ✅ 2026-10-09
- Same move for tj, plus MJDocsUI. The TaskHub-owned functions in §3 stay in index.
- Both journals' Firestore blocks (§3 11650–13034, and the `_bj/_tjServerSeen` guards)
  move into `core/fb.js` (deferred from Phase 2), behind the host adapter.
- MyJournal bug fixes:
  - `TJ_AUTH` locked-delete (~31890)
  - change-password lock drop (34641)
  - `tlAuthPost` everywhere
  - passkey label "Trade Journal" → "MyJournal" (34405)
  - native `prompt()` (33298)
  - attachment size guard + escaped chip name (32575–32683)
  - PDF export using Veda's purple (34113)
  - sync pill says "Saved" before any save
- Dead code, removed per the delete-stale-comments rule: `fb-tj-canvas-saved`,
  `_fbRehydrateMyJournalImages`, the `#th-app-switcher`/`#tj-app-switcher` refs.
  `dashboards/myjournal` is already a cleanup-rules item.
- After this phase the "no journal code in index.html" test is switched on.

How it was built:
- **UI.** The same mount as Brainstorm: `{app:'myjournal', key:'tj', store:'tony_journal'}`.
  MJDocsUI (the sidebar rail) is appended to myjournal.js. Its CSS (`mjd-css`) goes last in
  notebook.css, because at 1100–1180px its `--sidebar-w: 300px` must still beat
  notebook.css's 224px. The `#tj-root{position:fixed…}` root rule and the `.tji` sizing
  open myjournal.css.
- **Host-owned, in index.** `_updateTonyNavActive`, `_hideTonyNav`, `_tonyNav`,
  `showTonyJournal`, `hideTonyJournal` and `tjSwitchTo` are one host `<script>` placed just
  *before* the mount (MJDocsUI wraps `showTonyJournal` while parsing; the app lock and theme
  wrap it later). `_fbFlushAll` and its pagehide/hidden listeners are host too, in the
  next script, and call `Notebook.flushAll()` (each mounted key's `_<key>PersistNow`). The
  multi-root rules (hover glow, fonts, the 2000px cap) are host config. The settings-gear
  padding fix went to each app's CSS, because it only beats that app's `* ` reset.
- **Firestore → core/fb.js, verbatim.** The module-level state (paths, timers, listener
  handles, own-save stamps, both stale-overwrite guards) is fb.js's top level, so it
  outlives a re-init as before. Everything init() built is `install(F)`, still called from
  init() where the accessor install was, with every SDK function and host helper in `F`
  (a parser-checked free-variable list: no free names remain in fb.js). `db` is a live
  getter (`doc(db(), …)`), as in Phase 1. `_fbWriteRetry`/`_fbUpsert` stay index's (the
  Plans mirror uses them) and are passed in. index's teardown calls
  `Notebook.fb.unsubscribe()` and `Notebook.fb.rearm()` at the lines that used to do it,
  and `_a1SweepFirestore.ready` reads `Notebook.fb.serverSeen('tj')` (unchanged meaning,
  rather than the plan's `_thServerSeen`).
- **Fixes** (myjournal.js): `_tjLock = { post, errText }` for the locked delete; set/remove/
  change through `tlAuthPost`; change-password is one `set-lock` with `current`; passkey
  rpName "MyJournal"; Journal Entries link uses `uiPrompt`; `_tjFileTooBig` (650 KB) on the
  page chip and the drop path, chip name through `_tjEsc`; the PDF prints in neutral ink;
  the sync pill's idle label says "Synced" until this session saves (`_tjSavedOnce`).
- **Dead code removed:** `fb-tj-canvas-saved` (and bj's twin), `_fbRehydrateMyJournalImages`
  (no caller; backup.js still backs up `dashboards/myjournal`), every
  `th-app-switcher`/`tj-app-switcher` ref in index (vault.html still has its own).
- **Baseline:** the tj lock steps, the trash and the pill label are Phase 3 `EXPECTED` rules.
  Screenshots tj-open, tj-reload and tj-locked-again differ only by the pill.

Each bug fix changes behaviour on purpose. The baseline comparison then shows
exactly that difference and nothing else. The phase records each expected
difference in this file and adds a rule to the suite's `EXPECTED` list for it.

### Phase 4 — Host-agnostic ("add Notebook to any program") ✅ 2026-10-09
- Parameterise from `store`/`key`: the Firestore doc and `_img_`/`_viz_` prefixes,
  the localStorage prefix, the lock namespace (the taskhub-reminders worker accepts
  any `journal` string via `jKey`), and the AI profile.
- Add `mode:'inline'` beside `'overlay'`.
- Add `features` (ourjournal, boards, locks), `pinned` entries (top, undeletable,
  untrashable, not draggable, not lockable), and the `onSave`/`onReady` hooks.
- Add host Firebase borrowing with an own-app fallback, plus the helper fallbacks.
- Add `tests/live/notebook-host.live.js`: a throwaway host with store `nb_test`
  that gets its own documents and the same features.
- Write `docs/Notebook/README.md`, the contract (counterpart of
  docs/LifeHub/README.md). It covers adding Notebook to a program, the data
  layout, the Firebase cost table, and turning OurJournal on for another host.

How it was built:
- **An instance is MyJournal's own source, rewritten.** `Notebook.mount` with a key other
  than the app's native one (tj) fetches `apps/myjournal.js/.css` and rewrites the
  prefixes: `tj`→key, `TJ`→KEY, `Tony…`→`Key…`, `tony_journal`→store, `myjournal_ai`→`<store>_ai`,
  `MyJournal`→title. It routes DOMContentLoaded and `fb-ready` to the instance's own
  signals and runs the result as an inline script inside the host's container (the app
  builds its markup right before its own script element). One source, so every MyJournal
  change reaches every instance. This was chosen over parameterising 4,000 lines of
  `tj-` ids by hand, which would have risked tj's byte-identity.
- **Its Firestore layer** is made the same way from core/fb.js. Comment markers
  (`@nb-store`, `@nb-shared`) bracket tj's state, guards and install block and the helpers
  it shares with bj. `storeSource()` joins them into one self-contained store
  `{install, unsubscribe, rearm, serverSeen}`, added with `Notebook.fb.addStore`. The host
  hands over `window.NotebookFirebase() → {db, fs}`, and `hostF()` builds the rest of F
  (retrying writes, upsert, server-confirmed reads, no-op stall/backup taps).
- **CSS:** the instance gets myjournal.css plus only the rules of notebook.css that name
  tj (`tjRules()`, @media kept), rewritten. Unscoped rules are never repeated over the
  host's. `instanceCss()` makes it inline, hides locks, hides template cards not in
  `templates`, and hides forgot-password when the host has no `_pwReset`.
- **Index unchanged, refactors under the baseline:** TNI → root `tni.js` (index loads it at
  the same spot), `_mdToHtml`/`_renderMdTables` → `core/md.js` (they sat in brainstorm.js
  though MyJournal uses them), core/docx.js's `app === 'tj'` branches → by key
  (`_<key>SetSync`, `_fbSave<KEY>Tools`, `fb-<key>-…`) and the config's `name`/`side`.
- **myjournal.js reads its mount config:** `features` (ourjournal, locks), `pinned` (kept
  first, created empty with `updated: 0`, never deleted/purged/dragged/locked, no date
  until saved), `onSave(entry)` and `onReady()`. With index's config, every path is
  unchanged.
- Not done: `mode:'overlay'` for an instance is accepted but untested; OurJournal for
  another host stays off (it is wired to tj/bj); boards in an instance are untested,
  so the Playbook offers only pages.
- Tests: `tests/notebook-instance.test.js` (rewrite leaves nothing of tj, parses, store
  touches only its own docs) and `tests/live/notebook-host.live.js` (21 checks on a
  throwaway host, fixture `tests/live/fixtures/notebook-host.html`, which the stamp tool
  also re-stamps).

### Phase 5 — TaskHub: MyJournal becomes an external program ✅ 2026-10-09
- Take `brainstormjournal` out of `TONY_DEFAULT` and Internal Programs.
- Add a MyJournal row to `LEGACY_PROGRAMS` with its icon and
  `lockId:'tony_myjournal'`. Its open action calls `showTonyJournal()` (in-page),
  never `_tnOpenTab`.
- Migrate saved `dashboards/navorder` in one guarded write, keeping order and
  visibility.
- App-lock wiring is kept. Veda's settings are unchanged.
- Add a live test.

How it was built:
- `brainstormjournal` left `TONY_DEFAULT`/`TONY_SELECT_LABELS`, and the static header button
  and select option went. LEGACY_PROGRAMS gained
  `{id:'myjournal', lockId:'tony_myjournal', openFn:'_myjournalClick'}`, and
  `_myjournalClick` → `_tonyNav('brainstormjournal')`: the same in-page, app-lock-gated path
  the old button took. The in-page app id stays `brainstormjournal` (app lock, theme and nav
  wrappers key off it). `_updateTonyNavActive` and the dropdown light `custom:myjournal` for it.
- **Migration** (in NavOrder's `applyRemote`): a saved `tony` order that still lists
  `brainstormjournal` gets the MyJournal link (if the cloud has none) in that same slot,
  pushed once through the guarded `saveNavOrder`. An order without it is left alone, so
  deleting the link sticks. A per-device local pre-seed (`nb_myjournal_link`) puts the
  button up before Firebase answers.
- Settings lists it under External Links with its existing lock. `_navIsLegacyLockId`
  keeps it out of Internal Programs. Veda's side is untouched.
- Fixed on the way: picking an External Link in the mobile select called
  `_tonyNav('custom:…')` and blanked the page; it now opens through `_navOpenLink`.
- Tests: `tests/live/myjournal-external.live.js` (17 checks: one-write migration in place,
  opens in-page and lights up, Settings, idempotent, delete sticks). `index-drag.live.js`
  follows the new button. The baseline gained two rule kinds: `shots` + `rows` (differences
  allowed only in those rows, here the header) and `check(before, after)` (here: exactly
  one new local key).

### Phase 6 — TradeHub Playbook on Notebook
- **Mount:** in `TBPlaybookPage` (~9846), add a host `<div>` whose `useEffect`
  calls `Notebook.mount({app:'myjournal', key:'pb', store:'tradehub_playbook',
  mode:'inline', features:{ourjournal:false}, pinned:[Daily Reminder]})`.
  `TBTabGate` and the nav entry stay.
- **Migration:** with the store empty, read `dashboards/tradeboard_playbook`
  (falling back to `tb_playbook_v1`). Each page becomes a `template:'page'` entry
  (`data.html = tbSanitizeHtml(body)`) with the same id, so the Daily Reminder keeps
  `daily-reminder`. Trashed pages keep their stamp. This happens in one
  transaction with a `_migratedFrom` marker. The old doc is left as a backup.
- **Daily Reminder push:** `onSave` → `tbHtmlToMd` → POST `/daily-reminder`, keeping
  the existing debounce and signature dedupe (~10372–10394). `tbHtmlToMd` learns
  math (`$…$`), and images and file chips become placeholders.
- **Remove** the old Playbook code:
  - the editor, toolbar, menus, persistence and listener
  - its Trash-can section
  - its CSS
  - `_fbLoad/SaveTBPlaybook`
  - the onSnapshot at ~1172
  Add `tb_playbook_v1` to `cleanup-rules.json` with `"delete": false`.
- **Bugs:**
  - gate POST `/daily-reminder` with App Check in
    `workers2/trade-dashboard/worker.js`; GET stays open for launch.py
  - launch.py: handle `~~strike~~`, and stop treating snake_case as italic (1707)
- Add `tests/live/tradehub-playbook.live.js`.

### Phase 7 — Wrap-up
- Run every suite, both profiles, and TradeHub mobile-fit.
- Update the memory notes (myjournal-docx-editor, ourjournal,
  journal-localstorage-quota) and add a `notebook` memory.

## 5. Verifying a phase

- `node tests/run-all.js` and `node tests/syntax-check.js`.
- `node tests/live/notebook-baseline.live.js`. It compares against tag `notebook-p0`;
  `--ref <ref>` compares against anything else. Exit 0 means the writes, requests,
  storage and every step snapshot match, and every screenshot matches within ±2 per
  channel (headless Chrome drift, see Phase 1). Shots and recordings are in
  `%TEMP%\magi-live-shots\nb-*`.
  `... compare before after` re-diffs two existing recordings without recording again.
- `node tests/notebook-wiring.test.js` (part of run-all) checks the stamp, the loader
  and that moved code lives in `Notebook/` exactly once.
- The `/verify` skill before each commit.
- Never mutate source in place to prove a test can fail; monkeypatch instead.

## 6. Bugs found, by phase

| Where | Bug | Phase |
|---|---|---|
| MyJournal + Brainstorm | Deleting a locked entry always fails: `TJ_AUTH`/`BJ_AUTH` only exist inside the lock IIFE, so the ReferenceError reads as "Network error" | 3 / 2 |
| MyJournal + Brainstorm | Change password: remove-lock result unchecked, so a failed set-lock leaves the entry unprotected | 3 / 2 |
| MyJournal | Passkey prompt says "Trade Journal" | 3 |
| MyJournal | Journal Entries link button uses the native `prompt()` | 3 |
| MyJournal | No attachment size limit; an oversize chip blocks the whole entry's sync with no clear cause; chip name not `<`-escaped | 3 |
| MyJournal | PDF export uses Veda's purple palette | 3 |
| MyJournal | Sync pill says "Saved" before anything was saved | 3 |
| TradeHub Playbook | Remote edits dropped within 8 s of a local save; focused editor writes stale DOM back on blur; whole-doc overwrite | 6 (replaced) |
| TradeHub Playbook | Every blur writes even with no change; storage % banner wrong; link URL with `"` throws | 6 (replaced) |
| trade-dashboard worker | POST `/daily-reminder` has no App Check, so anyone can rewrite the morning text | 6 |
| launch.py | `~~strike~~` not rendered; snake_case italicised | 6 |
