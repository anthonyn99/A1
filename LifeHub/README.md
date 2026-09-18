# LifeHub

The A1 app switcher: a launcher (three app tiles and an accent diamond) in a program's header that opens a grid of
every A1 app. It is built **once**, in `lifehub.js`, and every program uses that one
file. Don't copy its code into a program, and don't fork it.

- Opening an app that is already open in another tab focuses that tab instead of
  opening a duplicate. It uses the same named-tab scheme and `tabsync.js` handshake
  as TaskHub's header buttons, with the same tab keys, so both open the same tab.
- Names, links, icons, order and visibility are data. You edit them in the popup
  (pencil, then tap an app; drag to reorder). They live in one Firestore document,
  `dashboards/lifehub`, and sync live to every program and device.
- It shows only while the host program is **unlocked**, and only in **Tony's**
  profile.

## Add LifeHub to a program

Two lines. Nothing else in the program changes.

```html
<!-- 1. In the header, where the icon should sit (usually last, after the lock button): -->
<a1-lifehub></a1-lifehub>

<!-- 2. Once, just before </body> (after tabsync.js): -->
<script src="LifeHub/lifehub.js" defer data-lock="#applock-overlay"></script>
```

| Script attribute | Needed when | Value |
|---|---|---|
| `data-lock` | always | CSS selector for the program's **existing** lock screen. While it is on screen the launcher is not rendered at all, so there is no empty slot. |
| `data-profile-attr` | the program has Tony *and* Veda profiles | the `<body>` attribute holding the active profile, e.g. `data-profile`. The launcher exists only while it reads `tony`. Leave it out for Tony-only programs. |
| `data-accent` | the program's accent isn't A1 gold | e.g. `#c0aeea` (RiftIQ, MAGI) |

Optional, on the element: `style="--lh-size:30px"` to match the header's other
icon buttons (default 34px). A program can place several `<a1-lifehub>` elements,
for example one in a desktop header and one in a mobile header. They share one popup.

Then add the program to `HOSTS` in `tests/lifehub-wiring.test.js`.

**A new program doesn't need a code change to appear in the grid.** Add it from the
popup (pencil, then **Add**). If you want it in the initial list for a brand-new
install, add it to `DEFAULT_APPS` in `lifehub.js` with its favicon in `ICONS`.

### Special cases

- **React headers** (TradeHub): write `<a1-lifehub style={{'--lh-size':'30px'}}></a1-lifehub>`
  in the JSX. It's a custom element, so it upgrades itself whenever React inserts it.
- **Firebase started lazily** (MAGI): set `window.LifeHubFirebase = () => Promise<{ db, fs }>`
  so LifeHub borrows the program's own Firestore. Otherwise LifeHub could create a
  default instance first and make the program's `initializeFirestore` throw.
- **Lock state not visible as an element**: call
  `LifeHub.configure({ locked: () => bool })`, or `profile: () => 'tony' | 'veda'`.
  `LifeHub.refresh()` re-checks immediately. Otherwise it checks every 500ms,
  locally, with no DOM writes unless the answer changes.
- **Programs outside a browser tab** use a link: `shieldopen:show` raises the
  Shield desktop agent's window. That's the "Shield" tile; "Shield (HTML)" is the
  page.

## Firebase cost (Spark plan)

| Action | Reads | Writes |
|---|---|---|
| Loading a program | 0 | 0 |
| First hover, focus or tap of the launcher | 1 (attach the one listener) | 0 |
| Another device changes the list | 1 | 0 |
| A save (drag drop, edit, add, delete, reset) | 1 (transaction) | 1 |
| Dragging, typing, toggling before save | 0 | 0 |

- Saves are batched for 350ms and committed in a transaction that re-applies the
  local change to whatever the server holds. Two devices editing at once merge
  instead of one erasing the other. A result identical to the server is never written.
- Tabs in the same browser update each other through `localStorage` for free.
- A remote change that arrives mid-drag or mid-edit is held until you finish,
  then merged under your change.
- LifeHub reuses the host's Firebase app and Firestore instance: same module URLs,
  no second connection.

## Data

`dashboards/lifehub`:

```js
{ v: 1, rev: <ms>, by: <client id>,
  apps: [ { id, name, url, icon, tab, hidden }, … ] }   // array order = display order
```

- `icon`: `a1:<key>` (a built-in A1 icon), an `https://` or `data:image/…` image,
  or `""` for automatic (the program's own icon, otherwise the site's favicon,
  otherwise a letter).
- `tab`: the named-window key. The built-ins match TaskHub's (`tradehub`,
  `warroom`, `vault`, `solace`, `magi`, `shield_tony`).

## Known limits

These are inherited from the browser, the same as TaskHub's buttons.

- A tab you opened yourself (bookmark, typed URL) has no name, so no web API can
  find it. The first LifeHub click opens a paired tab, and later clicks reuse it.
- After a browser restart, Chrome only lets a tab focus itself if it had recent
  interaction. Otherwise the old tab retires and yours loads fresh. You still end
  up with exactly one tab.
- A cross-origin link (e.g. Gmail) can't run `tabsync.js`, so it gets name
  pairing only.
