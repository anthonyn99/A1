# TradeBoard cloud sync — your setup (DONE)

`tradeboard.html` syncs its data (portfolio, journal trades, strats/rules,
settings) across every device via **Firebase Firestore**, on your own project
**`tradeboard-6b2ea`**. No login screen — anonymous auth, with a single
**shared account id** (`veda`) so all your devices read/write the same data.

Status: **working and verified** (2026-07-18). Anonymous auth, read, and write to
`tradeboard/veda` all succeed; other paths are locked down.

## The security rule (already published)

Firebase console → project **tradeboard-6b2ea** → Firestore Database → Rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tradeboard/{accountId} {
      allow read, write: if request.auth != null;
    }
  }
}
```

## How it works

- **Firestore is the source of truth; `localStorage` is the offline cache.** The
  page opens instantly from cache, then reconciles from the cloud and re-renders.
- Every local write mirrors up (debounced). Remote changes stream down live via
  `onSnapshot` and refresh whatever section you're viewing.
- **Shared account id** is hardcoded near the top of the `TBCloud` module in
  tradeboard.html:  `const ACCOUNT_ID = "veda";`  — change it to keep a separate
  data set.
- The Webull `sync.meta` (last-sync time / source) is intentionally **device-local**
  and not synced.

## Using it across devices

Open `tradeboard.html` on any device (same file copied over, or hosted at a URL).
Because they all use `ACCOUNT_ID = "veda"`, they converge on the one shared
Firestore document `tradeboard/veda`. The first device to make a change seeds the
cloud doc; every other device pulls it on open and stays live-synced after.

> Note: opening the file directly via `file://` works, but some browsers restrict
> `localStorage` on `file://`. If a device seems not to persist, serving the file
> over http (even a hosted URL) removes that restriction. Say the word and I can
> set up hosting.
