# Firestore rules — reference only, nothing to deploy

**There is no `.rules` file in this folder on purpose.** StudyOS uses the
**Index** Firebase project (`task-dashboard-d2b53`), which already has its own
security rules covering everything StudyOS needs. Publishing a StudyOS-specific
rules file there would **delete the rules for a dozen other apps** — TaskHub,
the journals, Vault, ProView, EventRec, MotionCore and the rest all live in that
same database.

So: **do not run `firebase deploy --only firestore:rules` from this project.**
There is nothing to deploy and no rules step in the migration.

---

## Why nothing needs adding

The Index project's rules end with an authenticated catch-all:

```
match /{document=**} {
  allow read, write: if request.auth != null;
}
```

Every path StudyOS touches is already covered by it:

| Path | Used for |
|---|---|
| `dashboards/studyos` | classes, events, tasks, notes, KSU modules |
| `dashboards/studyos_lock` | App Lock state, synced across devices |
| `dashboards/studyos_mirror` | StudyOS → TaskHub task mirror |
| `dashboards/studyos_mirror_ack` | TaskHub → StudyOS done-state flips |
| `studyos_reminders` | scheduled push reminders (studyos-api cron) |
| `studyos_fcm_tokens` | StudyOS device push tokens |

StudyOS signs in anonymously, so `request.auth != null` is satisfied and all of
these read and write normally with no rules change at all.

> The two `studyos_`-prefixed collections are namespaced away from Index's own
> `reminders` and `fcm_tokens` deliberately — Index runs its own cron over
> those, and two crons on one collection means duplicate notifications and a
> race on the delete.

---

## If StudyOS is ever moved to its own Firebase project

Only then would it need its own rules. Deploy this to **that** project — never
to the Index one:

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // StudyOS application data. File BLOBS are not here — Firebase Storage
    // needs the paid Blaze plan, so bytes live in Cloudflare Workers KV and
    // this document holds only {name, size, mime, storageUrl}.
    match /dashboards/studyos       { allow read, write: if request.auth != null; }

    // App Lock: WHICH lock is on and at what version. The password itself is
    // never here — only a salted PBKDF2 hash in the studyos-api Worker's KV.
    match /dashboards/studyos_lock  { allow read, write: if request.auth != null; }

    // Task mirror. One writer each; see FIRESTORE note in ARCHITECTURE.md §4.
    match /dashboards/studyos_mirror     { allow read, write: if request.auth != null; }
    match /dashboards/studyos_mirror_ack { allow read, write: if request.auth != null; }

    // Push. Written by the browser; read and deleted by the cron, which
    // authenticates with a service account and bypasses these rules entirely.
    match /studyos_reminders/{id}   { allow read, write: if request.auth != null; }
    match /studyos_fcm_tokens/{id}  { allow read, write: if request.auth != null; }

    // No catch-all: an unmatched path fails closed, which is what you want.
    match /{document=**} { allow read, write: if false; }
  }
}
```

Note that the task mirror would then **stop working**, because Firestore cannot
read across projects — you would also have to fill in `taskMirror.firebase` in
`config/config.js` §7 with the Index project's web config so StudyOS opens a
second connection just for the mirror documents.

---

## Scope of these rules, stated plainly

They gate the **database**. Any anonymous session on the project can read these
documents. That is appropriate for a personal, single-user app and matches how
the original build shipped. The App Lock gates the **UI** — it stops someone
picking up an unlocked laptop, not someone with the config querying Firestore
directly. If this data ever needs to be private from other users of the same
project, replace the blanket `request.auth != null` with per-user document
ownership.
