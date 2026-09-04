# TradeHub Journal — the load race, and the backups that now cover it

Reported 2026-09-04, Tony:

> Sometimes, when I load TradeHub fresh and hit Journal, it will load, but then
> it won't have my manual CSV imported entries, only the WeBull ones. Then I
> refresh the page again THEN it pulls the manual, BUT it won't properly combine
> the WeBull entries. After I hit "WeBull Sync" THEN everything gets proper.

Self-contained. Read this before touching journal loading, Webull Sync,
Re-merge, CSV import, or the backup vault in `tradehub.html`.

Guarded by `tests/journal-integrity.test.js` (in `npm test`).

---

## The journal is one document, and every job rewrites all of it

`dashboards/tradeboard_journal` holds one field per trade (`t_<id>`). Webull
Sync, Re-merge and CSV import are all **read-modify-write over the whole list**:
they take the current trades, merge, and write the result back. `_tbJournalStore`
is the in-memory copy they read from.

That design is fine, and it is why the ordering below is not optional.

## What went wrong

Opening TradeHub and landing on Journal starts two things in the same tick:

* `tbLoadJournal()` — the Firebase read, from the tab's mount effect;
* the morning Webull auto-sync, from the tab's other mount effect (and the
  app-level orchestrator, which also calls `window._tbJournalSync`).

Nothing made the sync wait for the read. When the sync won the race:

1. it merged the pulled Webull orders into `prev = []`, so every `source:'csv'`
   and `source:'manual'` entry fell out of the merged output;
2. it wrote that result back, and `_fbReplaceTBTrades` deleted nothing it did
   not know about — so the CSV trades survived *in Firestore* but vanished from
   the screen, and the freshly written Webull entries were grouped against an
   empty history;
3. `tbLoadJournal` then **discarded its own correct result** — the `if(!S.busy)`
   guard, which exists so a load cannot clobber a finished job — while still
   setting `S.loaded = true`.

Hence the exact sequence reported. First load: Webull only. Second load: the CSV
trades are back (they were never deleted), but the Webull entries are the
mis-grouped ones the broken sync wrote. A manual **Webull Sync** was the first
one that ever ran against a fully loaded store, so it produced a correct merge
and everything came right.

A second bug made it sticky: `_fbLoadTBJournal` returned `null` both for "the
document does not exist" and for "the read failed". The caller marked the
journal loaded either way, so a single flaky read left an empty list standing as
fact for the rest of the page's life.

## The four invariants

**1. No mutating job runs before a read has SUCCEEDED.**
`tbRunJournalJob(kind, label, fn)` is the only way in. It takes `_tbJobClaim`
*synchronously* (two jobs kicked in the same tick cannot both pass), awaits
`tbJournalReady()`, and only then sets `S.busy` and runs the body. A job that
cannot get a read does nothing and says so.

The load must happen **before** `S.busy` is claimed — `tbLoadJournal` refuses to
apply a server read while a job is running, so claiming busy first would
deadlock the thing it is waiting for.

**2. `loaded` means a read succeeded.**
`_fbLoadTBJournal` returns `{ok:true, trades, exists}` or `{ok:false, error}`.
Only `ok:true` sets `S.loaded`; a failure sets `S.loadError`, `tbJournalReady`
retries three times with backoff, and the Journal tab renders *"Could not load
your journal"* rather than *"No trades yet"* — the wrong empty state invites
exactly the wrong next action.

A cache-only read that misses is also `ok:false`: the memory cache is empty on
every page load, so a miss is not evidence the journal is empty.

**3. A bulk write cannot silently gut the journal.**
`_fbReplaceTBTrades` reads the current server document first, computes what the
document will actually *hold* afterwards (not how many fields it writes), and
refuses on either of two tests:

* **count** — the journal would fall below `REPLACE_SHRINK_RATIO` (0.5) of its
  size, and it holds at least `REPLACE_SHRINK_FLOOR` (8) trades;
* **source** — any `source:'csv'` or `source:'manual'` trade would disappear.

The second is the sharp one. A journal that is mostly Webull can lose *every*
imported and hand-entered trade and still clear a 50% count test — which is the
shape of this bug — and those are the trades that cannot be re-pulled from the
broker.

Neither guard can fire on a healthy operation. `tbReconcileWebull` returns every
CSV and manual entry untouched in `others`; Re-merge deletes only Webull ids;
deleting by hand goes through `_fbDeleteTBTrade`, not this path. Only an
explicit **Restore** passes `force:true`.

Counting *written fields* instead of the resulting document is the mistake to
avoid here: Re-merge writes only the rebuilt Webull subset, so a naive
comparison refuses every healthy re-merge.

**4. A failed sync does not stamp itself as done.**
`TB_SYNC_TS_KEY` is written only on success, so a broken morning is retried
instead of skipped. `TB_SYNC_TRY_KEY` + `TB_SYNC_RETRY_MS` (30 min) is what
stops the 5-minute orchestrator hammering a Webull worker that is down; the
button passes `{manual:true}` and ignores it.

## The backup vault

Journal → **Backups**. Whole-journal snapshots in two independent places:

