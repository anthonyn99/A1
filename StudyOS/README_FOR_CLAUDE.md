# README FOR CLAUDE — StudyOS migration into V1

**You are Claude Code, running in VS Code on Veda's computer.** This folder is a
complete, self-contained StudyOS application that was extracted from another
project. Your job is to move it into Veda's **V1** project and connect it to
**her** Firebase, Cloudflare and Formspree accounts.

The app is finished and tested. Nothing here needs to be written or redesigned.
What is missing is **configuration** — every account-specific value is a
placeholder. Fill those in, deploy two Workers, and it works.

> **Do not rewrite the application code.** Several parts look like they could be
> simplified but each one encodes a real bug fix. The comments say which. If you
> think something is redundant, read the comment above it before touching it.

---

## 0. Ground rules

| Rule | Why |
|---|---|
| Edit **only** `config/config.js`, the two `wrangler.toml` files, and `firebase/firebase-messaging-sw.js` | Everything else is account-agnostic. If you need to hardcode a value anywhere else, something is wrong. |
| Serve over **http(s)**, never `file://` | Firebase auth rejects the `null` origin, ES modules are blocked, and service workers won't register. `file://` produces a "Sync failed" state that looks like a bug but isn't. |
| Don't enable Firebase **App Check** until everything else works | A misconfigured App Check blocks every read and write and is indistinguishable from broken security rules. |
| Work top-to-bottom | Each step's verification depends on the previous one. |

---

## 1. What you are installing

```
StudyOS/
├── studyos.html                 the app (markup + module wiring)
├── manifest.webmanifest         installable as a home-screen app
├── config/config.js             ← THE ONLY FILE WITH ACCOUNT VALUES
├── css/studyos.css              page baseline + shell + app + lock overlay
├── js/
│   ├── shell.js                 header, config-driven sibling-app links
│   ├── ui.js                    uiConfirm / uiPrompt / uiForm / uiAlert
│   ├── applock.js               App Lock: gate, password lifecycle, biometrics
│   ├── firebase-sync.js         Firestore sync (ES module)
│   ├── push.js                  reminders: in-app poll + FCM registration
│   ├── studyos.js               the application itself
│   └── taskmirror.js            pushes tasks/events to TaskHub in Index
├── assets/                      app icons (192 / 512)
├── firebase/
│   ├── firestore.rules          deploy these
│   └── firebase-messaging-sw.js MUST end up at the SITE ROOT
└── workers/
    ├── studyos-files/           file storage on Workers KV
    └── studyos-api/             App Lock auth + reminder push cron
```

**Load order in `studyos.html` is load-bearing.** `config.js` first (everything
reads `window.STUDYOS_CONFIG` synchronously), then `ui.js` → `applock.js` (which
publishes `window.SOS_GATE`) → `firebase-sync.js` → `push.js` → `studyos.js`
(which waits on `SOS_GATE` before rendering) → `taskmirror.js` **last**, because
it reads `window._sosBridge` which `studyos.js` defines. Don't reorder them.

### What the app does

Classes, a calendar, tasks with reminders, quick notes, a Pomodoro timer, a KSU
module tracker, and per-class document storage. Data syncs across devices
through Firestore; uploaded files sync through Cloudflare Workers KV.

**It also pushes its dated tasks and events into Veda's weekly TaskHub, which
lives in a different deployment (the Index project).** That cross-app link is
the one part of this migration with a hard external requirement — see §3a. Read
it before configuring Firebase, because it decides which project you point at.

### Degradation is deliberate

With **nothing** configured, StudyOS still boots and works fully offline
(localStorage + IndexedDB). Each cloud feature switches on independently as you
configure it, and announces itself in the console when it can't. So you can
verify each step in isolation — a half-migrated project never throws.

---

## 2. Move it into V1

1. Copy this whole folder into Veda's V1 project. Keep the internal structure —
   `studyos.html` resolves `css/`, `js/`, `config/` and `assets/` relative to
   itself.
