# Plans Section — Design Spec

**Target file:** `index.html` (single-file TaskHub suite, ~41.8k lines)
**Date:** 2026-08-13
**Status:** Approved design, ready for implementation planning

---

## 1. Problem

Two people (`veda`, `tony`) share this app. One person floats a casual build idea
in conversation; the other treats it as a commitment and builds a plan around it.
Neither has a shared record of which is which.

The Plans section gives every shared commitment one home with an explicit,
two-sided confirmation step. Nothing counts as a plan unless **both** profiles
have pressed confirm inside the app.

### Non-goals

- This is not authentication. Profiles are a chooser with an optional local
  password; "tony confirmed" means "someone using the tony profile pressed
  confirm." That is sufficient for two people who trust each other and
  insufficient as proof. Do not build features that assume otherwise.
- This does not police conversations outside the app. It only makes the
  in-app record unambiguous.

---

## 2. Approach

Build Plans as a **standalone root div** (`#plans-root`), matching the existing
pattern used by Veda Links (`#vd-kc-root`) and MyJournal (`#bj-root`): one
self-contained section, vanilla JS, its own Firestore document, shown/hidden by
the existing nav routers.

**Rejected:** implementing inside each TaskHub. Tony's TaskHub (`#root`) and
Veda's TaskHub (`#veda-root`) are separate React apps that share no code, so
that route means writing the confirmation logic twice and letting the two copies
drift apart — reintroducing the exact disagreement the feature exists to prevent.

Both profiles see the identical section from the identical code.

---

## 3. Data model

New shared Firestore doc: **`dashboards/plans`**.

Follow the MyJournal collaboration pattern exactly (see `BJ_DOC_PATH` handling
around line 8329): each plan is stored as its own top-level field `p_{planId}`,
written with `updateDoc` for field-level merge, falling back to `setDoc` when the
document does not yet exist. Two devices editing two different plans must never
overwrite each other.

```js
p_abc123: {
  id: "abc123",
  title: "string",
  notes: "string",
  author: "veda" | "tony",       // who first created it
  stage: "idea" | "proposed" | "confirmed" | "declined" | "done" | "dropped",
  date: "YYYY-MM-DD" | null,
  time: "HH:MM" | null,
  proposedBy: "veda" | "tony" | null,
  proposedAt: <ms> | null,
  confirms:  { veda: <ms>|null, tony: <ms>|null },
  cancelReq: { by, reason, at } | null,
  declined:  { by, reason, at } | null,
  createdAt: <ms>,
  updatedAt: <ms>
}
```

### Derived-state rule (load-bearing)

`stage === "confirmed"` is only ever written when **both** `confirms.veda` and
`confirms.tony` are non-null. Never set `stage` to `confirmed` from a single
action. Compute it:

```js
function isConfirmed(p) {
  return !!(p.confirms && p.confirms.veda && p.confirms.tony);
}
```

On every render, reconcile: if `stage === "confirmed"` but `isConfirmed(p)` is
false, the record is corrupt — drop it back to `proposed` and log a warning.
This structural two-sidedness is what makes it impossible for one person to
manufacture a confirmed plan.

---

## 4. Lifecycle

```
        create
          ↓
        IDEA ──────── promote (either person) ───────→ PROPOSED
          ↑                                              │  │
          │                                    confirm ──┘  └── decline (+reason)
          │                                    (both)              │
          │                                       ↓                ↓
          └──── restore ──── DECLINED ←──────  CONFIRMED       DECLINED
                                                  │
                                    ┌─────────────┼─────────────┐
                              cancel request   mark done    (edit resets)
                                    │             ↓              ↓
                              other agrees →   DONE          PROPOSED
                                    ↓
                                DROPPED
```

### Stage rules

**Idea** — non-binding by definition. The section header must say so in plain
language ("Ideas are not commitments"). Either person can add an idea. Both can
see all ideas.

**Promote to Proposed** — either person can promote any idea, including one the
other person authored. No gate here; the confirm step is the gate. Set
`proposedBy` / `proposedAt`, and auto-set `confirms[proposedBy]` to now (proposing
implies your own consent).

**Confirm** — the other person presses confirm; `confirms[them]` is set and the
plan becomes Confirmed. If the plan has no `date`, the confirm button must show a
warning first ("No date set — confirm anyway?") with confirm/cancel. Do not block;
just warn.

**Decline** — either person can decline a proposed plan. Requires a short reason
(free text, may be empty but the field is shown). Sets `declined` and moves stage
to `declined`. Declined plans live in their own collapsed list and can be restored
to Idea with one press.

**Cancel a confirmed plan** — symmetric with confirming. One person files a cancel
request with a reason (`cancelReq`); the plan stays Confirmed and shows a visible
"cancel requested by X" badge. The plan only moves to `dropped` when the other
person agrees. The requester can withdraw their own request at any time.

**Material edit resets confirmation.** If anyone edits `title`, `date`, or `time`
on a Confirmed plan, clear both `confirms` and drop the stage to `proposed`,
re-setting `confirms[editor]`. Editing `notes` does not reset. Show a warning
before the reset edit is saved. Rationale: a plan confirmed for Saturday that
silently becomes a plan for Tuesday is the original problem wearing a disguise.

---

## 5. TaskHub integration

Confirming a plan creates a real task/event in **both** TaskHubs.

Reuse the existing StudyOS mirror pattern (`_sosId` reconciliation, in Veda's
TaskHub around line 12190) — do not invent a new mechanism.

- Generated items carry a `_planId` field equal to the plan's `id`.
- Write into `dashboards/main` (Tony) and `dashboards/vedasdash` (Veda), keyed on
  the plan's `date`.
- Only plans with a non-null `date` generate items. Undated confirmed plans live
  in the Plans section only.
