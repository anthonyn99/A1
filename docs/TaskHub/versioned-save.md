# TaskHub's versioned save

How Tony's and Veda's TaskHubs save, so that a device with an old copy can no
longer overwrite newer changes. Shipped 2026-10-19.

## The bug it fixes

On 2026-10-19 Tony's TaskHub was reset. Everything added since about 4:45 PM the
day before was gone: 2 tasks from that day and 1 from that morning. The live
documents showed the cause. A device that last synced the afternoon before woke
up and saved its whole TaskHub at 9:49 AM, with a fresh `savedAt`. Two things
let that through:

1. **Saves were blind.** Each save was a whole-document `setDoc`. Nothing
   checked which version the device's state was built on.
2. **Server copies were judged by the clock.** `applyRemote` skipped any
   cloud copy whose `savedAt` was older than this device's own last save. A
   device that saved right after waking (a tap, or an automatic job like
   pruning done goals) therefore skipped the real, newer copy and kept its
   old state.

A save queued before the server copy arrived was also flushed the moment the
server answered, before the copy was applied.

Veda's side had a client-side guard for the same failure (2026-10-10: a phone
asleep for 3 days). It refused the stale save, discarded the edit and asked her
to redo it. Tony's side had nothing. Neither guard was atomic.

## How it works now

- `dashboards/main` and `dashboards/vedasdash` carry a version, `rev`. Each has
  a tiny companion, `dashboards/<doc>_head` = `{ rev, savedAt, by }`.
- **Every save is a Firestore transaction** (`_casWrite` in index.html). It
  reads only the head, never the large document. It writes the document and
  the head together, at `rev + 1`, and only if the head still holds the
  version this device's state was built on (`_cas[doc].base`).
- **If another device saved first**, nothing is overwritten. The device:
  1. fetches the cloud copy;
  2. merges it with its own current state, item by item (`THMerge.syncMerge`
     in `taskhub-merge.js`), so both sides' additions, edits and deletions
     survive, and where both changed the same field this device's value wins;
  3. shows the merge;
  4. saves it.
- **The base** is the version the device's state is built on. It moves only when
  a server copy is applied, or after one of its own saves succeeds. It never
  moves while a save of its own is pending. It lives at module level, so it
  survives the teardown and re-init a phone does on every app switch. A fresh
  page with no base merges as a union (nothing deleted).
- **A server-confirmed copy always applies.** `applyRemote` only checks the
  clock for cache copies.
- **Transactions are never queued offline.** A failed or offline save stays
  pending as the current state. It retries when the connection returns, or
  with backoff (2 s up to 60 s), and then merges like any other save.
- **Old app versions.** A copy without `rev`, arriving after the head exists,
  was written by an old app version outside the check. A device that has a
  base saves its own state back over it. A fresh page has nothing better and
  takes it. That only lasts until every device has reloaded once.
- **The restore page** (`backup-restore.html`) writes through the same head
  transaction. Otherwise every TaskHub would skip a restore as an older
  version.

## Tests

| Test | What it proves |
|---|---|
| `node tests/taskhub-sync.test.js` | Two separate browsers run the REAL index.html against a fake Firestore that this test controls. It replays the 2026-10-19 reset, runs 5 rounds of both devices editing Veda's TaskHub at once, and checks that an old-version save gets repaired. Run it with `TH_INDEX=<an older index.html>` to see an old build lose the data. |
| `node tests/taskhub-merge.test.js` | The merge rules |
| `node tests/sync-guard.test.js` | The static guards, including "Static: versioned save" |
| `node tests/backup-restore-page.test.js` | A restore moves the doc and its head together |
