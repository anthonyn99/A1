# TaskHub — the archive/un-archive failures ("my days got reverted")

Two rounds of the same underlying feature failing, both reported by Veda, both
triggered by opening TaskHub on her phone. Read **Round 2 first** — it is the
current state of the code. Round 1 is kept in full because it is accurate
history and explains why the machinery exists at all.

| | Reported | Symptom | Cause |
|---|---|---|---|
| Round 1 | 2026-08-31 | history reverted "by a lot of days" | the archiver pruned days out of the UI and the restore was deadlocked against the size cap |
| Round 2 | 2026-09-01 | **the last 5 days** gone, and gone again on her PC | the archived-key registry did not survive a reload, the size valve had no recent-days floor, and the restore was latched once per device |

Self-contained; read this before touching the TaskHub archive/un-archive code in
`index.html`.

---

# Round 2 — "my last 5 days are gone" (2026-09-01)

Veda reported the same symptom again, this time on **recent** days, after a phone
open. Everything in Round 1 below is still accurate history, but the fix it
describes was **incomplete in three ways**. All three are fixed now.

> Read this section first. If you only read Round 1 you will look for the bug in
> the wrong place — the size gate and the `setData(split.keep)` prune it blames
> were genuinely fixed and stayed fixed.

## What went wrong the second time

The Round 1 fix separated "in the live document" from "on screen" using an
in-memory registry (`thArchivedRef` / `vdArchivedRef`). The registry was
**memory-only. The merged data was not** — `setDataLocalOnly` writes it straight
to `localStorage`. So the two halves disagreed on the very next load, and three
failures fell out of that one asymmetry:

**A. The cache re-uploaded archived history.**
On a cold load `data` came back from `localStorage` holding all the restored
sidecar days, while the registry came back **empty**. `buildPayload` therefore
had nothing to strip, and the next save pushed the whole ~1.1 MB back into the
live document — re-inflating exactly the doc whose size caused the prune, or
tripping the 900 KB `FB_MAX_WRITE_BYTES` guard and stopping sync outright.

**B. The size valve then chewed forward into the present.**
The archiver saw an oversize doc again and ran the valve. Its only floor was
`if(k>=todayKey)break;` — which protects exactly **one day**. So it archived
yesterday, and the day before, a few more days on each device's daily run. That
is the reported symptom, precisely: the last five days.

**C. Other devices could never get them back.**
The restore was latched once-per-**device** (`td*_unarchived_v2`), while the
archiver runs once per device per **day**. Any day the phone archived after the
PC's single restore was simply absent on the PC — gone from the live doc, and
never looked for again. Hence "I opened TaskHub on my PC and my days were gone."

Round 1 called the `_v2` bump "a real gap in the first version of the fix."
That was right about the symptom and wrong about the cure: the problem was never
which key the latch used, it was that a latch existed at all.

## The Round 2 fix

| Piece | Where | What it does |
|---|---|---|
| `thLoadArchivedKeys` / `thSaveArchivedKeys` | module scope, both blocks | Registry persisted to `td6_archivedKeys` / `td_archivedKeys` |
| `useRef(thLoadArchivedKeys(...))` | `thArchivedRef`, `vdArchivedRef` | Hydrated at **first render**, before any payload can be built |
| `TH_ARCHIVE_MIN_AGE_DAYS = 365` + `thMinAgeKey()` | both blocks | Real floor for the size valve |
| `out.overCap` + `console.error` | `thSplitArchivable`, both archivers | An unfixable oversize doc is **reported**, not paid for with recent days |
| Latch deleted | both un-archives | The restore runs on **every** load; the merge only ever adds keys, so it is idempotent |
| Registry **rebuilt** from the scan | both un-archives | Sidecars are the source of truth; a wrong flag cannot outlive a load |
| Reclaim loop | both un-archives | Days inside the floor come back **editable**, newest-first, budgeted against the cap |
| `if(!unarchiveRanRef.current)return;` | both archivers | Never prune before the restore has run — offline that means no pruning at all |
| `if(a===null)throw` | both un-archives | A failed sidecar read is no longer mistaken for "no archive that year" |

### Why the floor is 365 and not more

The protected window has to **fit under `TH_ARCHIVE_SOFT_BYTES` by itself**, or
the archiver can never reach the cap and the doc stays permanently oversize.
At the density measured on Veda's document (~1.46 KB/day):

| Floor | Protected window | Verdict |
|---|---|---|
| 365 days | ~520 KB | ~260 KB headroom — chosen |
| 550 days | ~800 KB | **already over the 780 KB cap** — tried first, rejected |

