# Beacon: A1's device manager

Beacon shows every device a program runs on or sends notifications to, with its model, its notifications and the state of each Guardian lock there. Tony and Veda can rename, lock or remove any of their devices from it. It is two files in [Beacon/](../../Beacon/):

- `beacon.js`, the core: the device's id, what the device is, check-in, remote commands and the API.
- `beacon-ui.js`, the panel. `beacon.js` loads it the first time someone opens the panel.

A program never builds a device list of its own. It loads `beacon.js` and declares itself, as it does with Guardian. Changing these two files changes the panel in every program. Since 2026-11-15.

## Where it runs

Every A1 program that has profiles or sends notifications:

| Program | App id | Button | Profile | Notifications |
|---|---|---|---|---|
| TaskHub (index, both sides) | `taskhub` | Settings ▸ Devices ▸ Manage | `window._activeProfile` | `fcm_tokens/<th_device_id>` |
| MyList | `mylist` | the devices icon in the top bar | `body[data-profile]` | the same `fcm_tokens` doc as TaskHub |
| MAGI | `magi` | the devices icon beside Help (sidebar; the drawer on a phone) | `html[data-profile]` | none |
| Shield | `shield` | Devices ▸ All A1 devices ▸ Manage | `body[data-profile]` | none |
| Shruti | `shruti` | Settings ▸ Profile ▸ Devices | `body[data-profile]` | none |
| TradeHub (A1-Priv) | `tradehub` | Control ▸ Alerts ▸ Devices | always `tony` | its own `dashboards/tradehub_push_tony` (`devices.<id> = { token, on, ua, at }`), registered from the panel (`alerts`); its push worker `TradeHub/push-sw.js` (2026-11-21) |
| StudyOS (Veda) | `studyos` | none (no profiles; managed from TaskHub's Settings, 2026-11-17) | always `veda` | its own `studyos_fcm_tokens/<token>` |
| ORCA (Veda's repo `DesktopORCA`, both UIs) | `orca` | the devices icon after the lock in the header | `body[data-profile]` (only rendered once a profile is open) | none; its lock is a server session, so `app/web/static/beacon-host.js` hands Beacon `lockState` (`/lock/status`) and `lockNow` (`/lock/lock`, then the gate) |

Left out on purpose:
- Insight, Vault, RiftIQ, Everwell and OneInbox have one profile and send no notifications.
- Wellness has a nightly reminder switch, but nothing sends it: no worker reads `remindersEnabled`. If that push is ever built, mount Wellness.

## Adding it to a program

1. Load the one live file, unpinned, in `<head>`. In A1: `<script src="Beacon/beacon.js"></script>`. Anywhere else: `https://anthonyn99.github.io/A1/Beacon/beacon.js`. Never add `?v=` and never copy the file.
2. Declare the program:

```js
Beacon.mount('example', {
  label: 'Example',
  profileAttr: 'data-profile',        // or profile: 'veda', or profile: () => current
  push: () => ({ on, coll, id, route }) // only if it sends notifications (see below)
});
button.onclick = () => Beacon.open({ app: 'example' });   // the panel
```

3. Add the page to `HOSTS` in `tests/beacon-wiring.test.js`.

### `mount(app, options)`

| option | meaning |
|---|---|
| `label` | the program's name in the panel |
| `profile` | `'tony'`, `'veda'`, or a function that returns one. Anything else (the picker is up) means "not yet", and nothing is recorded |
| `profileAttr` | follow this attribute on `<body>` or `<html>` instead; a change triggers a check-in |
| `push()` | this device's push state: `{ on, coll, id, route, perm }`. `coll`/`id` name the token's Firestore doc, which Remove deletes. `route` is TaskHub's main (`none` = neutral). `perm` defaults to `Notification.permission` |
| `fcm: true` | the program notifies through TaskHub's `fcm_tokens`, so the panel's program view also shows devices known only by such a token |
| `pushList` | `{ coll, app, label, owner }`: a token collection of the program's own for the panel to read (StudyOS) |
| `firebase` | `() => Promise<{ db, fs? }>`, the program's Firestore, or `'lifehub'` to wait for `window.LifeHubFirebase` (MAGI, Shruti, StudyOS). Default: `LifeHubFirebase` if set, else the page's `[DEFAULT]` app if it is A1's project, else a memory-cache app of Beacon's own |
| `onRemoved()` | the program's own clean-up when this device is removed |
| `lockState(profile)` | for a lock that is not Guardian's markers: resolves `[{ id, label, owner, open, bio }]`, added to the Guardian locks Beacon reads itself (ORCA) |
| `lockNow(reason)` | locks this device the program's own way when a Lock or Remove arrives (ORCA ends its session); runs last, since it may leave the page. A page with `lockNow` carries out commands even without Guardian |
| `alerts` | a program's own alert registrations (TradeHub, 2026-11-21, after RESERV's per-device switches): `{ label, get(profile) → { <deviceId>: { token, on } }, set(profile, deviceId, on), register() → { ok, why? } }`. The panel then says at the top whether THIS device is registered (Register / Re-register) and gives every device a line with its on/off switch |
| `delay` | ms before the first check-in (default 3000, after the program has booted) |

### API

| call | what it does |
|---|---|
| `open({ app, profile })` | the panel. `profile` defaults to the program's current one; with none, nothing opens |
| `refresh(app?)` | check in again soon (after a profile switch, a new push token, a new main) |
| `deviceId()` | this device's id |
| `list(profile, { pushLists })` | the devices the panel shows (below) |
| `rename(owner, id, name)`, `setKind(owner, id, kind)` | the name and the icon (`phone`, `tablet`, `laptop`, `desktop`) |
| `lock(owner, id, by)`, `cancel(owner, id)` | send or take back a Lock |
| `remove(device)` | Remove (below) |
| `detect(nav, screen, extra)`, `defaultName(meta)` | what a device is (pure; the tests use them) |

Events on `window`: `beacon:ready`, `beacon:checkin`, `beacon:locked`, `beacon:removed`.

## The data

Firestore has one document per owner: `dashboards/beacon_tony`, `dashboards/beacon_veda` and `dashboards/beacon_neutral`.

```
devices.<id> = { meta, first, seen, name?, kindSet?,
                 apps.<app> = { label, seen, profs: {tony: t, veda: t}, push?, locks: [{id, label, owner, open, bio}] } }
cmd.<id>  = { lock: t, by }      a Lock waiting for that device
gone.<id> = t                    a Remove waiting for that device
```

- **The id** is TaskHub's `th_device_id`, so a record and its `fcm_tokens` doc share one key. It is mirrored in a 400-day cookie (`a1dev`), so a browser that loses localStorage keeps its id. If nothing can be stored at all (Veda's storage-blocked Brave), a fingerprint of the browser keeps the id stable.
- **What the device is.** Browsers never give a device's name, so it is named after its model until someone renames it:
  - iPhone: the model family from the screen size ("iPhone 16 Pro / 17"); iOS from Safari's `Version/`, because Safari 26 freezes "OS 18_6" in the agent string.
  - iPad: told apart from a Mac by touch.
  - Android: model and version from client hints (Chrome's agent string always says "Android 10; K").
  - Windows: 10 or 11 from client hints.
  - Browser: from client hints and `navigator.brave`.
  - Laptop: a battery seen below full, or a Windows touch screen.
  - A device known only by a push token is read from its 80-character agent string. In that string an iPad is indistinguishable from a Mac.
- **Writes are cheap.** A program checks in about 3 s after load, then on focus and every 5 minutes while visible. It reads at most once per 90 s. It writes only when something changed (a lock, push state, the model) or the record is 6 h old. `updateDoc` with dotted paths replaces exactly the fields it names, so two devices never overwrite each other.
- **Not recorded:** loopback and `file://` pages. MAGI's console on the PC would otherwise be a second, differently keyed copy of the same machine.

## Whose device it is

On A1's origin, **TaskHub's main decides**. That is the one link A1 already keeps between a device and a person:
- main `tony` or `veda`: that person's device;
- main `none` (Settings ▸ Un-main): a **neutral** device.

A device TaskHub never claimed belongs to whoever first used it there (cached in `a1.beacon.owner`); StudyOS's origin is always Veda's. When the main changes, the record moves documents at the next check-in.

The panel for a person reads **their document and the neutral one, never the other person's**. A push token routed to the other person is skipped. Lock rows show only the viewer's locks. A device used by both, with Tony as main, is Tony's; Veda's use of it does not put it in her list.

## Lock and Remove

- **Lock** leaves `cmd.<id>`. The next time any A1 program with Guardian opens on that device, it calls `Guardian.lockDevice()`: every unlock on the device goes, for every program, and each one asks for its password. A page without Guardian leaves the command for one that has it. Locking this device happens at once. A pending Lock shows on the card, with Cancel.
- **Remove**:
  1. It deletes the device's push tokens at once, so notifications stop now.
  2. It drops the record and leaves `gone.<id>`.
  3. At its next check-in the device locks every program (`lockDevice`) and runs each program's `onRemoved`, then clears the tombstone. It stops checking in for that session, in every tab already open (`a1.beacon.removedAt`).
  4. Opening A1 there later adds it back, behind its passwords. Removing this device does all of that at once.

## The panel

- **Structure:** a shadow root, so no program's CSS reaches in and none leaks out. It sits under Guardian's card (z-index 2147482500), so a lock can come up over it.
- **Look:** Tony gets Guardian's MAGI tokens; Veda gets her TaskHub palette with Lora titles. The backdrop is the `popups.js` look. There are no fades: it opens and closes instantly.
- **Closing:** a click that starts and ends on the backdrop closes it; a drag does not. Escape closes an open question first, then the panel.
- **Layout:** a centred sheet on desktop and tablet; a bottom sheet on a phone, with 44px targets and safe-area insets.
- **What it shows** (redesigned 2026-11-15 for Tony: quieter, rows that open):
  - A summary under the title: how many devices, how many are active now, and how many get notifications. Below it, "*Program*" or "All programs".
  - Your devices, then neutral ones, each section one surface with a row per device; this device first, tagged.
  - A row: icon (green dot = active in the last 10 minutes), name, "Active now" or how long ago, the model line, and glyphs for its notification and lock state.
  - Tap a row to open it: per program, notifications, locks (each lock and whether biometrics are set up) and when it was last active; first and last seen in full ("Thursday, November 12, 1:48 PM"); and its actions.
  - Devices not seen for 60 days fold into **Inactive** (closed; Show, and Remove all with one confirmation). A push token with no agent string reads "Unknown device · Known only by its notification token".
- **Actions:** Rename (name plus type) and Lock / Remove, each asked inline in the open row. Every button keeps text contrast of at least 4.5 at rest and hovered (the live test measures it).
- **Scrolling:** its own thin thumb, A1's look, dragged with pointer capture. A1 hides native bars (`Shared/scrollbar.js`, which cannot reach into a shadow root), and the browser's own bar in the shadow root would not drag in Brave.
- **Live:** it listens to the two documents while open; a form being typed in is never redrawn.

## Tests

- `node tests/beacon.test.js` (jsdom). Several devices are separate windows on one in-memory Firestore. It covers detection, the id, owner rules, check-in and its throttle, the profile wall, push tokens, Lock / Remove / Rename across devices, the real `Guardian.lockDevice`, and the panel in both themes.
- `node tests/beacon-wiring.test.js`: every host loads the one unpinned file, mounts with its app id, and has a button that opens the panel.
- `node tests/live/beacon.live.js`: real headless Edge on TaskHub, using the fake Firebase (`tests/live/fake-firebase.js`). It opens Settings ▸ Devices on both sides at desktop, tablet and phone sizes, and saves screenshots.
