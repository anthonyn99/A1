# Popups (popups.js)

How every popup in A1 sits on the page, in every program, on both sides.
Since 2026-11-03.

Tony asked for TaskHub's "New — <date>" window to set the rule for every
popup in Index and every A1 program (LifeHub's list, not counting Reserv). He
also asked that a click outside a popup close it, but that a press which starts
inside the popup and is let go outside (selecting text) never does.

## The rule

- **The look.** The backdrop behind every popup is `rgba(0,0,0,.6)` with
  `backdrop-filter: blur(7px) saturate(.9)`. This applies on both sides and in
  every program, including StudyOS, Wellness, Vault and ORCA.
- **A click outside closes it.** The click must start *and* end on the
  backdrop.
- **A drag never closes it.** A press inside that is let go on the backdrop,
  or the reverse, is stopped before the program's own backdrop handler sees it.

## How it works

`popups.js` is one script in each program's `<head>`. You don't write anything
per popup:

1. **Finding a backdrop.** It finds backdrops by what they are, not by their
   class name. A backdrop is an element that is `position:fixed`, covers the
   viewport, and has a see-through background (alpha between 0.04 and 0.97) or
   already blurs. It is tagged `data-a1-scrim`, and the shared rule overrides
   the program's own colour and blur. Elements are checked when they are added,
   when their `class`, `style` or `hidden` changes, and in full-page scans at
   load, 1.5 s and 5 s. A hidden popup is judged by its `inset`, so it is tagged
   before it ever opens.
2. **What is left alone:** a clear layer (a menu's click-catcher), a solid one
   (a page or a title screen such as the profile picker), and one with
   `pointer-events:none` (a glow or grain layer).
3. **Closing on an outside click.** First the program's own handler runs. If
   the popup's attributes (and those of its ancestors) have not changed 60 ms
   later, an Escape keydown is sent into the popup. If it is still open after
   that, its Close / × / Cancel / Dismiss / Back button is clicked. A popup
   with none of these stays open.
4. **The drag guard.** A capture-phase `click` listener on `window` stops any
   click that lands on a backdrop unless the `pointerdown` and the `pointerup`
   were both on that backdrop. A full-size clear wrapper between the backdrop
   and the box counts as backdrop.

## Opting out

| Attribute | Effect |
| --- | --- |
| `class="a1-scrim"` | Forces the look on a backdrop that isn't found automatically |
| `data-a1-popup="keep"` | The popup keeps the look but stays open on an outside click |
| `data-a1-popup="off"` | The subtree gets neither the look nor the closing |

Guardian's lock is in a shadow root, so popups.js never sees it. It carries the
same look in its own CSS (`Guardian/guardian.js`, `.ov`) and never closes on a
click.

## Where it is loaded

A1: `index.html`, `magi.html`, `mylist.html`, `shield.html` (also the Shield
desktop app, which loads that page), `Shruti/shruti.html`, `V1/studyos.html`,
`V1/wellness.html`, `backup-restore.html`, `backup-export.html`.

A1-Priv: `everwell`, `insight`, `oneinbox`, `riftiq`, `tradehub`, `vault`
(all `.html`).

ORCA: `app/web/templates/base.html`, `_picker_base.html`, and
`worker/src/web/html.ts` (`POPUPS_SRC`).

**A new program gets the tag the day it ships**, next to `controls.js`.
`tests/popups-wiring.test.js` lists the pages and fails when one of them is
missing it.

## Testing

- `node tests/popups-wiring.test.js` checks that every page loads the script
  in `<head>`.
- `node tests/live/popups.live.js` covers each kind of popup on a fixture
  (React-style, Escape-only, Cancel-only, class-toggled, wrapper, keep, added
  later), then opens every program and checks that nothing on screen at load
  was taken for a popup.
