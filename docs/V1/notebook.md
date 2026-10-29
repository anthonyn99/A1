# V's Notebook in StudyOS and TradeBoard

Since 2026-10-29 every text editor in Veda's StudyOS and TradeBoard is A1's
Notebook, on **Veda's side** (`profile: 'veda'`): the same editor, templates,
AI tools, Trash, tags, phone layout and sync as her journal (Brainstorm) in
index.html. The contract for any Notebook host is
[../Notebook/README.md](../Notebook/README.md); this page is what is specific
to these two.

| Program | Where | key | Store (Index project) | Folders |
|---|---|---|---|---|
| StudyOS (`V1/studyos.html`) | Quick Notes view, and every Notes module (class or KSU) | `stn` | `dashboards/studyos_notebook` | `quick`, and one per Notes module (its module id) |
| TradeBoard (`V1/TradeBoard/tradeboard.html`) | the Strats section | `vtb` | `dashboards/tradeboard_strats` | none |

Both load Notebook from A1's Pages URL (`https://anthonyn99.github.io/A1/Notebook/notebook.js?v=<stamp>`,
`data-lazy`), so they run the one Notebook every program runs, and A1's
`hoverfx.js` scoped to the notes' own boxes only (`data-roots=".sos-nb-host"` /
`"#st-host"`), so the notes answer the cursor as her journal does while the
rest of each app is unchanged.

## StudyOS

- **One instance, many places.** `js/sos-notebook.js` mounts the notes once
  (the first time any notes open) and moves them between the Quick Notes view
  and a Notes module's modal with `Notebook.attach` / `detach`, switching the
  folder with `Notebook.folder`. In each place the list, search, tags, Trash
  and New Entry show only that place's pages; a new page belongs to the place
  it was made in. A Notes module's modal widens (desktop) or fills the screen
  (phone); its title row has **Make flashcards**, which reads every page of the
  module (HTML extraction, `sosMakeCardsFromPages` in `js/modules/boot.js`).
- **Firestore.** `js/firebase-sync.js` hands Notebook its Index-project
  Firestore (`window._fbNotebook`), so the notes sit beside Veda's journal and
  StudyOS's own data.
- **Generated notes** (`_sosBridge.addGeneratedNote`) are pages written with
  `Notebook.putPage` into the module's folder; re-running one source replaces
  its page (found by `host.sourceFileId`).
- **What moved in, once** (`Notebook.importPages`, tags `sos-quick` and
  `sos-mod-<module id>` recorded in the store, after StudyOS has the server's
  copy of its own data):
  - Quick notes: the main document's `notes` → folder `quick` (ids `sosq_…`).
  - Each Notes module's page-editor document `studyos_notes/<module id>`
    (server copy, merged with the device's cache `studyos_notes_<module id>`;
    the newer copy of a page wins): ids, dates, tags, Trash, images (moved to
    their own documents) and a generated page's source (`host`).
  - Every module's old textarea notes (`mod.notes`, never shown since the page
    editor came in): a Notes module's into its folder (ids `sosn_<module>_…`), a
    documents/prompts module's into Quick Notes, tagged with the class and
    module names.
  - A device that finds a module already moved by another device adds the
    pages only its own cache had, once (`…-local`).
  The device remembers finished moves in `studyos_nb_moved`.
- **The old copies are the backup** and are never written or deleted: the main
  document's `notes`, `studyos_notes/{moduleId}`, `mod.notes`, and the
  `studyos_notes_<module id>` / `studyos_notes_v2` localStorage caches. Once
  Veda is happy, they can be swept (add the keys to A1's `cleanup-rules.json`).
- Removed: `js/notes-sync.js`, `js/docx-engine.js`, `css/docx-engine.css`,
  `css/so-notes.css`, the `#so-root` markup and the textarea note code.

## TradeBoard

- **Strats** is the Notebook (`TB.st` in tradeboard.html), mounted the first
  time the section opens; Notebook brings its own page list and editor.
- **Firestore.** TradeBoard's own project (`tradeboard-6b2ea`) allows only its
  `tradeboard/…` documents, so Strats has a second, named Firebase app
  (`tbnotebook`) on the Index project, with Index's original App Check key
  (the same host already serves StudyOS on that key) and its own anonymous
  sign-in. It is made only when Strats opens.
- **What moved in, once** (tag `tb-strats`, after the tradeboard document's
  first server snapshot): the old `strats` field's pages, ids `st_<old id>`,
  title and dates kept; a Markdown page as its rendered HTML. The page that was
  open is opened. The `strats` / `stratsActive` fields (and `tb.strats.*` in
  localStorage) are left as they were: the backup.
- TradeBoard's own table, `.tag`, `.lock-btn` and `.section-label` rules are
  scoped away from the notes (`:not(.tb-nb-host *)`), so her pages look as in
  her journal.

## Limits to know

- **One document per store.** All of StudyOS's notes share
  `dashboards/studyos_notebook`, which Firestore caps at 1 MiB. Images are
  stored in their own documents, so it is text that counts; a page too large to
  store is refused with a message and stays where it was.
- **The desktop shells** (StudyOS's and TradeBoard's Tauri apps) load the page
  from `tauri://localhost`. Notebook needs Index's App Check there too: if the
  notes do not open in a desktop shell, add that origin to Index's reCAPTCHA
  key's allowed domains (never swap the key).

## Tests

| Test | What it proves |
|---|---|
| `node tests/live/studyos-notebook.live.js` | the move of every kind of old note (and only once), each place's folder, new pages, generated notes, flashcards, a second device's cache, reload, phone layout |
| `node tests/live/tradeboard-notebook.live.js` | the Strats move (rich + Markdown pages), the open page, TradeBoard's styles kept out, saving, reload, phone layout |
| `node tests/live/notebook-look.live.js` | both editors match her journal element by element, at rest and under the cursor |
| `node tests/live/notebook-host.live.js` | folders, `importPages`, `putPage` on both sides |
| `node tests/notebook-hosts.test.js` | the host rules, including StudyOS's `js/` scripts |
| `cd V1 && npm run test:studyos` | StudyOS's unit suites (`test-pipeline.mjs` covers the generated-note path) |
