# Wellness Tracker — Design Spec

**Date:** 2026-08-07
**Owner:** Veda
**Status:** Approved for implementation

## 1. Overview

A single-user web app for tracking personal wellness across fully customizable
categories (built-in examples: Sleep, Water, Mood, Exercise, Meals, Meditation —
but the user can add, edit, or remove any category and its fields at any time).
Includes daily reminders/streaks via push notification and trend charts per
category.

**Non-goals:** multi-user support, social features, public sign-up. This is a
single authenticated user's personal tool.

## 2. Stack

- **Frontend:** React + TypeScript, hosted on Cloudflare Pages/Workers
- **Backend logic:** Firebase Cloud Functions (for scheduled reminder/streak
  jobs; simple CRUD goes direct from client to Firestore via the SDK)
- **Database:** Firebase Firestore
- **Auth:** Firebase Auth (already configured — assume it exists, do not
  reconfigure it). Single authenticated user.
- **Push notifications:** Firebase Cloud Messaging (FCM)

Assume the existing GitHub repo, Cloudflare project, and Firebase project are
already wired together and deployable. Do not scaffold a new Firebase project
or new Cloudflare project — integrate into the existing one at this directory.

## 3. Data Model (Firestore)

All data is scoped under the authenticated user, e.g.:
`users/{uid}/categories/{categoryId}`
`users/{uid}/entries/{entryId}`

### 3.1 `categories` collection

```ts
interface Category {
  id: string;              // doc id
  name: string;             // e.g. "Sleep", "Beauty"
  icon?: string;             // optional emoji or icon identifier
  color?: string;            // hex color for charts/UI
  order: number;             // for user-defined display ordering
  archived: boolean;         // soft-delete / hide without losing history
  fields: CategoryField[];   // schema for entries in this category
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

type FieldType = "number" | "text" | "scale" | "duration";

interface CategoryField {
  id: string;                // stable field id (used as key in Entry.values)
  label: string;              // e.g. "Hours", "Quality"
  type: FieldType;
  unit?: string;               // e.g. "glasses", "min" — for number/duration
  scaleMin?: number;            // required if type === "scale" (e.g. 1)
  scaleMax?: number;            // required if type === "scale" (e.g. 5)
  required: boolean;
}
```

Field type semantics:
- `number`: plain numeric input, optional unit label
- `text`: free-text notes
- `scale`: integer picker bounded by `scaleMin`/`scaleMax`
- `duration`: stored as total minutes (number); UI may present as hours+minutes

### 3.2 `entries` collection

```ts
interface Entry {
  id: string;                 // doc id
  categoryId: string;          // references Category.id
  timestamp: Timestamp;        // when the logged activity occurred
  createdAt: Timestamp;        // when the entry was recorded
  values: Record<string, string | number>; // keyed by CategoryField.id
}
```

`values` keys must match the `fields[].id` defined on the referenced category
at the time of entry creation. Do not enforce this via Firestore rules (too
rigid as schemas evolve) — enforce it in client-side/Cloud Function validation
logic instead (see §7).

### 3.3 Seed data

On first run (or via a one-time seed script), create these six built-in
categories for the user, each with a sensible default schema:

- **Sleep**: `hours` (number), `quality` (scale 1-5)
- **Water**: `glasses` (number, unit "glasses")
- **Mood**: `rating` (scale 1-5), `notes` (text, not required)
- **Exercise**: `activity` (text), `duration` (duration), `intensity` (scale 1-5)
- **Meals**: `description` (text), `notes` (text, not required)
- **Meditation**: `duration` (duration)

These are seeded as normal `categories` docs — no special-casing in code.
The user can edit/delete/archive them like any custom category.

## 4. Category Management (CRUD)

- **Create category:** name, icon, color, and a field-builder UI to add
  fields (label, type, unit/scale bounds, required toggle) before saving.
