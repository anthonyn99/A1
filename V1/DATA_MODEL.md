# StudyOS — Data Model

Status: **v1 (as-built)**. This documents the shapes that exist in source *today*,
before any upgrade-spec feature work. Every field below was read out of
`js/studyos.js` / `js/firebase-sync.js`, not inferred.

Ticket F-1. Written before any schema change, per the spec's rule 4.

---

## 1. Where the source actually lives

The upgrade spec refers to `js/studyos.js` and `config/config.js` at the repo
root. In this repo those paths are:

| Spec path | Real path |
|---|---|
| `js/studyos.js` | `V1/js/studyos.js` |
| `config/config.js` | `V1/config/config.js` |
| the served app | `V1/studyos.html` |
| build output (generated) | `V1/dist/studyos/` |

`V1/dist/` is **generated** by `node scripts/build.mjs` and is wiped on every
build (`rmSync(dist, …)`). Never edit anything under `dist/` — the change will
be silently destroyed on the next build. All work happens in `V1/js/`,
`V1/css/`, `V1/config/`, and `V1/studyos.html`.

Line counts confirm the spec's audit is otherwise accurate:
`studyos.js` 4,764 · `docx-engine.js` 3,473 · `notes-sync.js` 932 ·
`d2l-sync.js` 679 · `firebase-sync.js` 481 · `taskmirror.js` 322.

---

## 2. Storage layers

Three layers hold state. They are not interchangeable.

### 2.1 localStorage — the working set

| Key | Holds | Loaded at |
|---|---|---|
| `studyos_classes` | `Class[]` incl. nested modules and file metadata | `studyos.js:116` |
| `studyos_events` | `Event[]` | `studyos.js:119` |
| `studyos_tasks` | `Task[]` | `studyos.js:120` |
| `studyos_notes_v2` | `Note[]` | `studyos.js:121` |
| `studyos_d2l` | `D2LMap` (object or `null`) | `studyos.js:125` |
| `studyos_ksu` | `{ modules: Module[] }` | `studyos.js:256` |

All six are read synchronously at module top level with
`JSON.parse(localStorage.getItem(k) || '<default>')`. A corrupt value throws
during script evaluation and takes the whole app down — there is no try/catch.
**Any migration runner must therefore parse defensively.**

### 2.2 IndexedDB — file blobs

Two separate databases:

| DB | Store | keyPath | Purpose |
|---|---|---|---|
| `sos_file_store` (v1) | `files` | `id` | Uploaded document blobs (`studyos.js:1561`) |
| `sos_stage` | `pending` | `id` | Share-target staging, 24h TTL (`studyos.js:2679`) |

Blobs are deliberately kept out of localStorage and out of the Firestore
document; see `_sosSerializeClasses()` below.

### 2.3 Firestore — cloud sync

| Path | Contents |
|---|---|
| `dashboards/studyos` | One doc: `{ classes, events, tasks, notes, ksu, d2l }` |
| `studyos_notes/{moduleId}` | One doc per Notes module (rich-text bodies) |
| `dashboards/studyos_lock` | App-lock state |
| `dashboards/studyos_shield_apps` | Shield app list |

Paths are overridable via `PATHS` in `config/config.js`; the values above are
the fallbacks hard-coded in `firebase-sync.js`.

---

## 3. Entity shapes

### Class — `studyos.js:828`

```js
{
  id: String,           // Date.now().toString()
  name: String,         // RAW text. Not HTML-escaped at rest. See §5.
  code: String,         // e.g. "CS 3410"
  instructor: String,
  color: String,        // hex; normalized through window.sosPastel() on load
  modules: Module[],
}
```

### Module — `studyos.js:2483`

```js
{
  id: String,           // Date.now().toString()
  name: String,
  type: 'documents' | 'prompts' | 'notes',
  icon: String,         // emoji
  files: FileEntry[],   // populated when type === 'documents'
  prompts: [],          // when type === 'prompts'
  notes: [],            // when type === 'notes'
}
```

All three arrays are created on every module regardless of `type`.

### FileEntry

Persisted form is whatever survives `_sosSerializeClasses()` (`studyos.js:4385`):
every own key **except** `dataUrl` and any key starting with `_`. So
`storageUrl` / `storagePath` persist (the cloud copy stays reachable from other
devices), while the inline blob and transient flags (`_uploading`,
`_cloudError`) are stripped before both localStorage and Firestore writes.

### Event — `studyos.js:3270`

```js
{
  id: String,
  name: String,
  date: String,         // 'YYYY-MM-DD'
  time: String,
  classId: String,
  type: 'exam'|'hw'|'quiz'|'lecture'|'lab'|'other',
  notif: String,        // ISO timestamp, or the literal 'none'
  weight: Number,       // grade weight %, 0 when unset
  repeat: 'none'|'weekly'|…,
  repeatDays: Number[],
  repeatEndDate: String,
  repeatId?: String,    // groups instances of one repeating series
}
```

### Task — `studyos.js:3933`

