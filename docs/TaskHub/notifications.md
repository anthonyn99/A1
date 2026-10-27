# TaskHub notifications: how a reminder reaches a phone

Read this before touching reminders in `index.html`, `firebase-messaging-sw.js`
or `workers/taskhub-reminders`. `tests/notif-series.test.js` and
`tests/notif-delivery.test.js` pin everything below.

## The path

1. **The client writes cloud docs.** `_fcmScheduleNotif` writes one doc per
   occurrence to Firestore `reminders/<series>_<ms>`. A repeating series is
   pre-expanded about 21 days ahead (monthly and annual keep the next 3).
2. **The client re-arms.** `_fcmRearmSeries` runs once every 24 h per device
   and rewrites every **live** series from the device's task data.
3. **The worker sends.** The cron in `workers/taskhub-reminders` (`runReminders`)
   pushes data-only FCM to every device whose `fcm_tokens.mainDash` matches the
   doc's `dashboard`.
4. **The device draws it.** The service worker draws the OS card, gated on the
   device's main dashboard. With the tab open, the on-device poll
   (`scanAndRegister` / `poll`) also shows the in-app banner.

## Which series are live: `thNotifyPlan`

A repeating task's reminder series is stored on **one row**, its first
occurrence (`pushOcc` in `savItem`). Every later row is a display-only badge
(`_notifyView`). Deleting future days or re-making the task leaves that first
row in the past, still holding the old series.

`window.thNotifyPlan(dayMap, habits)` is the one rule every scanner uses:

- A series is **live** if its task (`repeatId`) still has a day today or later.
  A repeating reminder on a one-off row is always live, **unless** a repeating
  task's rows also hold that series id. Then the row was cut out of the task (a
  "This day only" title edit copies the series), so it does not own the series
  and the task decides. Before 2026-10-26 such a row kept a finished weekly task
  ringing ("Put out trash bins, bring Hacao...").
- If several rows hold the same series id, the one that defines it is the
  latest row on or before today, or else the earliest upcoming one. It is
  **not** simply the latest row: rows saved before July 2026 all carry the
  series, and the last of them can be a year away.
- A series held only by dead rows is **dead**. So is a habit whose reminder was
  switched off.

Users: the re-arm (only live series), the on-device poll (live only, and it
drops registry entries for dead ones) and `_fcmDedupSweep`. The sweep deletes
the cloud docs of dead series, but only for a profile whose cloud data has
loaded this session (`_thCloudLoaded` / `_vdCloudLoaded`).

## Editing a repeating reminder (Tony's TaskHub)

If you change a reminder's time on a repeating task, or switch it on or off,
you're asked "This day only / All future repeats":

- **All future** runs `thSeriesNotifyEdit`. From that date (or from today, if
  the date is ahead) the first row becomes the series' defining row at the new
  time, and later rows become badges. Older rows stop defining it.
- **This day only** turns that row into a one-off reminder and cancels that
  date's series doc. If the row was the defining one, the series moves to the
  next date.

Veda's editor already moves the cloud series from the edited row, so it is left
as it is.

## Worker timing

Cloudflare runs `* * * * *` at a fixed second inside each minute (**:43** for
this worker, measured 2026-10-13), then starts the handler up to ~20 s later.
It does not run at :00.

- `classifyReminder` takes every reminder due **before the next tick**.
  `holdFor` then waits inside the tick until its exact minute (MAX_HOLD_MS is
  70 s).
- A tick that runs late still **sends** anything up to `LATE_SEND_MS`
  (10 min) late. Only reminders older than that are marked fired without
  sending.

Before this, every push was 60–110 s late. Anything over 90 s late was silently
dropped: "Put in trash bins" was due 11:00:00 and swept at 11:01:49.

## Diagnosing live

- **Worker logs:** `npx wrangler tail taskhub-reminders --format json`, run
  from the worker folder. Wrangler is logged in on Tony's PC.
- **The real `reminders` / `fcm_tokens` docs:** App Check is enforced, so REST
  and headless browsers are refused. A **headed** Edge, placed off-screen
  (`--window-position=-32000,-32000`) and opened on
  `https://anthonyn99.github.io/A1/`, gets a token: import the Firebase SDK
  into the page, sign in anonymously, and query.
- **Timing probe:** write a doc with `dashboard:'zz-probe'` (no device
  matches it, so nothing is pushed), then compare `firedAt` to `notifyAt`.
  On 2026-10-13 it was 0 ms late.
