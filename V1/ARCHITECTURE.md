# StudyOS — architecture & extraction record

What StudyOS was inside the host page, every dependency that tied it there, and
what each one became once it was pulled out. This is the Phase 1 analysis plus
the record of what the extraction actually did.

---

## 1. Where it lived

StudyOS occupied **5,122 contiguous lines** of the host `index.html`
(lines 29,201–34,322 of 39,300), in three adjacent blocks:

| Block | Lines | Size |
|---|---|---|
| `<style id="study-root-css">` | 29,202–30,281 | 1,080 |
| `<div id="study-root">` markup | 30,283–30,909 | 627 |
| `<script id="study-root-js">` | 30,911–34,321 | 3,411 |

Everything else it needed was scattered across the rest of the file — that
scattering is what made this an extraction rather than a copy.

---

## 2. Dependency map

### 2.1 Firebase / Firestore

| Host symbol | Where | Role |
|---|---|---|
| `SOS_DOC_PATH` | line 5,498 | `dashboards/studyos` |
| `_sosSaveTimer`, `_sosUnsubscribe`, `_sosLastOwnSaveAt` | 5,512 / 5,524 / 5,542 | debounce + listener + echo-window state |
| `_sosServerSeen`, `_sosPendingWrites`, `_sosMarkServerSeen`, `_sosWhenServerSeen` | 5,590–5,601 | stale-overwrite guard |
| `window._fbLoadStudyOs` / `_fbSaveStudyOs` | 6,827 / 6,865 | load + debounced guarded write |
| `onSnapshot` listener + held-snapshot replay | 6,802–6,826 | live cross-device updates |
| `_guardedWrite`, `_freshGet` | 5,431 / 5,469 | shared write guard + fresh read |
| `window._fbReady`, `fb-ready` event | module-wide | boot ordering |
| events `fb-sos-remote` / `-synced` / `-saved` / `-error` | — | app ↔ sync channel |

All of it shared one `<script type="module">` with **twelve other apps**
(TaskHub, EventRec, journals, MotionCore, ProView, Keychain, …), one Firebase
app instance and one Firestore cache.

### 2.2 Cloudflare

| Dependency | Detail |
|---|---|
| `studyos-files` Worker | origin hardcoded at line 32,158 — now `config.cloudflare.filesWorker.baseUrl` |
| reminders Worker | App Lock hashes (KV namespace `applock`) + the reminder cron, shared with every other app — now the dedicated `studyos-api` Worker |

File **blobs** live in Workers KV, never Firebase — Firebase Storage needs the
paid Blaze plan. Firestore holds only `{name, size, mime, storageUrl}`.

### 2.3 Host globals StudyOS called

| Global | Guarded? | Fate |
|---|---|---|
| `window.uiConfirm` | **no** — awaited directly | ported → `js/ui.js` |
| `window.thScheduleNotif` / `thCancelNotif` | yes | rewritten → `js/push.js` |
| `window.sosPastel` | yes | moved into `js/studyos.js` |
| `window._vedaAddTask` / `_vedaUpdateTask` / `_vedaRemoveTask` / `_vedaTogTask` | yes | rebuilt on Firestore → `js/taskmirror.js` (see §4) |
| `window._vdCurApp`, `_navOrderModule`, `_navRecheckOverflow` | yes | host nav chrome — dropped |
| `window._fbLoadStudyOs` / `_fbSaveStudyOs` / `_fbReady` | mixed | → `js/firebase-sync.js` |

### 2.4 Host globals StudyOS published

`_sosRoot`, `_sosRenderCalendar`, `studyOsInit`, `studyOsOpen`, `studyOsClose`,
`sosRefreshStorage`, `sosSyncAllToCloud`, `sosUpdateCloudBadge`,
`sosCloudSyncClick`, `sosPastel`.

Of these, only `_sosRenderCalendar` was consumed by the host — from TaskHub's
`tog()`, to mirror a checkbox back into StudyOS. That call is gone.

### 2.5 App Lock

StudyOS was one entry (`veda_study`) in a **14-app** lock registry:
`AL_LABELS` (37,013), `AL_APP_ROOTS` (37,210), `alNavAppToId` (37,407),
`alUpdateVedaLockBtns` (37,437), plus a header button in the markup.