```js
{
  id: String,
  done: Boolean,
  createdAt: Number,    // Date.now()
  name: String,
  dueDate: String,      // 'YYYY-MM-DD'
  dueTime: String,
  priority: 'low'|'medium'|'high',
  type: String,         // default 'hw'
  classId: String,
  notes: String,
  notif: String,        // ISO timestamp or 'none'
  repeat, repeatDays, repeatEndDate, repeatId?,
}
```

Events and Tasks are unified for dashboard purposes by `_sosScheduleItems()`,
which tags each with `src: 'task' | 'event'`.

### KsuItem

`studyos_ksu` is `{ modules: Module[] }` — the same `Module` shape as above,
not attached to a class. `findClassOrKsu()` treats it as a pseudo-class.

---

## 4. Persistence entry points

| Function | Writes | Line |
|---|---|---|
| `persist()` | `studyos_classes` + Firestore | 4415 |
| `persistEvents()` | `studyos_events` + Firestore | 4425 |
| `persistTasks()` | `studyos_tasks` + Firestore | 3838 |
| `persistTasks_()` | `studyos_tasks` + Firestore | 4426 |
| `persistNotes()` | `studyos_notes_v2` + Firestore | 3155 |
| `persistKsu()` | `studyos_ksu` + Firestore | 257 |
| `_sosFirebaseSave()` | the whole `dashboards/studyos` doc | 4401 |

Note `persistTasks` and `persistTasks_` are duplicates with identical bodies —
a cleanup candidate, but both are live call targets today.

---

## 5. Known correctness issues (F-3 and related)

### 5.1 Class-name rendering — it is an **escaping** bug, not a double-escape

The spec (F-3) states `Computer Organization & Architecture` renders as
`Computer Organization & amp` because names are "escaped twice between save and
render", and prescribes a migration to repair stored `&amp;`.

**Source says otherwise.** Class names are stored raw — `inp-class-name`'s value
is `.trim()`ed straight into `cls.name` (`studyos.js:826`) with no escaping on
the write path. The defect is on the **render** path: names are injected into
HTML *without* escaping, so the browser interprets `&` + following text as an
entity.

Confirmed unescaped sinks:

- `studyos.js:1214` — `item.innerHTML = cls.name` (sidebar)
- `studyos.js:3828` — `${ev.name}` in `.sos-pq-name` and `${cls.name}` in the
  meta line (priority queue)

Most other surfaces are already safe because they use `textContent`
(lines 1224, 1225, 3260, 3879, 3908, …), which is exactly why the bug shows in
the two places it does and not everywhere.

Consequences for the fix:

- The repair is to **escape at the sink**, not to un-escape stored data.
- A migration that rewrites stored `&amp;` → `&` would be **wrong and lossy**: a
  class legitimately named `R&amp;D` would be silently corrupted, and no stored
  name is double-escaped in the first place.
- An `escHtml()` already exists at `studyos.js:3148` (4 call sites). Reuse it.
- `js/d2l-sync.js:427` has a more complete `esc()` covering `& < > " '`.
  `escHtml()` covers only `& < >` — adequate for text nodes, **not** for
  attribute interpolation.

This is a correction to the spec, recorded here so F-3 is implemented against
what the code actually does.

### 5.2 Cold-load merge needs an explicit contract

`studyos.js:4605–4610` merges the remote Firestore doc with
`if (Array.isArray(remote.classes)) { classes = remote.classes; … }`. A remote
field that is absent or non-array leaves the local value untouched, so a genuine
"everything deleted" state may fail to replicate. Any Phase 0 store work (F-2)
must define this behavior explicitly rather than inherit it by accident.

### 5.3 Spec claims not borne out by source

- "Priority Queue rows are not clickable and have no completion affordance" —
  rows **are** clickable today: `item.onclick` at `studyos.js:3823` opens the
  task/event editor. The missing part is only the inline ▶ / ✓ / ⏭ affordances
  (S-2), not clickability.

---

## 6. Schema versioning plan

No `schemaVersion` field exists in any store today. The plan:

1. Introduce `studyos_schema_version` in localStorage; absent ⇒ treat as `1`.
2. `js/modules/migrate.js` holds an ordered array of
   `{ version, name, up(state) }`, each **idempotent**.
3. Run at boot, before the first render, after the defensive parse of §2.1.
4. Log one line: `schema v1 → vN, K migrations applied`.
5. Bump the target version in the same commit as the shape change, never after.

Acceptance for F-1 (per spec): loading with existing data logs the version line
and changes nothing visually. Because no migration exists yet, the first run
logs `schema v1 → v1, 0 migrations applied`.

---

## 7. Sync conflict policy

**Undefined today** — last-write-wins by accident rather than by design, since
`_sosFirebaseSave()` always writes the entire document. The spec's backlog
requires this be specified per entity before Phase 1 ships. Not yet decided;
this section is the placeholder that must be filled before any pipeline job
starts writing notes from a Worker.
