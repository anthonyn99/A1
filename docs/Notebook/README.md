# Notebook

The journals as one program: **MyJournal** (Tony), **Brainstorm Journal** (Veda),
**OurJournal** (shared), and the DOCX page editor they all use. It has no page of its
own. A program (a *host*) loads it and mounts an app into itself. It is built once, in
`Notebook/`, and every host runs those same files. A change there reaches every host
at once, so don't copy its code into a program.

**Two profiles (2026-10-27): Tony and Veda.** A host names a side, not an app:

```js
Notebook.mount({ profile: 'tony' });   // Tony's side: app myjournal, key tj, store tony_journal
Notebook.mount({ profile: 'veda' });   // Veda's side: app brainstorm, key bj, store journal
```

`Notebook.profiles` holds that table (`PROFILES` in `notebook.js`). The two sides
are named and work the same way: the program is **Notebook** (nav, header,
Settings, App Lock), and its sidebar tabs are **OurJournal** plus the person's own
journal (**MyJournal** for Tony, **Journal** for Veda). The only differences are
Veda's colours and fonts and her extra templates (Cornell, Mind Map, Structured
Notes, ...). Code, ids and the data keep the old `tj` / `bj` and Brainstorm names.
Every host mounts by profile. The older `{ app, key, store }` form still
mounts, but nothing uses it; write new hosts with `profile`.