Backed by the shared reminders Worker's KV (`journal='applock'`,
`entryId='veda_study'`), with lock state synced through `dashboards/applock` and
hints emailed via a Formspree form belonging to the original project. All three
are replaced by Veda's own in the standalone build — no original account value
survives anywhere in this folder.

### 2.6 Shell / CSS / navigation

- `.veda-hdr-*` header classes — defined at lines 172–184, shared with five apps
- `--suite-display`, `--font-accent` — root typography tokens (line 61–62)
- Fonts: Lora, Nunito, Inter, Manrope, IBM Plex Mono, Playfair Display, Fraunces
- `#study-root` appeared in the body-font selector (150), a `#bj-root` reset
  (13,311), the drag guard (37,460), the nav hide list (8,450), the profile
  overlay (10,599), and `VEDA_ROOT_APP` (33,017)
- Routing: `_vedaNav('study')` → `studyOsOpen()`, plus five header buttons

### 2.7 Initialization flow (original)

```
host boots → profile routing → _vedaNav('study') → studyOsOpen()
  → hide #veda-root, show #study-root, claim nav state
  → first time only: studyOsInit()
      → _sosRoot = #study-root
      → init()             render everything from localStorage
      → sosInitFirebase()  load remote, subscribe, wire save events
```

StudyOS was **lazily** initialized — it did nothing until the host navigated to
it.

---

## 3. What the standalone build does differently

| Concern | Host build | Standalone |
|---|---|---|
| Boot | lazy, host-triggered | self-boots on `DOMContentLoaded`, gated on `SOS_GATE` |
| Config | hardcoded throughout | `config/config.js`, single source |
| Firebase | shared module, 13 apps | own module, one document |
| App Lock | 1 of 14 apps in a registry | one lock gating the whole page |
| Reminders | TaskHub's scanner (`td6_data`) | own registry + FCM |
| Header | 7 sibling-app buttons | title + lock, siblings from config |
| Unconfigured | n/a | every cloud feature dormant, app still fully usable |

### Boot gate

`js/applock.js` publishes `window.SOS_GATE`, a promise `js/studyos.js` waits on
before rendering. `body[data-sos-gate]` drives CSS that hides `#study-root`
while the value is `pending` or `locked`, so a locked StudyOS cannot flash its
data before the overlay paints. With the lock off or unconfigured the promise is
already resolved and boot is straight-through.

### The app body is verbatim

`js/studyos.js` is the original 3,411-line script with edits **only** at the
boundaries: the worker URL now comes from config, `sosPastel` is defined
locally, and the host-shell boot block is replaced. Every render function, every
persist call, every guard is unchanged — behaviour is identical by construction.

---

## 4. The task mirror — the one thing that needed a new transport

In the host page, StudyOS mirrored its dated tasks and events into Veda's
**weekly TaskHub** through four in-page globals
(`_vedaAddTask` / `_vedaUpdateTask` / `_vedaRemoveTask` / `_vedaTogTask`).

Those worked only because both apps lived in **one document**. StudyOS now ships
in a separate deployment, where a JS global call across pages is physically
impossible. The requirement survived — StudyOS must still feed TaskHub — so the
transport was rebuilt on **shared Firestore**.

### Two documents, exactly one writer each

| Document | Writer | Reader | Carries |
|---|---|---|---|
| `dashboards/studyos_mirror` | StudyOS | TaskHub | every dated StudyOS task/event |
| `dashboards/studyos_mirror_ack` | TaskHub | StudyOS | done-state flips |

The single-writer split is the core safety property. TaskHub persists its state
with a **whole-document** `setDoc()`; a shared writable document would make every
concurrent edit a last-writer-wins race, silently destroying habits, goals, or
the other side's same-day tasks. With one writer each, neither app can corrupt
the other no matter how the writes interleave.

Both apps must therefore reach the same Firestore database — Firestore cannot
read across projects. **StudyOS is explicitly pointed at the Index project**
(`task-dashboard-d2b53`), which also means its own data keeps living at the
`dashboards/studyos` document it already uses, so the move strands nothing.
`config/config.js` §7 keeps an escape hatch (`taskMirror.firebase`) that would
open a second named connection if StudyOS were ever split onto its own project.

