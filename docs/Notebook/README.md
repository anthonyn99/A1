# Notebook

The journals as one program: **MyJournal** (Tony), **Brainstorm Journal** (Veda),
**OurJournal** (shared), and the DOCX page editor they all use. It has no page of its
own. A program (a *host*) loads it and mounts an app into itself. It is built once, in
`Notebook/`, and every host runs those same files. A change there reaches every host
at once, so don't copy its code into a program.

| Host | App | key | Store (`dashboards/…`) | Mode |
|---|---|---|---|---|
| index.html, Tony | myjournal | `tj` | `tony_journal` | overlay (native) |
| index.html, Veda | brainstorm | `bj` | `journal` | overlay (native) |
| tradehub.html, Playbook | myjournal | `pb` | `tradehub_playbook` | inline (instance) |

Plan and history: [plan.md](plan.md).

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
  app: 'myjournal', key: 'pb', store: 'tradehub_playbook',
  container: document.getElementById('playbook-host'),   // it fills this element
  title: 'Playbook',                                      // replaces "MyJournal" in its UI
  templates: ['page'],                                    // template cards offered (default: all)
  features: { ourjournal: false, locks: false },          // an instance's defaults
  pinned: [{ id: 'daily-reminder', title: 'Daily Reminder' }],
  onSave: (entry) => {},     // after the cloud confirms a save of `entry`
  onReady: () => {}          // after the first load from the server
}).then(() => { /* mounted */ });
```

Then add the host to `tools/notebook-stamp.js` (it rewrites every host's `?v=`), and
keep the program's `window.uiAlert/uiConfirm/uiPrompt/uiForm` if it has them. Notebook
borrows them, and its stand-ins are the browser's own dialogs.

| Option | Meaning |
|---|---|
| `key` | 2–8 lowercase letters. The prefix of every id, class, function and local-storage key (`pb-root`, `_pbSetSync`, `pb_unlockedat_…`). One per host page. |
| `store` | The Firestore document `dashboards/<store>`, and the prefix of its image and AI documents. Never `tony_journal` or `journal`. |
| `container` | Where it lives. Mode `inline` (the instance default) fills the element; `overlay` covers the page. |
| `title` | The name shown wherever MyJournal says "MyJournal". |
| `templates` | Which template cards the New Entry picker offers. |
| `features.ourjournal` | OurJournal's tab and rail. Off for an instance; offering it to another host is future work (OurJournal is wired to tj/bj). |
| `features.locks` | Per-entry password locks, namespaced by key on the taskhub-reminders worker. Off for an instance unless turned on. |
| `pinned` | Pages always at the top, never trashed, purged, dragged or locked. A pinned page missing from the store appears empty with `updated: 0`, so the cloud copy wins as soon as it loads. |
| `onSave(entry)` | Called when `fb-<key>-saved` confirms that entry. |
| `onReady()` | Called once, after the first server read. |

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