2. **Copy `firebase/firebase-messaging-sw.js` to the V1 web ROOT** (next to
   `index.html`, reachable at `https://<site>/firebase-messaging-sw.js`). A
   service worker can only control pages at or below its own path, and the FCM
   SDK looks for it at the root. Leaving it in `firebase/` means push silently
   never works.
3. If V1 already has sibling pages, add them to `config.js` §6 `shell.nav`:
   ```js
   nav: [{ label: 'Journal', href: '/journal.html' }]
   ```
   They render as header buttons. Leave it `[]` for a pure standalone app.

Serve it and confirm it loads before configuring anything:

```bash
# from the V1 project root
python -m http.server 8080
# open http://127.0.0.1:8080/StudyOS/studyos.html
```

**Expected at this point:** the app renders, you can create a class, and the
console says *"Firebase not configured — running local-only"* and *"App Lock is
on but the studyos-api Worker is not configured — running unlocked."* Both are
correct. If you see anything else, stop and fix it before continuing.

---

## 3a. Decide this first: which Firebase project?

StudyOS must reach the **same Firestore database as the Index project**, because
that is how it delivers tasks to TaskHub. Two documents carry the traffic, with
**exactly one writer each** so neither app can ever overwrite the other:

| Document | Writer | Reader | Carries |
|---|---|---|---|
| `dashboards/studyos_mirror` | StudyOS | TaskHub | every dated StudyOS task/event |
| `dashboards/studyos_mirror_ack` | TaskHub | StudyOS | done-state flips |

That single-writer split is not decoration. TaskHub saves its own document with
a **whole-document** `setDoc()`. If both apps wrote one shared document, the
later write would silently erase the other side's habits, goals, or same-day
edits. Do not "simplify" the two documents into one.

Pick one:

**Option A — one project (recommended, and much simpler).**
Point config §1 at the **Index** Firebase project. StudyOS's own data and the
mirror then share one project and one connection. Leave
`taskMirror.firebase: null`.
⚠️ **Do not deploy `firebase/firestore.rules` in this case.** The Index project
hosts a dozen other apps whose documents those rules don't list, and they deny
everything unlisted. The Index project's existing rules already cover
`dashboards/**`. Skip §3 step 4 entirely.

**Option B — Veda keeps her own project for StudyOS data.**
Config §1 points at her project; paste the **Index** project's web config into
`taskMirror.firebase`. StudyOS then opens a second, separate Firebase connection
just for the two mirror documents. Anonymous sign-in must be enabled on **both**
projects. Deploy `firestore.rules` to *her* project only.

If Veda does not want the TaskHub link at all, set `taskMirror.enabled = false`
and everything else in this guide still applies.

---

## 3. Firebase

Ask Veda to create a project at <https://console.firebase.google.com> (or use
her existing one), then:

1. **Firestore Database** → Create database → **Production mode**.
2. **Authentication → Sign-in method → Anonymous → Enable.**
   StudyOS signs in anonymously so there's no login screen. Without this, every
   read and write is denied and the app looks permanently offline.
3. **Project settings → General → Your apps → Web app** (`</>`). Copy the
   `firebaseConfig` values into `config/config.js` §1.
4. Deploy the rules — **only if you chose Option B in §3a**:
   ```bash
   firebase deploy --only firestore:rules
   ```
   …or paste `firebase/firestore.rules` into **Firestore → Rules → Publish**.
   Under Option A, skip this: publishing them to the Index project would break
   every other app living there.

> The web `apiKey` is **not** a secret — it's a public project identifier.
> Access is controlled by the security rules, not by hiding it. It's fine in a
> public repo.

**Verify:** reload StudyOS. The console message about Firebase should be gone,
and the sync pill in the sidebar should reach "saved" after you edit something.
Check Firestore for a `dashboards/studyos` document.

---

## 4. Cloudflare Worker — file storage

File **blobs** do not go in Firebase. Firebase Storage requires the paid Blaze
plan; Workers KV is free with no credit card. Firestore stores only the file
metadata and the URL.