- **Edit category:** rename, change icon/color/order, add/remove/edit fields.
  - Editing a field's `type` after entries exist is destructive to old
    entries' values for that field — warn the user with a confirmation
    dialog before allowing it ("Existing entries may not display this field
    correctly"). Do not attempt automatic value migration/coercion.
  - Removing a field does not delete historical values already stored in
    past entries' `values` maps — those become orphaned keys and should
    simply not be rendered by the UI, not deleted.
- **Delete category:** soft-delete via `archived: true`. Archived categories
  are hidden from the logging UI and the category list by default, but their
  past entries remain in history/charts. Provide an "Archived categories"
  view to unarchive.
- **Reorder categories:** drag-and-drop updates `order` field on affected docs.

## 5. Logging Entries

- Home/dashboard screen lists active (non-archived) categories as tappable
  cards.
- Tapping a category opens a form auto-generated from its `fields` schema
  (this generation logic is the core reusable piece — one form renderer
  driven entirely by `CategoryField[]`, no per-category special cases).
- Defaults `timestamp` to now but allow editing (for logging a past event).
- On submit, validate required fields are present and scale values are within
  bounds before writing to Firestore.
- After saving, show a lightweight success state and return to dashboard.

## 6. History & Trend Charts

- Per-category history view: reverse-chronological list of past entries for
  that category, editable/deletable.
- Per-category trend chart:
  - For `number`/`duration`/`scale` fields: line or bar chart over time
    (selectable range: 7 days / 30 days / 90 days / all time).
  - For `text`-only categories: no chart, history list only.
  - If a category has multiple numeric fields (e.g. Exercise has `duration`
    and `intensity`), let the user pick which field to chart, one at a time.
- Use a lightweight charting library (e.g. Recharts) rather than building
  custom SVG charting.

## 7. Validation Rules (Cloud Function or shared TS module)

Centralize entry validation in one shared function used both client-side
(before submit, for good UX) and — since this is a solo trusted user with
Firebase Auth already gating access — client-side validation is sufficient;
a server-side Cloud Function validator is NOT required for v1, but write the
validation logic as a standalone, pure, unit-testable TypeScript function
(not inlined in a component) so it could be reused server-side later.

Validation function responsibilities:
- Every `required: true` field in the category's schema has a present,
  non-empty value in `Entry.values`.
- `scale` values fall within `[scaleMin, scaleMax]`.
- `number`/`duration` values are valid numbers (not NaN, not negative unless
  explicitly allowed — default to non-negative).

## 8. Reminders & Streaks

- **Streaks:** for each active category, compute the current streak
  (consecutive days with at least one entry) client-side from the `entries`
  collection when the dashboard loads. Do not store streak counts
  redundantly in Firestore — derive them, to avoid sync bugs between stored
  counts and actual entry data.
- **Daily reminders:** a scheduled Firebase Cloud Function (Cloud Scheduler
  trigger) runs once daily at a fixed time (configurable, default 8 PM local
  — store the user's preferred time in a `users/{uid}/settings` doc). It
  checks which active categories have no entry yet today and sends a single
  FCM push notification summarizing them (e.g. "You haven't logged: Water,
  Sleep").
  - If all active categories are already logged for the day, skip sending
    (no notification spam).
- **Push setup:** client requests notification permission and registers an
  FCM token, stored on the user's `settings` doc (`fcmToken` field) so the
  Cloud Function knows where to send it.

## 9. Screens

1. **Dashboard** — active categories as cards showing today's logged status
   + streak count; tap to log.
2. **Log Entry** — auto-generated form per category schema.
3. **Category List/Manager** — add/edit/archive/reorder categories; edit
   field schemas.
4. **Category History** — entry list + trend chart for one category.
5. **Settings** — reminder time, notification permission toggle.

## 10. Error Handling

- All Firestore reads/writes wrapped in try/catch with user-visible error
  toast/banner on failure (never fail silently).
- Form validation errors shown inline next to the relevant field, not just
  a generic banner.
- If FCM permission is denied, disable reminder toggle in Settings and show
  a note explaining push notifications are off — do not repeatedly re-prompt.
- Cloud Function failures (e.g. reminder job errors) should log to Firebase
  Functions logs with enough context (uid, error) to debug rather than
  failing silently — wrap the job body in try/catch so a bad Firestore
  read/FCM error surfaces in logs instead of just vanishing.

## 11. Testing Expectations

- Unit tests for the shared validation function (§7) covering: missing
  required field, out-of-bounds scale, negative number/duration, valid input.
- Unit tests for the streak computation logic (consecutive-day counting,
  including edge cases: no entries, entry today only, gap in history).
- Component test for the dynamic form renderer: given a sample
  `CategoryField[]`, confirm it renders one input per field of the correct
  type.

## 12. Explicit Out of Scope (v1)

- Multi-user support / sharing
- Data export/import
- Editing historical field-type migrations (see §4 warning instead)
- Server-side validation via Cloud Functions (client-side only for now)
- Native mobile app (web only, but should be responsive/mobile-friendly)