Two consequences of sharing the project, both handled:

- **Reminder collections are namespaced.** Index runs its own cron over
  `reminders` / `fcm_tokens`. StudyOS uses `studyos_reminders` /
  `studyos_fcm_tokens`, because two crons sweeping one collection means
  duplicate notifications and a race on the delete.
- **App Check is enforced on this project.** StudyOS now registers reCAPTCHA v3
  with Index's site key, exactly as `index.html` does. The key is
  domain-restricted, so V1's host must be added to its allowlist — the one
  migration step that cannot be done from code. Verified: from an
  un-allowlisted origin, StudyOS and `index.html` fail identically
  (`appCheck/recaptcha-error` → `permission-denied`).
- **No Firestore rules ship with this project.** The Index project's rules cover
  every path StudyOS uses, and publishing a StudyOS-specific ruleset there would
  delete the rules protecting a dozen other apps.

### Derived, not incremental

The mirror is **rebuilt in full** from `tasks` + `events` + `classes` on every
change, rather than being mutated by the four legacy calls. That is a deliberate
upgrade over the original: an incremental stream drifts permanently the moment
one call is missed — a crash mid-edit, an edit made while offline, a call fired
before the module finished loading. A derived mirror is idempotent, so any write
reconciles the entire set.

The four globals are still defined (as one-line "mark dirty" triggers) because
`js/studyos.js` calls them throughout and they are its only signal that dated
data changed. **That is why `studyos.js` required no edits for any of this.**

It also fixed a latent bug: repeating *events* used to be mirrored under a
freshly minted `uid()` that matched no stored event, so a done-tick could never
be routed back. Deriving from source means every item carries its real id.

### Reconcile on the TaskHub side

TaskHub treats the mirror as the sole source of truth for anything tagged
`_sosId`: it strips all such items and re-adds from the mirror. Anything the
mirror no longer lists was deleted in StudyOS and disappears — which is what
`_vedaRemoveTask` used to do. Veda's own tasks carry no `_sosId` and are never
touched. Both sides skip the write entirely when nothing changed; without that,
each app's save would re-trigger the other's listener and they would ping-pong
forever.

### What the bridge is for

`classes`, `events` and `tasks` are top-level `let` bindings in a classic
script — they live in the global *lexical* scope and are **not** reachable as
`window.tasks`. `window._sosBridge`, defined at the end of `studyos.js`, is the
only supported way in and out: three getters plus `setTaskDone`, the return path
for acks.

**Functional parity with the original build is complete.**

---

## 5. Behaviours that must not be "simplified"

Each of these looks redundant and is a fixed bug.

1. **Stale-overwrite guard** — a session may not write until it has confirmed
   real server state once. Without it, a refresh that fell back to the offline
   cache rendered the OLD class list and the next edit wrote it back over newer
   server data, permanently deleting files uploaded on another device. Writes
   are queued, never dropped, and coalesced to the latest payload.

2. **Held-snapshot replay** — snapshots arriving inside the own-save echo window
   are held and re-applied, not dropped. `onSnapshot` only re-fires on the *next*
   change, so dropping one meant a genuine update from another device could be
   lost for good.

3. **Client-side size guard (900 KB)** — Firestore rejects documents over 1 MiB,
   and a rejected write wedges the sync queue for the whole app. Refusing early
   gives a clear warning instead.

4. **Single-tab Firestore cache on iOS** — the multi-tab manager elects a leader
   through an IndexedDB lease that iOS never releases when it kills a
   backgrounded PWA, so the next cold launch hangs waiting for it to expire.

5. **Monotonic unlock comparison** — the per-device unlock marker is compared
   `>=`, not `==`. Lock versions replicate through Firestore, so a device can
   briefly see a stale, missing or zero version; exact matching treated every one
   of those as "password changed → re-prompt".

6. **Chunked uploads** — a single KV value caps at 25 MB. Files above that are
   split client-side and described by a manifest written **last**, so
   `GET /f/<key>` 404s rather than serving a half-uploaded file.

7. **Data-only FCM messages** — no `notification` block, so the service worker's
   `onBackgroundMessage` runs for every message and draws it with a unique tag.
   Otherwise the browser's auto-display path can collapse two reminders that fire
   in the same minute.

