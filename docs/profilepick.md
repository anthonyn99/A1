# The profile picker (`profilepick.js`)

Since 2026-10-27, every program with profiles opens on the same screen. It is Shruti's
title screen: a breathing halo, a fine grain, the app's mark, its name (Manrope 600),
a thin rule, a spaced line saying what the app is for, "Who goes there?", and one
frosted card per person with their emblem glowing in their colour (Tony's fleur-de-lis
in `#c0aeea`, Veda's star in `#b79fc4`).

| Program | Title | Line under it | Corner of each card |
|---|---|---|---|
| Index (`index.html`) | TaskHub | Plan · Remind · Journal · Reflect | none (passwords are managed in each profile's settings, not here) |
| MyList | MyList | Speak · List · Shop · Cook | ★ default on this device |
| Shield | Shield | Guard · Watch · Lock · Recover | ★ (names stay **T** and **V**, per Shield's brief) |
| MAGI | MAGI | Ask · Deliberate · Decide · Build | ★ |
| Shruti | Shruti | Read · Listen · Watch · Study | ★ |
| ORCA (Veda's repo) | ORCA | Route · Balance · Answer · Watch | none |

## How a program uses it

```js
const pick = A1Pick.mount(overlayEl, {
  app: 'mylist', title: 'MyList', sub: 'Speak · List · Shop · Cook',
  profiles: [{ id: 'tony', label: 'Tony' }, { id: 'veda', label: 'Veda' }],
  state: (id) => ({ fav, locked, last, off, note, noteIcon, tone }),
  onChoose: (id) => {}, onStar: (id) => {},   // or onLock for a padlock corner
});
pick.refresh();   // after anything state() reads changes
```

- The program keeps its own logic: who is chosen, the lock (Guardian), the favourite,
  and when the overlay shows (`hidden`, `display` or a body attribute). The file only
  draws the screen.
- Cards are built once and refreshed in place, so tapping the star doesn't replay the
  entrance animation.
- `app` picks the mark from `apphead.js`, which must load first. `domId` gives a card an
  id (Shield keeps `pf-t`/`pf-v`; Index keeps `card-tony`/`card-veda`).
- Change the look here, once, for every program. The exception is ORCA, which is
  server-rendered on its own origin, so it carries a port of this CSS in `app.css`
  section 11 (same class names as before, so `lock.js` and the no-JavaScript forms
  are unchanged). A change to the look goes there too.

## Tests

- `node tests/profilepick-wiring.test.js`: every host loads and mounts it, and has
  its own line.
- `node tests/live/profilepick-shots.live.js`: opens all five A1 pickers with empty
  storage and checks the title, weight, line, question, cards and phone width, with
  screenshots in the temp folder.