- **Reconcile, do not merge.** `dashboards/plans` is the sole source of truth for
  every `_planId`-tagged item. On each sync: any tagged item whose plan is no
  longer confirmed (dropped, declined, reset to proposed, deleted) must be removed
  from both TaskHubs. Any confirmed dated plan with no corresponding item must
  have one created. Items without a `_planId` are user-owned and must never be
  touched.
- Changing a confirmed plan's date resets it to Proposed (§4), which removes the
  generated items; re-confirming recreates them at the new date. This means date
  changes need no special-case code.
- Guard against write loops: only write when the reconciled signature actually
  differs from the current state, exactly as `sosMirrorSigRef` does.

---

## 6. UI

Dark theme only (light mode is removed suite-wide). Match the existing visual
vocabulary: `#1a1a1d` page background, card backgrounds around `#26272A`,
`1px solid #3D3E43` borders, ~10px radii, Lucide-style 24px-grid line icons at
1.5 stroke.

The section is neutral-toned rather than adopting either profile's accent
(Tony gold `#c8a15f`, Veda purple `#8D769A`), because it belongs to both.

### Layout

Four stacked lists, in this order:

1. **Needs your response** — proposed plans awaiting *the active profile's*
   confirm, plus confirmed plans with an open cancel request from the other
   person. Empty state: "Nothing waiting on you."
2. **Confirmed** — sorted by date, undated last. Cancel-requested plans show a
   badge.
3. **Proposed** — awaiting the *other* person. Shows "waiting on X."
4. **Ideas** — non-binding pile, with the plain-language disclaimer in the
   header.

Declined and Dropped live in a single collapsed "Archive" section at the bottom,
each showing who declined/cancelled and the recorded reason.

### Plan card

Title, date/time (or a muted "no date"), author, and a stage-appropriate action
row. Confirmed cards show both confirmation timestamps — the visible record of
who agreed and when is the artifact this whole feature exists to produce.

### Nav badge

Both nav buttons show a count badge when the active profile has items in
"Needs your response." No push notifications in this version.

---

## 7. Wiring into the existing file

Five integration points. Keep changes to existing code minimal and surgical.

1. **Root div** — add `<div id="plans-root" style="display:none">` alongside the
   other roots, with its own `<script>` block.
2. **Tony's nav** — add a `.tn-btn` with `data-app="plans"` in `#tony-app-nav`
   (line ~4843), plus a matching `<option>` in `#tn-mobile-select`. Add a `plans`
   branch to `window._tonyNav` (line ~26872).
3. **Veda's nav** — add a button to the Veda header row (the `veda-hbtns` block,
   line ~12574) calling `window._vedaNav('plans')`, and add a `plans` branch to
   `window._vedaNav` (line ~10298).
4. **Hide lists** — `#plans-root` must be added to every existing "hide all roots"
   array. Grep for `'vd-kc-root'` and add `'plans-root'` at each site; there are
   several (`goTony`, `goVeda`, `_tonyNav`, `_vedaNav`, `showTonyJournal`, the
   Veda Links back handler, and the profile-switch cleanup).
5. **Firebase layer** — inside the existing module script (~line 7548): add
   `const PLANS_DOC_PATH = "dashboards/plans";`, an `onSnapshot` listener
   dispatching `fb-plans-remote-update`, `window._fbLoadPlans`, and
   `window._fbSavePlan(planId, planObj)` using `updateDoc` with `setDoc` fallback
   on `not-found`. Mirror the BJ implementation.

### App lock

Register the section in `AL_APP_ROOTS` (line ~39600) as
`shared_plans: ['plans-root']` so it can be password-locked like the other apps,
and route it through `window.alGate` in both nav branches.

---

## 8. Edge cases

- **Both confirm simultaneously.** Field-level merge on separate keys inside
  `confirms` handles this; last write wins per key, and both keys end up set.
- **Both press cancel at once.** Second cancel request sees an existing
  `cancelReq` from the other party and is treated as agreement — drop the plan.
- **Offline.** Firestore's persistent cache queues the write. The card shows a
  pending state until the snapshot echoes back, consistent with the rest of the
  suite.
- **Plan deleted while confirmed.** Deletion of a confirmed plan requires the
  same two-sided flow as cancel. Ideas, proposed, and archived plans can be
  deleted outright by either person.
- **Empty title.** Reject; a plan with no title cannot be reasoned about.
- **Legacy/corrupt records.** Any `p_*` field missing `confirms` is coerced to a
  `confirms: {veda:null, tony:null}` shape on read rather than crashing.

---

## 9. Testing

Manual, two-window (two profiles side by side in separate browser windows):

1. Create idea as V → appears in X's Ideas list.
2. X promotes it → lands in V's "Needs your response," not in Confirmed.
3. V declines with a reason → appears in both Archives with the reason attached.
4. Restore → back to Ideas.
5. Re-propose, V confirms → Confirmed in both; dated plan appears in both
   TaskHubs; undated plan does not.
6. X requests cancel → badge visible to V; plan still Confirmed; TaskHub items
   still present.
7. V agrees → plan Dropped; TaskHub items removed from both dashboards.
8. Confirm a dated plan, then edit its date → resets to Proposed, TaskHub items
   removed. Re-confirm → items reappear at the new date.
9. Confirm with no date → warning appears; confirming anyway works.
10. Verify a hand-written TaskHub task with no `_planId` is never modified or
    removed by any of the above.
11. Reload both windows → all state survives; no duplicate `_planId` items
    accumulate across reloads.

---

## 10. Open risk

The section works only if both people adopt the rule: **if it is not Confirmed in
TaskHub, it is not a plan.** No amount of code enforces that. Consider putting
that sentence in the section header as the standing agreement.