`tests/archive-visibility.test.js` asserts this directly ("the protected window
itself fits under the soft cap"), so raising the floor fails the suite rather
than silently wedging the archiver.

### What Veda actually gets back

Round 1 shipped restored days as **read-only**, which was correct for genuinely
old history. It was wrong for days the valve should never have taken. The reclaim
loop now pulls everything inside the floor back into the live document as
**editable** data and pushes it — so her recent days return writable, on every
device, automatically. History older than a year stays read-only, and the
[trade-off](#the-trade-off-read-only) note below still governs that part.

## Verification (Round 2)

```bash
node tests/archive-visibility.test.js   # 48 checks, was 24
node tests/sync-guard.test.js           # 99 checks — the 3 older sync races
node tests/syntax-check.js
```

Full suite green as of 2026-09-01.

**Confirmed to fail on the pre-fix code.** Run against `6099a24:index.html`,
every new static guard fails and the behavioural harness cannot even find
`thMinAgeKey`.

**Driven in a real browser this time** (headless Edge over CDP — the gap Round 1
left open). Seed `td6_archivedKeys` / `td_archivedKeys` plus matching `td*_data`,
reload, and inspect:

| | pre-fix (`6099a24`) | fixed |
|---|---|---|
| `_thIsArchivedDay(k)` after reload | `false, false, false` | `true, true, true` |
| archived days in `_thRebuildPayload().data` | **yes** — they get re-uploaded | no |
| newest day the valve archived (4 yr fixture) | up to yesterday | `2025-03-24`, floor `2025-09-01` |

15/15 browser checks pass on the fixed build. The driver scripts are scratch-dir
scoped and do not persist; recreate from `.claude/skills/verify`.

### Still not verified

- **Firestore is unreachable from `file://`** — App Check reCAPTCHA cannot attest
  a file origin, so the sidecar read, the restore and the reclaim were verified as
  code and in-browser state, **not** end-to-end against live data. Same limitation
  Round 1 hit.
- **There are still no Firestore backups** (see below). Unchanged, and still worth
  fixing separately — a local backup system was being planned as of 2026-09-01.

## How to confirm it worked on a real device

Open TaskHub, wait ~5s, check the console:

```
[Unarchive] Veda: restored N day(s) [2024:…, 2025:…] as READ-ONLY history;
  reclaimed M recent day(s) as EDITABLE (2026-08-27 → 2026-08-31);
  in-memory data now … KB, live doc … KB
```

Non-zero `M` is the recent days coming back **editable**. If you instead see

```
[Archive] Veda: live doc is still … KB after archiving everything older than 365 days.
```

then the document genuinely cannot fit and needs a capacity plan — do **not**
raise `TH_ARCHIVE_SOFT_BYTES` or lower the floor to silence it.

## Invariants — break these and it happens again

1. **Anything in `*ArchivedRef` must never enter a payload.** (Round 1)
2. **The registry must be persisted wherever the merged data is persisted.**
   They are one fact stored in two places; if only one survives a reload, the
   next save is wrong. This is what broke in Round 2.
3. **The size valve must never touch the recent window**, whatever the doc size.
   An oversize doc is a loud failure, not a licence to delete the present.
4. **Recovery must be as frequent as the damage.** The archiver runs per device
   per day, so the restore runs per load. A once-per-device latch guarding a
   once-per-day job is a permanent hole, and no key name fixes that.
5. **`localStorage` throttles and latches are per-device.** "Runs once a day" does
   not mean once per user — that asymmetry is why this always presented as a
   phone bug. (Round 1, still true.)

---

# Round 1 — "reverted by a lot of days" (2026-08-31)

Reported by Veda: *"the tasks got reverted when I opened TaskHub on my phone,
that too by a lot of days"* — and, importantly, **it happens every time she first
opens TaskHub on her phone**, not once.

---

## TL;DR

- **No data was ever lost.** Nothing was deleted, server-side or otherwise.
- The days were **moved** into per-year sidecar docs
  (`dashboards/vedasdash_archive_<year>`, `dashboards/main_archive_<year>`).
- They *looked* deleted because the archiver removed them from the UI **and** the
  un-archive that should have brought them back was **deadlocked** and could
  never run successfully.
- Both halves are fixed, for **both profiles**. Restore is automatic on next load.
- **Restored days come back read-only** — a deliberate choice, see
  [The trade-off](#the-trade-off-read-only).

This is **not** one of the three previously-known TaskHub sync races. Do not go
looking in the write guards — see [Why the old fixes did not cover it](#why-the-old-fixes-did-not-cover-it).

---

## What actually happened

Four steps, all in `index.html`:

**1. The document outgrew the soft cap.**
`TH_ARCHIVE_SOFT_BYTES = 780000` ([:5316](../index.html#L5316) Tony,
[:13642](../index.html#L13642) Veda). Veda's `data` measured ~1103 KB in repro.

**2. The overflow branch started moving *recent* days.**
`thSplitArchivable` normally archives only day-keys older than
`TH_ARCHIVE_YEARS` (6 years). But when `keep` exceeds the soft cap it walks
**recent** days oldest-first and moves them too, until the doc fits:

```js
if(thDataBytes(out.keep)>TH_ARCHIVE_SOFT_BYTES){
  for(const k of recent){
    if(k>=todayKey)break;
    move(k);delete out.keep[k];
    if(thDataBytes(out.keep)<=TH_ARCHIVE_SOFT_BYTES)break;
  }
}
```

Repro moved **226 days** (2024-09-02 → 2025-04-15). That is the "lot of days".

**3. The archiver deleted them from the UI too.**
It called `setData(split.keep)` — which both pruned the live doc *and* dropped
those days from React state, so they vanished from the day-grid.

**4. The un-archive could never restore them.**
It refused whenever the merged result exceeded `TH_ARCHIVE_SOFT_BYTES` — but
restoring is *exactly* what re-creates the oversize doc that triggered the prune.
**The two guards deadlocked**: the archiver pruned because the doc was too big,
and the restore refused because restoring made it too big again. The history
could never come back.

Worse, that early-return happened **before** the `..._unarchived_v1` latch was
set, so it silently retried and re-failed on every single load, forever.

### Why it is *always* the first phone open

The archiver is throttled once per day — but the throttle lives in
**`localStorage`**, which is **per-device**:

```js
const last = parseInt(localStorage.getItem("td_archive_at")||"0",10)||0;
if (Date.now()-last < 24*60*60*1000) return;
```

Her laptop stamps `td_archive_at` daily and stays inside the 24h window. Her
phone — opened rarely, and subject to Safari/iOS evicting site data between
visits — arrives with that key **missing or stale**, so the throttle passes and
the archiver fires 20s after load.

So the phone is not buggy; it is simply the only device whose throttle keeps
expiring. And because the old restore could never undo the previous run, each
phone visit pruned a little more. That loop is now broken at both ends.

> **Inference, not measurement.** The `td_archive_at` eviction is the best
> explanation for "always the phone", based on how Safari handles storage
> pressure. It was not observed on her actual device. To confirm, look for
> `[Archive] Veda: moved N day(s)` in her phone's console.

---

## Why the old fixes did not cover it

`memory/taskhub-sync-two-paths.md` documents three previously-fixed causes of
"my edits reverted":

1. **Write path** — a stale device uploading old state (`_thServerSeen`/`_fbGen`).
2. **Render path** — `_freshGet` falling back to the IndexedDB cache
   (`_fromCache` + the `savedAt` floor).
3. **Cold-open cross-document race** — the StudyOS mirror reconcile
   (`_bg` writes refused until `window._vdCloudLoaded`).

**All three were intact and working.** This was a fourth, unrelated path: not a
race, not a stale read, but a *size-driven data-movement job* whose recovery leg
was broken. The give-away is that a reload did **not** fix it — with the
render-path bug it did.

---

## The fix

Same shape on both profiles: **separate "in the live document" from "on screen."**
Archived days are merged into `data` for **display only** and stripped from every
write, so showing them costs memory but never document bytes — Firestore's 1 MiB
hard limit is still respected.

| Piece | Tony | Veda |
|---|---|---|
| Archived-key registry | `thArchivedRef` [:7175](../index.html#L7175) | `vdArchivedRef` [:14153](../index.html#L14153) |
| Stripped from payload | `buildPayload` [:7151](../index.html#L7151) | `buildVdPayload` [:14163](../index.html#L14163) |
| Render without pushing | `setDataLocalOnly` [:7217](../index.html#L7217) | `setDataLocalOnly` [:14201](../index.html#L14201) |
| Un-archive latch | `td6_unarchived_v2` [:7493](../index.html#L7493) | `td_unarchived_v2` [:14417](../index.html#L14417) |
| UI marker hook | `window._thIsArchivedDay(k)` [:7177](../index.html#L7177) | `window._vdIsArchivedDay(k)` [:14155](../index.html#L14155) |

Plus, on both:
- **Size gate removed** from the un-archive (this is what broke the deadlock).
- **Archiver keeps pruned days visible** — no more `setData(split.keep)`.
- **Archiver skips already-archived keys**, so restored history is not re-archived
  on every pass.
- **`tog`/`del` refuse edits** on archived day-keys, with a nudge.

### Why the latch key was bumped to `_v2` — SUPERSEDED

`_v1` was a one-time flag. A device that took the old *"merged fits under the
cap"* success path has it stuck at `"1"` — and on that device the corrected
restore would be **skipped entirely**, so nothing would come back. A fresh key
re-runs the fixed restore exactly once everywhere, regardless of the old value.

This was a real gap in the first version of the fix; without it, the fix silently
does nothing on some devices.

> **Superseded by Round 2.** The reasoning above is right about the symptom and
> wrong about the cure. The problem was not *which* key the latch used — it was
> that a once-per-device latch guarded recovery from a once-per-device-per-day
> archiver. Both `td_unarchived_v2` and `td6_unarchived_v2` are gone; the restore
> now runs on every load. See [Round 2](#round-2--my-last-5-days-are-gone-2026-09-01).

---

## The trade-off (read-only)

**Veda chose read-only history** when asked. Restored days are visible and
searchable but **not editable**.

The reason: making them editable means pulling them back into the live document,
which re-creates the oversize doc — and Firestore's hard limit is 1 MiB with a
900 KB write guard. Her doc was already ~1103 KB.

If you ever want them fully editable again, that needs a real capacity plan first
— raise `TH_ARCHIVE_SOFT_BYTES` *and* trim or shard the data across documents.
Do not just raise the constant; it will trip the write guard and stop sync entirely.

---

## Verification

```bash
node tests/archive-visibility.test.js   # was 24 checks; now 48 — see Round 2
node tests/sync-guard.test.js           # 99 checks — the 3 older sync races
node tests/syntax-check.js
```

`tests/archive-visibility.test.js` was written for this bug. It is **static +
behavioural**: it lifts the real `thSplitArchivable` out of `index.html` and
replays the overflow prune on ~2 years of realistic data, then asserts every
archived day is visible, none reach the payload, and the payload still fits.

**It was confirmed to fail on the pre-fix code and pass after** — a real
regression guard, not a rubber stamp.

> Round 2 kept all of this and added the recent-days floor, registry-persistence
> and reclaim cases, plus a fixture of ~4 years (2 years no longer overflows now
> that the floor protects the recent window).

Full suite green as of 2026-09-01. (`appcheck-verify` prints a libuv teardown
warning *after* reporting 14/14 — that is noise, not a failure.)

### What is NOT verified

- **Nothing was tested against live Firestore data.** The Firebase CLI can only
  `delete`/`indexes`/`backups` — it cannot read or write documents. Verification
  is code + tests only.
- **There are no Firestore backups.** `firestore:backups:list` returns none, and
  no schedule exists. There is **no point-in-time rollback** available for this
  project, by anyone. Worth fixing separately.
- **Not yet driven in a real browser.** The `verify` skill (CDP) can close this
  out. Two gotchas when you do: assert on committed state (`td_data` in
  localStorage), **not** on `#task-view` innerText — today's tasks may sit outside
  the rendered viewport; and clear the `td_*` keys between runs, or the previous
  run's `savedAt` floor correctly rejects everything.

---

## How to confirm it worked

Open TaskHub, wait ~3s, check the console:

```
[Unarchive] Veda: restored N day(s) [2024:..., 2025:...] as READ-ONLY history
[Unarchive] Tony: restored N day(s) [...] as READ-ONLY history
```

Non-zero `N` means the days are back. If the archiver fires later you will also see:

```
[Archive] ...: moved N day(s), ... (archived days still shown, read-only)
```

**Tony's profile likely has invisible history waiting.** His comments record that
his archiver already fired at an older, lower 600 KB threshold, so his sidecars
probably hold real days that have been unreachable this whole time. He may see
days *reappear* on his next load — that is the fix working, not a new bug.

---

## If you touch this code again

See [Invariants](#invariants--break-these-and-it-happens-again) in Round 2 — that
list supersedes this one and includes it. In short: run the tests (this code has
now regressed three times, every time after being verified by reading), never let
an archived key into a payload, never let the size valve near the recent window,
and remember that `localStorage` latches are per-device.

Related: `tests/sync-guard.test.js` covers the three earlier "my edits
reverted" races (stale write path, cache-fallback render path, cold-open
cross-document race). The archive failures are a fourth, unrelated path.
(Earlier revisions pointed at `memory/taskhub-sync-two-paths.md`; no such
file exists in this repo or in the assistant memory directory.)

---

## Commits

Round 1: `cc636d7`, `f33b2ee`, `4d621f2`, `6099a24`.
Round 2: everything after `6099a24` on 2026-09-01.

All `auto:` commits from the repo auto-commit hook. Changes are confined to
`index.html`, `tests/archive-visibility.test.js` and this document.