```bash
cd StudyOS/workers/studyos-files
npx wrangler login
npx wrangler kv namespace create FILES     # paste the printed id into wrangler.toml
npx wrangler deploy
```

Put the deployed URL into `config/config.js` §2 `filesWorker.baseUrl`, and the
same URL into `wrangler.toml`'s `WORKER_ORIGIN`.

**Verify:**
```bash
curl https://studyos-files.<subdomain>.workers.dev/health
curl https://studyos-files.<subdomain>.workers.dev/usage    # {"bytes":0,"files":0,...}
```

Free-plan KV: 1 GB total, 25 MB per value, ~1000 writes/day. Files larger than
one value are split client-side into parts and reassembled by the Worker on GET,
so 25 MB is **not** a file-size limit — the app's own ceiling is 500 MB.

---

## 5. Cloudflare Worker — App Lock + reminders

```bash
cd StudyOS/workers/studyos-api
npx wrangler kv namespace create TOKEN_CACHE   # paste the id into wrangler.toml
# set FIREBASE_PROJECT_ID and ALLOWED_ORIGINS in wrangler.toml
npx wrangler deploy
```

Put the deployed URL into `config/config.js` §2 `apiWorker.baseUrl`.

Set `ALLOWED_ORIGINS` in `wrangler.toml` to Veda's real site origin (comma-separated
if there are several, e.g. `https://veda.github.io,http://localhost:8080`).
Leaving it `*` lets any page on the internet attempt password guesses against
the Worker.

**Verify:**
```bash
curl https://studyos-api.<subdomain>.workers.dev/health
# {"ok":true,"kv":true,"fcm":false}   ← fcm:false is expected until step 6
```

---

## 6. Formspree — password recovery

<https://formspree.io> → New Form → copy the endpoint into `config/config.js`
§3, and set `ownerEmail` to Veda's address.

Formspree emails a confirmation on the first submission — she must click it or
nothing is delivered. Free tier is 50 submissions/month, far more than password
hints need.

This powers two things: **"Forgot password?"** (emails the hint) and **"Reset
password via email"** (emails a 6-character code that expires in 15 minutes).

---

## 7. Push notifications

Only needed for reminders that fire while StudyOS is **closed**. In-app
reminders already work without any of this. To skip it, set
`config.push.enabled = false` and move on.

1. **Firebase console → Project settings → Cloud Messaging → Web Push
   certificates → Generate key pair.** Paste the public key into `config.js` §4
   `vapidKey`.
2. Fill the **same** Firebase values into the root
   `firebase-messaging-sw.js`. A service worker runs in its own global scope and
   **cannot** read `config.js` — this duplication is unavoidable, not an oversight.
3. **Project settings → Service accounts → Generate new private key.** From the
   downloaded JSON:
   ```bash
   cd StudyOS/workers/studyos-api
   npx wrangler secret put FIREBASE_CLIENT_EMAIL   # the client_email value
   npx wrangler secret put FIREBASE_PRIVATE_KEY    # the private_key value, BEGIN/END lines included
   npx wrangler deploy
   ```

**Verify:** `/health` now returns `"fcm": true`. Set a task reminder a couple of
minutes out, close the tab, and wait. Watch the cron with
`npx wrangler tail` — a healthy tick logs a single-digit document count.

> **Brave on desktop** ships with *Settings → Privacy and security → "Use Google
> services for push messaging"* **off**. In-app banners still appear; closed-app
> push silently will not arrive until that toggle is on. This is a browser
> setting, not a bug — check it before debugging anything else.

---

## 8. Turn the App Lock on

The lock is enabled in config but dormant until a password exists.

1. Click the 🔓 button in the header.
2. Choose a password; optionally set a hint.
3. Register biometrics if offered (Face ID / Touch ID / Windows Hello /
   fingerprint). The password always remains a fallback.

**How it behaves:** each device unlocks **once** and stays open. Changing the
password bumps a version that syncs through Firestore, so every *other* device
asks once more. The password itself never touches Firestore — only a salted
PBKDF2-SHA256 hash in the Worker's KV.