| | Where | Retention |
|---|---|---|
| local | IndexedDB `tradehub-journal-backups` | `TB_BK.LOCAL_KEEP` — 14 recent, then daily ×14, then weekly ×10 |
| cloud | `dashboards/tradeboard_journal_backups`, one field per snapshot | `TB_BK.CLOUD_KEEP` — 6 / 10 / 6, under a 640 KB budget |

The cloud copy is a **separate document** from the journal on purpose: the
failure being protected against is the journal document going wrong, and a
backup living inside the thing it backs up is not a backup.

Snapshots are gzipped (`CompressionStream`), base64'd, and content-addressed by
a SHA-256 of the trade list, so an unchanged journal is never stored twice. At
~50 bytes per trade compressed, a 100-trade journal is ~5 KB and the whole cloud
set is well under Firestore's 1 MiB per-document cap.

### Firestore cost

Measured, per action, counting **documents** (Firestore bills per document, so
one `updateDoc` carrying 83 trade fields is one write):

| action | journal r/w | backups r/w |
|---|---|---|
| open Journal, first time | 1 / 0 | 1 / 1 |
| open Journal again, inside the gap | 1 / 0 | 0 / 0 |
| sit on the tab, 30s | 0 / 0 | 0 / 0 |
| Webull Sync, nothing new | 1 / 2 | 1 / 1 |
| add one trade | 0 / 1 | 0 / 0 — queued |
| import a 60-row CSV | 0 / 1 | 0 / 0 — queued |
| open the Backups panel | 0 / 0 | 1 / 0 |
| a queued push firing on its own | 0 / 0 | 1 / 1 |
| **all of the above, one session** | **4 / 5** | **4 / 3** |

Eight reads and eight writes, against a free-tier budget of 50,000 reads and
20,000 writes a day. The backup vault is not close to being the expensive part
of this app.

"Queued" is the rate limit deferring a push, not skipping one — the row near the
bottom is that same push landing a minute later with nobody touching anything.
Journal writes are 2 for a sync because the sync also stamps `_syncMeta`.

Three things keep it there:

* **`CLOUD_MIN_GAP_MS` (60s).** Captures are content-addressed, so a push only
  ever happens for a genuinely changed journal — the gap does not suppress
  noise, it delays real changes. It is therefore short, and a suppressed push
  is **queued, not dropped**: a timer fires it when the gap expires, and
  `pagehide` flushes it if the tab closes first. It was 10 minutes at first,
  which measured no cheaper and left the last edit of a session on one device.
* **`_fbSaveTBTradeBulk` is a single `updateDoc`.** It used to fire one write
  per trade in parallel, making a 60-row CSV import 60 writes — and, worse, a
  non-atomic import: a dropped connection halfway left some rows saved and some
  not, with nothing recording which. Now it is one write, all-or-nothing, and
  the caller reports failure instead of showing trades that only exist in that
  tab.

* **A push short-circuits on `_tbBkState.lastCloudHash`.** If this exact
  journal is already the newest thing in the cloud there is nothing to send and
  no reason to spend a READ finding that out. Without it every deferred flush
  cost a read only to discover it had nothing to do (3 backup reads on a first
  open instead of 1).

The one thing that is *not* free is `_fbReplaceTBTrades`' pre-write read: one
extra document read per bulk write. That is the price of guards 3 and of having
a pre-write snapshot at all, and at one read per sync it is not a real cost.

**Every destructive path snapshots first, awaited** (`{now:true}`): CSV import,
single and bulk delete, Re-merge, Restore, and any bulk write from inside
`_fbReplaceTBTrades`. A backup taken *after* the delete is not a backup. Routine
paths (a load, a completed sync, an edit) debounce at 4s and flush on `pagehide`.

A snapshot is a point-in-time copy, so the cloud backup can trail the live
journal by up to a minute of activity. The journal document itself is always
written immediately — the lag affects only the backup copy, and only matters if
the journal document were damaged inside that window.

`Restore` replaces the journal (and takes a `pre-restore` snapshot first, so a
restore is itself undoable). `Import JSON` only *adds* trades that are missing —
the common recovery is "some trades went missing", and a merge cannot lose what
it does not touch. `Export JSON` is full-fidelity: ids, legs, sources and Webull
order ids all survive, unlike the CSV export.

Console: `tbBackup.list()`, `.read(snap)`, `.capture()`, `.health()`.

This vault is **deliberately separate from `backup.js` (A1Backup)**. A1Backup's
IndexedDB vault, snapshot store and per-device worker slot are shared per origin
and scoped to `index.html`; registering a second app would interleave one-document
TradeHub snapshots with Index's multi-document ones in the same store and make
`restoreSnapshot()` ambiguous. That would degrade the only safety net Index has.

## CSV import now actually dedups

The header had promised "dedup by ticker+date+entryPrice+qty" since the feature
shipped, and the "No new trades (all duplicates)" branch existed — but nothing
compared anything. Every row became a new entry with a new uuid, so re-importing
a file silently doubled the journal.

`tbCsvSig(entry)` is the identity: ticker, buy **day**, quantity, and entry/exit
price to the cent. It deliberately ignores ids (every import mints new ones),
clock time (the CSV carries only a close time and the buy time is derived from a
rounded "hold" string) and notes/tags (edited afterwards; a re-import must not
resurrect the old copy). The same function is applied to existing entries and to
freshly parsed rows, so the two cannot drift.