An **instance** (a program's own documents) is either side with its own key
and store: `{ profile: 'tony', key, store, ... }` or `{ profile: 'veda', key,
store, ... }` (2026-10-27). Both take the same options (below) and give the
same API (`Notebook.open`, `attach` / `detach`, `cfg.entries()`). A Veda
instance is her app (`apps/brainstorm.js`, rewritten by `rewriteBj`) in her
look: her colours, IBM Plex Mono, her purple hover glow, her templates; her
fonts load if the host has none, and index's header (TaskHub, Gita, App Lock)
is left out. Both sides' instances save through the same store template
(core/fb.js `@nb-store`).

| Host | Profile | key | Store (`dashboards/…`) | Mode |
|---|---|---|---|---|
| index.html, Tony | tony | `tj` | `tony_journal` | overlay (native) |
| index.html, Veda | veda | `bj` | `journal` | overlay (native) |
| tradehub.html, Playbook (A1-Priv) | tony | `pb` | `tradehub_playbook` | inline (instance) |
| tradehub.html, Control's prompts (A1-Priv) | tony | `prm` | `tradehub_prompts` | inline (instance, no sidebar) |
| everwell.html, notes (A1-Priv) | tony | `ewn` | `everwell_notes` | inline (instance) |

Plan and history: [plan.md](plan.md).

## What reaches which program

Every feature added, removed or changed in Notebook reaches every program that
mounts it, on its next load. Nothing in a host has to change. This is the rule:

| Change in | Reaches |
|---|---|
| `core/` (the DOCX editor, OurJournal, boards, md, the Firestore layer), `notebook.css` | every journal in every host: MyJournal, Brainstorm, OurJournal, every instance |
| `apps/myjournal.*` | Tony's journal and every Tony instance (Playbook, Everwell notes, any later one) |
| `apps/brainstorm.*` | Veda's journal and every Veda instance |

- **Build features in Notebook, never in a host.** A host only loads, mounts and
  configures. A feature written into a host reaches only that host.
- **A program leaves a feature out only through its mount config:** `features`
  (`ourjournal`, `locks`, `sidebar`), `templates`, `pinned`. A feature that some program
  should not get needs a `features` switch in Notebook, defaulting to on, so
  every other program still gets it.
- **Veda's side is the standing exception.** A MyJournal feature doesn't reach
  Brainstorm unless it's built in `core/` or added to `apps/brainstorm.*` on
  purpose, because Veda's side never changes unless asked. The mount contract
  (features, pinned, onSave, onReady, entries, open) is the one exception: it is
  in both apps, and `tests/live/notebook-host.live.js` runs it on both.
- **The cache can't hold a change back.** Hosts load Notebook with a `?v=` hash of
  this folder, and the pre-commit hook rewrites it in every host, A1-Priv's
  included, whenever Notebook changes. `tests/notebook-wiring.test.js` fails on
  a stale one.
- **What a host borrows has a stand-in.** An instance gets Notebook's own icon
  set, drag, Guardian and dialogs when the host has none. So a MyJournal feature
  must not depend on something only index.html provides (its nav, its app lock,
  its helpers); in an instance that feature would quietly do nothing.

## Files

```
Notebook/
  notebook.js         loader, Notebook.mount, instancing (rewrite + store template)
  notebook.css        DOCX + journal shell CSS (#tj-root/#bj-root scoped) and MyJournal's rail
  core/jguard.js      JGuard + the journal touch-drag helper
  core/viz.js/.css    VizEngine (whiteboard / mind map boards)
  core/oj.js/.css     OurJournal engine
  core/fb.js          the journals' Firestore layer (installed by the host)
  core/md.js          markdown -> HTML helpers
  core/docx.js        the DOCX editor; per-app config through Notebook.registerDocx
  apps/myjournal.*    MyJournal (written for key tj)
  apps/brainstorm.*   Brainstorm Journal (key bj)
tni.js                the suite's icon set (root; index loads it, Notebook loads it when a host has none)
```

## Add Notebook to a program

A MyJournal of the program's own: its own documents, with the same editor and
features as Tony's.

```html
<!-- 1. In <head>, a classic script (not async/defer): -->
<script src="Notebook/notebook.js?v=<stamp>"></script>
```

```js
// 2. Hand Notebook the program's Firestore (it never starts its own):
window.NotebookFirebase = () => ({ db, fs });   // fs = the firebase-firestore module namespace

// 3. Mount it where it should live, once the container exists:
Notebook.mount({
  profile: 'tony', key: 'pb', store: 'tradehub_playbook',
  container: document.getElementById('playbook-host'),   // it fills this element
  title: 'Playbook',                                      // replaces "MyJournal" in its UI
  templates: ['page'],                                    // template cards offered (default: all)
  features: { ourjournal: false, locks: false, sidebar: true },   // an instance's defaults
  pinned: [{ id: 'daily-reminder', title: 'Daily Reminder' }],
  onSave: (entry) => {},     // after the cloud confirms a save of `entry`
  onReady: () => {}          // after the first load from the server
}).then(() => { /* mounted */ });
```

There is nothing to register. `tools/notebook-stamp.js` finds every page in A1 and
A1-Priv that loads `notebook.js` and keeps its `?v=` current, and
`tests/notebook-hosts.test.js` holds the new page to the host rules below. Keep the
program's `window.uiAlert/uiConfirm/uiPrompt/uiForm` if it has them. Notebook borrows
them, and its stand-ins are the browser's own dialogs.

### Host rules

A host talks to its instance only through what this page documents: the mount
options, `Notebook.open`, `Notebook.attach` / `Notebook.detach`, `Notebook.pin`, `Notebook.flushAll`,
and `cfg.entries()` (Notebook adds it to the config the host passed). Everything
else (the instance's ids and classes, its `_<key>…` functions, its `<key>_…`
storage keys, its ready events) is Notebook's to rename, so a host that touched
it would break silently the day Notebook changed. Concretely:

- Load `notebook.js` once, as a plain `<script>` (or with `data-lazy`), never
  async, deferred or as a module.
- Write the mount call with `app`, `key` and `store` spelled out, in that order.
- Set `window.NotebookFirebase` before mounting.
- No CSS for `#<key>-…` and no script that queries, clicks or moves the
  instance's elements. To hide part of Notebook, use a mount option; if none
  exists, add a `features` switch to Notebook (default on) and to `FEATURES` in
  `notebook.js`.
- `Notebook.mount` throws on an option or feature it doesn't know, so a typo
  fails at once instead of quietly leaving a program behind.

`tests/notebook-hosts.test.js` fails on any of these for every host it finds, and
A1-Priv's suite runs it too. index.html is the native host of `tj` and `bj` and is
exempt from the internals rule (it owns how they open inside TaskHub).

**An instance looks and behaves exactly like MyJournal in index.html.** Its
stylesheet (`instanceSheet` in `notebook.js`) is every tj rule MyJournal gets
there, in index's cascade order (core sheets, `brainstorm.css`'s shared ribbon
rule, `myjournal.css`, then `notebook.css`), opened by a guard that undoes the
host's bare element rules (`select { width: 100% }` and the like) and adds
index's default button glow. A host's own CSS never reaches the editor's
controls. `tests/live/notebook-look.live.js` compares every host's ribbon and
title bar to MyJournal's, element by element, at rest and under the cursor; a
new host goes in its `HOSTS` list.