**Scope, stated honestly:** the App Lock gates the **UI**. It stops someone
picking up an unlocked laptop. It does not stop someone with the Firebase config
reading Firestore directly. That is appropriate for a personal single-user app
and matches how it originally shipped. If StudyOS ever holds more than one
person's data, replace the blanket `request.auth != null` rules with per-user
document ownership.

---

## 9. Test checklist

Work through this on a real device, not just localhost.

- [ ] App loads; no red console errors
- [ ] Create a class → appears on the dashboard and in the sidebar
- [ ] Add an event and a task → both show on the calendar
- [ ] Write a quick note → survives a reload
- [ ] **Cloud sync:** edit on one device, confirm it appears on a second
- [ ] **Upload:** attach a document to a class → the per-file pill reaches "synced"
- [ ] **Download:** open that file on a *different* device (proves KV, not just local IndexedDB)
- [ ] **Large file:** upload something over 25 MB → confirm it still opens elsewhere (exercises the chunked path)
- [ ] Storage meter in the sidebar shows a real used/total figure
- [ ] **Reminder:** set one a few minutes out, close the tab, confirm it fires
- [ ] **App Lock:** set a password → open on a second device → it prompts
- [ ] **Recovery:** "Forgot password?" delivers the hint by email
- [ ] **Reset:** "Reset password via email" delivers a code and sets a new password
- [ ] Change password → other devices ask once more; the old password is rejected
- [ ] Remove lock → no prompt on any device after refresh
- [ ] **Mobile** (390px): bottom nav visible, sidebar hidden, no horizontal scroll
- [ ] **Desktop** (1440px): sidebar visible, bottom nav hidden