---

## 6. What was removed from the host page

23 scripted edits plus follow-ups. **5,279 lines and 282 KB removed**
(39,300 → 34,021 lines; 2,237 KB → 1,955 KB):

- the 5,122-line StudyOS block
- the Firestore sync layer: doc path, timers, listener, load/save, stale-write guard
- nav routing (`_vedaNav('study')`), the hide list entry, `VEDA_ROOT_APP`
- five "Study" header buttons (3 HTML, 2 React)
- App Lock registry entries: `AL_LABELS`, `AL_APP_ROOTS`, `alNavAppToId`, `alUpdateVedaLockBtns`
- the NavOrder default entry
- the in-page cross-app task-injection API and the `studyos_tasks` write-back in TaskHub's `tog()`
- stray `#study-root` CSS selectors

### Added back to the host page

The cross-app link had to survive the split, so the host page gained a
Firestore-based receiver in place of the in-page API it lost:

- a read-only `dashboards/studyos_mirror` listener + `window._fbSaveSosAck`
  writer in the Firebase module
- a reconcile effect in Veda's TaskHub component that merges mirrored items into
  the weekly grid and removes ones the mirror has dropped
- an ack write in `tog()`, so ticking a mirrored task checks it off in StudyOS

This is strictly less coupling than before: the host page no longer knows
anything about StudyOS's internals, only about a document shape.

### Deliberately kept

`sosPastel` and the `SOS_PASTEL_MAP` at line 3,233, plus the `_sosClassName` /
`_sosClassColor` chip rendering in Veda's TaskHub.

These render **her existing task data** — tasks previously created from StudyOS
still carry those fields, and the badge colors are mapped through `sosPastel`.
Deleting it would blank badges on tasks she already has. Nothing writes those
fields any more; this is read-only support for pre-split data, not a live
StudyOS dependency. The comment at line 3,233 says so.

---

## 7. Verification performed

141 automated checks in headless Chrome. All passing, no uncaught errors.

| Suite | Checks | Covers |
|---|---:|---|
| App | 38 | boot, gate, CRUD, all six views, persistence across reload, IndexedDB, unconfigured-cloud guards, mobile 390px, desktop 1440px |
| App Lock | 31 | create, per-device unlock, gating a fresh device, wrong password, hint email, unlock, change password + version bump, old password rejected, remove lock |
| Recovery | 9 | reset-code request, bad code rejected, correct code, new password live, old password dead |
| Files | 10 | small upload/download, cloud-first blob resolution, 45 MB chunked upload with byte-integrity check, usage meter, delete |
| Task mirror | 30 | item derivation (task/event shape, zero-padded date keys, class badges, repeat ids, undated tasks excluded), deletion propagation, `setTaskDone` ack path, TaskHub reconcile, removal of dropped items, Veda's own tasks untouched, idempotence on a repeated payload |
| Host page | 23 | boots, React mounts, StudyOS fully absent, other apps still route, `sosPastel` intact |

TaskHub's edited `tog()` was additionally proven semantically identical to the
untouched Tony equivalent, including non-mutation and `_sos*` field preservation.

Not covered by automation, needs a real device or live Firestore: FCM delivery
with the app closed, WebAuthn biometrics, genuine two-device sync, and the mirror
running over a real Firestore connection rather than injected snapshots.

---

## 8. Brightspace import (`js/d2l-sync.js`, `workers/studyos-d2l/`)

Added after the extraction. Pulls the student's D2L calendar into `classes` /
`events` / `tasks` so assignment due dates do not have to be retyped.

### Scope, and why it is this small

**The calendar ICS feed is the only D2L data a student can reach.** Everything
else in Brightspace — grades, announcements, course files, content modules —
is behind the Valence API, which requires an OAuth client that a Brightspace
**administrator** registers. There is no student-side workaround.

So this integration imports courses, assignments and calendar events, and
nothing else. Grades and announcements would additionally need data models that
do not exist here at all: `event.weight` is an input to the priority score
(`_sosPriorityScore`, js/studyos.js), not an earned score, and there is no
announcements concept anywhere.