| Option | Meaning |
|---|---|
| `key` | 2–8 lowercase letters. The prefix of every id, class, function and local-storage key (`pb-root`, `_pbSetSync`, `pb_unlockedat_…`). One per host page. |
| `store` | The Firestore document `dashboards/<store>`, and the prefix of its image and AI documents. Never `tony_journal` or `journal`. |
| `container` | Where it lives. Mode `inline` (the instance default) fills the element; `overlay` covers the page. |
| `title` | The name shown wherever MyJournal says "MyJournal". |
| `templates` | Which template cards the New Entry picker offers. |
| `features.ourjournal` | OurJournal's tab and rail. Off for an instance; offering it to another host is future work (OurJournal is wired to tj/bj). |
| `features.locks` | Per-entry password locks, namespaced by key on the taskhub-reminders worker. Off for an instance unless turned on. |
| `features.sidebar` | The entry list (and its phone drawer and the phone bar's New button). On unless set to `false`, for a host that keeps its own list of pages and opens them with `Notebook.open` (Everwell). |
| `pinned` | Pages always at the top, never trashed, purged, dragged or locked. A pinned page missing from the store appears empty with `updated: 0`, so the cloud copy wins as soon as it loads. |
| `onSave(entry)` | Called when `fb-<key>-saved` confirms that entry. |
| `onReady()` | Called once, after the first server read. |

To open a page from the host (its own list, a link), call
`Notebook.open(key, id, { edit: true })`. It does what a click on the page's row
does, switches edit (`true`) or view (`false`) mode when asked, and waits for the
mount and for the page to load. It resolves `true` once the page is open, and
`false` if the page never turns up or a newer `open` took over. Never click or
read Notebook's own elements from a host: their ids are Notebook's to change.

A host that keeps its own list and adds to it after mounting (TradeHub's
prompts) pins each new page with `Notebook.pin(key, { id, title, html })` before
opening it. `Notebook.open` then makes the page if the store lacks it, seeded
with `html`, exactly as a mount-time `pinned` page is made. It returns `false`
when nothing is mounted under `key`.

A host whose own markup comes and goes (TradeHub's React tab) moves the mounted
instance with `Notebook.attach(key, container)` and sets it aside, hidden and
still running, with `Notebook.detach(key)`. Both return `false` when nothing is
mounted under `key` yet, so `attach` doubles as "is it mounted?".

### How an instance works

`apps/myjournal.js` is written for key `tj`. For any other key, `notebook.js` fetches it
and rewrites the prefixes: `tj`→key, `TJ`→KEY, `Tony…`→`Key…` (loader names),
`tony_journal`→store, `myjournal_ai`→`<store>_ai`, `MyJournal`→title. It routes what
the source waits for at load (DOMContentLoaded, index's `fb-ready`) to the instance's
own signals, and runs the result inside the container. The Firestore layer is made the
same way from `core/fb.js`: everything between its `@nb-store` markers (tj's state,
guards and install block) plus its `@nb-shared` helpers, joined to the host through
`Notebook.fb.addStore`. `tests/notebook-instance.test.js` checks that nothing of tj's
survives a rewrite, and `tests/live/notebook-host.live.js` runs a throwaway host
end to end.

When editing MyJournal, keep its names prefixed (`tj-`, `_tj`, `tjX`, `TJ_`) and its
store named `tony_journal`. An unprefixed name would be shared by every instance on a page.

## Data layout

| What | Where |
|---|---|
| Entries | `dashboards/<store>`: one field per entry `e_<id>`, plus `_order` (id list), `activeId`, `savedAt` |
| Page images | `dashboards/<store>_img_<entry>_<hash>` (`{ img }`), placeholders `<key>-fbimg://…` in the HTML |
| Boards | `dashboards/<store>_viz_…` (VizEngine chunks) |
| AI Format prompt / tools | `dashboards/<store>_aiprompt`, `dashboards/<store>_aitools` (MyJournal: `myjournal_*`) |
| Local cache | `localStorage['<store>_v3']`, `docx_*_<key>`, `<key>_unlocked*_<id>` |
| Locks | taskhub-reminders worker, `jKey(<key>, entryId)` |

## Firebase cost

| Action | Reads | Writes |
|---|---|---|
| Open (each mount / reconnect) | 1 forced server read + the listener's first snapshot | 0 |
| Another device saves | 1 per change (listener) | 0 |
| Typing | 0 | 1 per autosave burst (≥ every 1.5 s while typing): the one entry field |
| New / trash / restore / reorder | 0 | 1 each |
| New image on a page | 0 | 1 image document (never re-uploaded: cached by signature) |
| Opening a page with images | from cache first (free); 1 per image not cached | 0 |

Writes wait until the server has been seen once per connection (the stale-overwrite
guard), so a cold start from cache never overwrites newer cloud data.

## Index.html (the native host)

index.html loads `notebook.js` where the journal code used to be, mounts
`{app:'brainstorm', key:'bj', store:'journal'}` and `{app:'myjournal', key:'tj',
store:'tony_journal'}`, calls `Notebook.load('docx')` after them, and from its Firebase
`init()` calls `Notebook.fb.install(F)` with its own helpers. Its teardown calls
`Notebook.fb.unsubscribe()` and `Notebook.fb.rearm()`. How MyJournal opens inside
TaskHub (`showTonyJournal`, the program nav), `_pwReset` and the `_fbFlushAll` safety
net (→ `Notebook.flushAll()`) are index's own. `tests/notebook-wiring.test.js` fails
if journal code comes back into index.html.
