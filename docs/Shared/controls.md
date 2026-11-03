# A1's own form controls (`controls.js`)

Since 2026-11-02 no A1 program shows a control drawn by the browser. Tony asked for "clean ergonomic custom, our own, UI", the same look and feel in every program, on both sides. One file, `controls.js` at the A1 root, does it for every program. It grew out of Vault's `Vault/vault-controls.js`.

## What it replaces

| Browser control | A1's |
|---|---|
| `<select>` popup | A1 list: keyboard, type-ahead, finger-sized rows on a phone. The select stays in place, so the page's own styling, React state and `onchange` all keep working. A select that still looked native also gets A1's chevron. |
| `date`, `time`, `datetime-local` | A1 button + calendar (day / month / year views, Today, Clear, min/max) / clock (hour, minute, AM-PM columns). |
| `<input list>` dropdown | A1 suggestion list. |
| `color` (and its system dialog) | A1 colour picker: shade square, hue bar, hex field, swatches. Code that calls `input.click()` (Notebook's "Custom colour…") gets it too. |
| checkbox, radio, range | Restyled. A box keeps its page's `accent-color` (gold stays gold); otherwise it takes the side's accent. |
| number spinners, search ✕, autofill colours, `<details>` triangle | Gone or restyled. |
| `title=""` tooltip | A1 tooltip (mouse and pen). The title comes off only while the pointer is over the element, so code and tests that read it still see it. |

## Rules

- **Load it in `<head>`, right after `scrollbar.js`, before any React render.** It hooks the input `value` setter on the prototype. React's value tracker wraps whatever setter is there when it first tracks an input, so the hook must come first. `tests/controls-wiring.test.js` enforces this for every program; add a new program to its `PAGES`.
- **Never restyle what the page already draws.** A checkbox, radio, range or select whose page set `appearance: none` (OneInbox's toggle switches, MyList's selects) keeps its look. Only its popup changes.
- **Never write into a document.** A checkbox inside a `contenteditable` (Notebook checklists) is restyled by CSS alone. No class or attribute is added, so nothing gets saved into an entry.
- **Colours come from the page.** A popover takes the background of the box it opened from, the control's text colour and its font. So Tony's dark panels, Veda's Nunito look and her light TaskHub each get a fitting list. The accent is Tony's purple `#c0aeea`, or Veda's mauve (`#A892B0` on dark, `#8D769A` on light). She counts as Veda when `data-profile` / `data-th-profile` = `veda` is on `<body>` or `<html>`, or the control is inside `#veda-root`. A page or box can set `--a1c-accent` to change the accent.
- **Popovers open in the browser's top layer** (popover API), so no modal's `overflow` or `transform` can clip them. In the DOM they sit inside the control's nearest fixed layer (the modal), so the modal's outside-click checks still count a pick as inside. Escape closes the list, not the modal.
- **A popover's clicks and keys stay inside it.** Pointer, click and key events stop at the popover. Keys the list handles (arrows, Enter) stop at the window. Without this, a tap that rebuilds or closes the popover reaches the modal as an "outside" click: Clear or a day closed the whole Add-task window (2026-11-02), and Enter in a list could reach a modal's Enter-to-save. Popovers also opt out of `hoverfx.js` and harden their buttons against page button rules.
- **Nothing in a picker scrolls or moves under the pointer.** The clock shows the time, hour and minute grids, and AM/PM all at once.
- **A ticked box shows a tick mark**, a fixed-px masked check. A percentage size collapses to 0 inside the grid box.
- **Opt out** with `data-native` on an element or a subtree.

## Per-page tags

- Two-profile pages (index, MAGI, MyList, Shield, Shruti) use a plain tag. The side follows the page live.
- Veda-only pages: `<script src="controls.js" data-profile="veda">` (Wellness, StudyOS).
- StudyOS already has its own controls (`V1/StudyOS/js/controls.js`), so there it adds `data-scope=".sos-nb-host,.sos-nb-modal-host"`. That limits it to V's Notebook, which StudyOS's controls skip.
- A1-Priv pages load it from `https://anthonyn99.github.io/A1/Shared/controls.js`.
- **Vault** keeps `vault-controls.js`, and `controls.js` stands down when that is present.

## Proving a change

`node tests/live/controls.live.js` runs two parts:

- A fixture with every control type, including React-controlled ones, a page-drawn toggle, a gold box, Veda's light side and a clipping modal. It checks mouse, keyboard and touch.
- An audit of every program on desktop and phone, and on Veda's side, that lists any control the browser still draws.

To see TaskHub's task editor (Category, AI Prep, Remind me), open it on each side through `window._profileGoTony()` / `_profileGoVeda()` and the "Add a task or event" button. Hide `#th-boot-loader` first: tests block Firestore, so the boot veil stays up.