> **Do not implement the missing pieces by scraping Brightspace HTML with the
> user's session cookie.** It breaks on every Brightspace release, and it
> violates most institutions' acceptable-use policies. If credentials ever
> arrive, add Valence endpoints to the existing worker behind the same config
> gate.

### Why `js/studyos.js` was edited, given §3

§3 says the app body is verbatim, edits only at the boundaries. This feature
needed one boundary edit, because there was no way in.

`_sosBridge` exposed only readers plus `setTaskDone`. Its getters return live
array references, so a consumer *can* mutate them — but that path is a dead
end: nothing calls `persistEvents()` / `persistTasks_()`, so the change reaches
neither localStorage nor Firestore; every render function is lexically scoped
and unreachable; and the next `fb-sos-remote` assigns `events = remote.events`
and discards it.

The edit is therefore a **second sanctioned bridge extension**, mirroring
`setTaskDone` exactly:

- `_sosBridge.applyD2L(payload)` — a dumb, total setter. The caller hands over
  finished arrays; this assigns, persists and repaints. It knows nothing about
  D2L. All reconciliation lives in `js/d2l-sync.js`.
- `_sosBridge.getD2LMap()` — reads the course→class mapping.
- `d2lMap` state, `d2l` added to the save payload, and `remote.d2l` restored in
  **both** merge sites (the initial load and the live listener — missing the
  second means the mapping never propagates between devices).

No render function and no §5 behaviour was touched.

### Behaviours that must not be "simplified" (extends §5)

**8. `done` is learned from a LOCAL save, never from a remote replace.**
`js/d2l-sync.js` keeps a module-scope Map of `d2lKey → done` because
`tasks = remote.tasks` would otherwise discard every tick on an imported item —
the same hazard `_sosCloudUrls` solves for file URLs. The subtlety, and a bug
that was actually hit during development: a first cut re-read `done` from the
array on every reconcile, so the replace overwrote the very value the Map was
holding. Hence two learners —
`learnDone()` on `fb-sos-saved` (a local write; the array is freshest) and
`learnNewKeysOnly()` on `fb-sos-remote` (another device's flags may be older
than a tick made here). Collapsing them back into one re-introduces the bug.
`scripts/test-d2l-client.mjs` pins this.

**9. An empty feed must never delete anything.** An expired Brightspace link
returns an **HTML login page**, not an HTTP error. It parses to zero events,
which reconciles to "D2L deleted the whole semester". Two guards: the worker
refuses a `/feed/set` that yields zero events, and `reconcile`/`guard` refuse to
apply when incoming is empty but imported items exist. A removal of more than
half the imported items additionally asks for confirmation.

**10. Imported items keep their `id` across syncs.** `js/taskmirror.js` mirrors
tasks into TaskHub keyed on `id`. Minting a fresh one each sync would spawn a
duplicate TaskHub row every time and orphan the previous one. `reconcile` reuses
`prior.id` whenever `_d2l.k` matches.

**11. D2L wins only over its own fields.** Title and date come from Brightspace;
`done`, `weight`, `priority`, `notif` and `notes` are StudyOS's and must survive
every sync. Brightspace cannot supply them, so overwriting them is pure loss.

**12. UTC conversion happens in the browser, not the worker.** Workers run in
UTC and cannot know where the student is. `ics.js` returns the raw parts plus
`isUtc`/`tzid`; `localizeTime()` in the client finishes the job. A floating
`TZID` time is already the course's local wall clock and is left alone.

### Capacity

D2L items land in `dashboards/studyos`, which has a 900 KB soft ceiling
(`config/config.js`) whose breach wedges the sync queue for the whole app. Three
mitigations: the worker hashes each ICS UID to 16 chars (a raw UID is ~70), only
`{k, at}` is persisted per item, and the import window defaults to −30/+210 days.
The preview panel shows the projected size before applying, and refuses over
600 KB. A semester of five courses lands around 150 KB.

### Testing

```
npm run test:d2l           # parser (28) + client reconcile (22)
```

Both suites are pure node — `ics.js` and `classify.js` deliberately use no
Workers APIs, and the client tests run `d2l-sync.js` in a `vm` sandbox with a
fake DOM. The tenant-specific course-name format in `classify.js` is the part
most likely to need re-tuning against a real feed; `/feed/set` reports the
detected courses so that can be checked before any data is imported.
