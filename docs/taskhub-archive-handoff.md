# TaskHub — "tasks reverted by a lot of days" (archive overflow)

Context compiled **2026-09-01**. Self-contained; read this before touching the
TaskHub archive/un-archive code in `index.html`.

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

### Why the latch key was bumped to `_v2`

`_v1` was a one-time flag. A device that took the old *"merged fits under the
cap"* success path has it stuck at `"1"` — and on that device the corrected
restore would be **skipped entirely**, so nothing would come back. A fresh key
re-runs the fixed restore exactly once everywhere, regardless of the old value.

This was a real gap in the first version of the fix; without it, the fix silently
does nothing on some devices.

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
node tests/archive-visibility.test.js   # 24 checks — this bug
node tests/sync-guard.test.js           # 99 checks — the 3 older sync races
node tests/syntax-check.js
```

`tests/archive-visibility.test.js` was written for this bug. It is **static +
behavioural**: it lifts the real `thSplitArchivable` out of `index.html` and
replays the overflow prune on ~2 years of realistic data, then asserts every
archived day is visible, none reach the payload, and the payload still fits.

**It was confirmed to fail on the pre-fix code and pass after** — a real
regression guard, not a rubber stamp.

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

- Run both test files above. Sync work has regressed twice before precisely
  because it was verified by reading rather than running.
- Keep the invariant: **anything in `*ArchivedRef` must never enter a payload.**
  Breaking that re-creates the oversize document and can trip the 900 KB write
  guard, which stops syncing altogether.
- `localStorage` throttles/latches are **per-device**. A "runs once per day" gate
  does not mean once per user — that asymmetry is the whole reason this presented
  as a phone-only bug.
- Related: `memory/taskhub-sync-two-paths.md` (now documents all four paths).

---

## Commits

`cc636d7`, `f33b2ee`, `4d621f2` — all `auto: claude code` (repo auto-commit hook).
Changes are confined to `index.html` and `tests/archive-visibility.test.js`.
