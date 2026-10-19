# Restoring a TaskHub from backup

Tony and Veda restore their own TaskHubs: no Claude session and no
`tools/pull-backups.mjs` run needed.

## How to restore

1. TaskHub → **Settings** → **Backup** section → **Restore** → **Open**.
   It opens `backup-restore.html?profile=<tony|veda>` in the same tab, so an
   installed app keeps its saved backup passphrase.
2. If this browser has the passphrase saved, the backups open by themselves.
   Otherwise type Tony's or Veda's backup passphrase. It is used on the page
   only and never saved.
3. Choose the **Tony** or **Veda** tab. Every version of that TaskHub is listed,
   newest first, grouped by day:
   - **+N back** means the version has N items the TaskHub no longer has.
   - **Current** means the version the TaskHub holds now.
   - **Suggested** marks the newest version with something missing, which
     after a reset is the version from just before it.
4. Pick a version and read **What changes**. Then pick a mode:
   - **Merge** (recommended): the backup, plus anything done since it.
   - **Exact copy**: the backup exactly as it was.
5. Press **Restore** and confirm.

**Undo.** After a restore, an **Undo** card appears on that person's tab. Undo
is also a three-way merge, so anything done after the restore is kept. An undo
can be redone the same way.

## Where the backups come from

| Source | What | When it is used |
|---|---|---|
| index-backups worker (`workers2/index-backups`) | each device's last 14 encrypted snapshots | always: `/index` lists each device's `stamps`, then the page fetches `/s/<device>?at=<stamp>` and `/o/<hash>` |
| this browser's vault (`backup.js`) | last 72 h, finer-grained | only when this browser has the passphrase saved |
| `Index Backups/` in the repo | daily copies made by `tools/pull-backups.mjs` | only if the worker cannot be reached |

The worker accepts the page's App Check token, as it does for TaskHub. Every
snapshot holds both TaskHubs, so either passphrase can restore either one. A
device whose snapshots the passphrase cannot open (the other person's device)
is skipped.

## What a restore writes

Nothing is written until the person confirms. Then, in this order:

1. `dashboards/<doc>_prerestore`: `{ at, kind: 'restore'|'undo', doc, from, mode, restoredSavedAt, by }`.
   `doc` is the state before the restore.
2. `dashboards/<doc>_restored`: `{ at, doc }`, the state that was written.
3. `dashboards/<doc>` and `dashboards/<doc>_head`, in one transaction: the new
   state, with a fresh `savedAt` and the next version (`rev`), so every open
   TaskHub picks it up. See [versioned-save.md](versioned-save.md).

`<doc>` is `main` (Tony) or `vedasdash` (Veda). If the doc changed after the
page read it, the page redoes the preview and asks again; it does not write
the old plan.

Undo is `A1BackupMerge.mergeDoc(base = _restored.doc, good = _prerestore.doc,
live)`. Restores made before 2026-10-19 have no `_restored` record, so undoing
one of them is an exact copy, and the page warns about that first.

## Tests

- `node tests/backup-restore-page.test.js`: headless Edge with stubbed
  Firebase and a mocked worker, carrying real backup.js ciphertext. It covers
  the passphrase gate, both tabs, the suggested version, restore, undo that
  keeps a later edit, redo, the changed-while-open re-plan, and the repo
  fallback.
- `node tests/backup-merge.test.js`: the merge rules.
