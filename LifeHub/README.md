# LifeHub

The A1 app switcher: a launcher (three app tiles and an accent diamond) in a program's header that opens a grid of
every A1 app. It is built **once**, in `lifehub.js`, and every program uses that one
file. Don't copy its code into a program, and don't fork it.

- Opening an app that is already open in another tab focuses that tab instead of
  opening a duplicate. It uses the same named-tab scheme and `tabsync.js` handshake
  as TaskHub's header buttons, with the same tab keys, so both open the same tab.
- Names, links, icons, order and visibility are data. You edit them in the popup
  (pencil, then tap an app; drag to reorder). Each profile has its own list in one
  Firestore document: `dashboards/lifehub` for Tony and `dashboards/lifehub_veda` for Veda.
  Lists sync live to every program and device.
- A link can be a web URL **or a program on the PC** (`C:\Apps\app.exe`, a
  `\\server\share` path). See [Local programs](#local-programs).
- It shows only while the host program is **unlocked**. In programs with both
  profiles (MyList, Shield) it follows the active profile and shows that person's
  list in their accent colour.

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
| `data-profile-attr` | the program has Tony *and* Veda profiles | the `<body>` attribute holding the active profile, e.g. `data-profile`. `tony` shows Tony's list and `veda` shows Veda's. Any other value hides the launcher. Leave it out for Tony-only programs. |
| `data-accent` | the program's accent isn't A1 gold | e.g. `#c0aeea` (RiftIQ, MAGI) |
| `data-accent-veda` | Veda's accent differs from the default | default `#A892B0` |

Optional, on the element: `style="--lh-size:30px"` to match the header's other
icon buttons (default 34px). A program can place several `<a1-lifehub>` elements,
for example one in a desktop header and one in a mobile header. They share one popup.

Then add the program to `HOSTS` in `tests/lifehub-wiring.test.js`.

**Updates arrive on a plain refresh.** GitHub Pages lets browsers cache this file
for 10 minutes, so on load LifeHub checks with the server whether it is current.
That's a conditional request, normally a bodiless `304`. If a newer version is
deployed, it runs that one instead, under a one-off URL with the same `data-*`
attributes. If the check is offline or slower than 1.5s, the cached copy runs.
Code that needs `window.LifeHub` after page load should wait for the
`lifehub:ready` event on `window`.

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

## Local programs

A browser can't start a program. So a tile whose link is a local path does what
TaskHub's local External Links do (`index.html` `_doOpen`): it hands off to the
**Shield desktop agent**.

1. The tile sends `shieldopen:lh:<profile>:<id>`, which is an opaque id, not the path.
2. In the agent, `shield.html` calls `LifeHub.localLinks(cb)`. That reports
   `{ 'lh:<profile>:<id>': path }` for both profiles, from the lists LifeHub already
   listens to. `shield.html` pushes the map into the agent with `sh_set_links`,
   merged with the navorder and StudyOS entries.
3. The agent looks the id up and opens the path. A page that only knows the
   scheme can't make it launch anything that isn't already in a list.

Inside the agent's own window, `shield.html` sets `LifeHub.configure({ openLocal })`.
Executables start directly through `sh_launch`, and the Shield tile is that window
itself. The **Shield** tile is the agent's installed exe
(`%LOCALAPPDATA%\Shield\shield-agent.exe`). Starting it again brings the running
agent's window forward. Lists saved with the old `shieldopen:show` link are moved
to the path automatically, in one write.

The path check is identical in `lifehub.js`, `index.html` and `shield.html`, and
the test enforces it. Pasted paths are cleaned up: quotes from Explorer's "Copy as
path" are removed, `file:///C:/…` is converted, and control or forbidden characters
are refused. On phones and Macs, local tiles are hidden outside edit mode because
they can't work there. If Shield isn't installed or running, a click does nothing,
the same as any unhandled protocol.

## Firebase cost (Spark plan)

| Action | Reads | Writes |
|---|---|---|
| Loading a program | 0 | 0 |
| First hover, focus or tap of the launcher | 1 (attach the one listener) | 0 |
| Another device changes the list | 1 | 0 |
| A failed connection attempt (and each automatic retry) | 0 | 0 |
| The Shield agent (only on PCs that have one) | 1 per profile list at startup, then 1 per change | 0 |
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
- **Offline.** A failed connection shows *Offline* with a refresh button. It also
  retries on its own after 2s, 5s, 15s, 30s and then every 60s, and immediately
  when the browser comes back online or the tab returns to the front. It only
  retries while someone can use the result: the panel is open, there are unsaved
  changes, or the Shield agent is watching. An idle program never polls. A
  generation counter makes sure a retry can't leave a second listener attached.

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
