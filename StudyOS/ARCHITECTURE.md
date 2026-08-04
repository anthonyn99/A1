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
| `window._vedaAddTask` / `_vedaUpdateTask` / `_vedaRemoveTask` / `_vedaTogTask` | yes | left as optional hooks (see §4) |
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

## 4. The one capability that could not come along

In the host page, StudyOS mirrored its dated tasks and events into a **separate
weekly TaskHub** living on the same page, through
`window._vedaAddTask / _vedaUpdateTask / _vedaRemoveTask / _vedaTogTask`.

Standalone StudyOS has no such sibling, so there is nothing to mirror into.
Every one of those calls was **already null-guarded** in the original, so they
are simply inert — no code changes were needed and nothing throws.

If V1 ever grows a weekly planner, define those four globals before StudyOS
boots and the mirror reconnects untouched. The contract is documented in
`config/config.js` §7.

**This is the only functional difference between the two builds.**

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
- the cross-app task-injection API and the `studyos_tasks` write-back in TaskHub's `tog()`
- stray `#study-root` CSS selectors

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

88 automated checks in headless Chrome against the standalone app, plus 23
against the modified host page. All passing, no uncaught errors.

| Suite | Checks | Covers |
|---|---:|---|
| App | 38 | boot, gate, CRUD, all six views, persistence across reload, IndexedDB, unconfigured-cloud guards, mobile 390px, desktop 1440px |
| App Lock | 31 | create, per-device unlock, gating a fresh device, wrong password, hint email, unlock, change password + version bump, old password rejected, remove lock |
| Recovery | 9 | reset-code request, bad code rejected, correct code, new password live, old password dead |
| Files | 10 | small upload/download, cloud-first blob resolution, 45 MB chunked upload with byte-integrity check, usage meter, delete |
| Host page | 23 | boots, React mounts, StudyOS fully absent, other apps still route, `sosPastel` intact |

TaskHub's edited `tog()` was additionally proven semantically identical to the
untouched Tony equivalent, including non-mutation and `_sos*` field preservation.

Not covered by automation, needs a real device: FCM delivery with the app
closed, WebAuthn biometrics, and genuine two-device sync.