**Task mirror → TaskHub** (open StudyOS in V1 and Index's TaskHub side by side):

- [ ] Create a task in StudyOS with a due date → it appears on that day in Veda's TaskHub, badged with the class name
- [ ] Create an event with a time → appears on its date with the time
- [ ] Rename the task in StudyOS → the title updates in TaskHub
- [ ] Move it to another date → it moves in TaskHub, no duplicate left behind
- [ ] Delete it in StudyOS → it disappears from TaskHub
- [ ] Tick it off **in TaskHub** → it shows as done in StudyOS
- [ ] A task with **no due date** never appears in TaskHub (correct — the weekly grid is date-keyed)
- [ ] One of Veda's **own** TaskHub tasks is untouched through all of the above

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Firebase not configured" in console | placeholders left in `config.js` §1 | fill them in; any value containing `‹REPLACE` disables that section |
| Everything works locally, nothing syncs | Anonymous auth not enabled | Firebase → Authentication → Sign-in method → Anonymous |
| `permission-denied` on every read | rules not deployed | `firebase deploy --only firestore:rules` |
| "Sync failed" and nothing loads | opened over `file://` | serve over http(s) |
| Files upload but won't open on another device | `filesWorker.baseUrl` wrong, or KV namespace id still a placeholder | check `/usage` returns JSON |
| Upload says "Cloud sync not set up" | files Worker unconfigured | step 4 |
| App Lock button does nothing | `apiWorker.baseUrl` unset — the lock stays dormant by design | step 5 |
| Hint email never arrives | Formspree confirmation not clicked | check the inbox for Formspree's confirmation |
| Reminders fire in-app but never when closed | VAPID key, root service worker, or service-account secrets missing | step 7; check `/health` says `fcm:true` |
| Push works everywhere except Brave desktop | Brave's push toggle is off by default | see the note in step 7 |
| Every read and write suddenly denied after it worked | App Check enabled without a valid site key | set `firebase.appCheck.enabled = false` |
| Write refused, "over the safe limit" | a single Firestore doc is nearing 1 MiB | StudyOS refuses at 900 KB on purpose — a hard rejection wedges the whole sync queue. Remove old data. |
| "Task mirror idle — Firebase is not configured" | §1 still has placeholders | step 3 |
| Tasks never reach TaskHub | StudyOS and Index are on **different** Firebase projects | §3a — either point §1 at the Index project, or fill in `taskMirror.firebase` |
| Mirror writes fail with `permission-denied` | mirror project's rules don't cover `dashboards/studyos_mirror`, or anonymous auth is off on that project | add the two `match` blocks from `firestore.rules`; enable Anonymous sign-in |
| Tasks appear in TaskHub but ticking them doesn't check them off in StudyOS | ack doc unreachable, or the item is an **event** (events have no done-state in StudyOS — correct) | check `dashboards/studyos_mirror_ack` exists and is writable |
| A StudyOS task shows on the wrong day | date-key mismatch | keys are `YYYY-MM-DD`, zero-padded, month 1-based — same as TaskHub's `dkey()`. Run `window._sosMirrorBuild()` in StudyOS's console and inspect `dateKey`. |
| Nothing in TaskHub until Veda edits something | first push not triggered | StudyOS pushes a full set on boot; force it with `window._sosMirrorNow()` |
| Every other app in Index broke after deploying rules | `firestore.rules` published to the **Index** project | restore the Index project's own rules; see §3a Option A |

---

## 11. Things that will look like bugs but are not

- **Two "not configured" info messages on a fresh install.** Expected until
  steps 3–5 are done.
- **The sync guard refuses to write until the first server read succeeds.** This
  is the fix for a bug where a refresh that fell back to the offline cache wrote
  the *stale* class list back over newer server data, permanently deleting files
  uploaded on another device. Don't remove it.
- **Remote snapshots are held and replayed rather than applied immediately.**
  Snapshots landing inside our own-save echo window are deferred, not dropped —
  dropping them meant a genuine update from another device could be lost for
  good.
- **iOS uses the single-tab Firestore cache manager.** The multi-tab manager
  elects a leader via an IndexedDB lease that iOS never releases when it kills a
  backgrounded PWA, so the next cold launch hangs. A home-screen PWA only ever
  runs one instance, so nothing is lost.
- **`window._vedaAddTask` and friends look like they do nothing.** They are one
  line each and only mark the mirror dirty. That is correct: the mirror is
  *derived* from `tasks` + `events` + `classes` on every write, not accumulated
  through those calls. `studyos.js` still calls them because they are its only
  signal that dated data changed — which is exactly why `studyos.js` needed no
  edits when the transport changed from in-page calls to Firestore.
- **The mirror re-sends everything, not a delta.** Deliberate. A derived,
  full-set write is idempotent and self-healing: a missed call, a crash
  mid-edit, or an edit made offline all reconcile on the next write. A delta
  stream would drift permanently.
- **TaskHub deletes mirrored items it doesn't recognise.** The mirror is the sole
  source of truth for anything tagged `_sosId`. If StudyOS no longer lists an
  item, it was deleted there and must go. Veda's own tasks carry no `_sosId` and
  are never touched.

---

## 12. If you change something

- Keep `config/config.js` the only place account values live.
- `STUDYOS_CONFIG_READY(section)` is how modules decide whether to activate. It
  returns false if any string in that section still contains `‹REPLACE`. Preserve
  that behaviour — it's what makes partial configuration safe.
- The App Lock's `SOS_GATE` promise is the app's boot gate. If you add another
  module that renders data, make it wait on `SOS_GATE` too, or a locked StudyOS
  will leak that data on screen before the overlay paints.
- **Never give the two mirror documents a second writer.** The whole no-clobber
  guarantee rests on one writer each. If TaskHub ever needs to send StudyOS more
  than done-flags, extend the *ack* document — don't let StudyOS write it.
- `window._sosBridge` (defined at the end of `studyos.js`) is the only supported
  way to read or write StudyOS's live `tasks` / `events` / `classes` from another
  script. They are top-level `let` bindings, so they exist in the global lexical
  scope and are **not** reachable as `window.tasks`.
- Two debugging entry points, both safe to call from the console:
  `window._sosMirrorBuild()` shows exactly what would be pushed;
  `window._sosMirrorNow()` forces a push immediately.
