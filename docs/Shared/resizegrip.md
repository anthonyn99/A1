# Resizing (resizegrip.js)

How things are resized by hand in every A1 program, through
[Shared/resizegrip.js](../../Shared/resizegrip.js) (`window.A1Resize`). Load it in
`<head>`, unpinned, like the other `Shared/` files.

There are two tools in the file. Use the one that fits the job and never
build a third in a program.

## The corner grip: text boxes (since the theme overhaul, 2026-09)

MAGI's grip, for a box whose **height** is chosen by hand (prompt boxes,
notes, journals).

- `A1Resize.grip(label)` makes the button. `A1Resize.attach(box, grip, key, onAuto)`
  wires it to the box.
- A drag sets the height, between 26px and `A1Resize.cap()`
  (`max(160px, 60% of the viewport)`). A click does nothing.
- Enter or Space toggles between expanded and auto.
- The height is kept per `key` in localStorage (`a1.h.<key>`). Storage that
  throws (Veda's Brave) is fine.
- A hand-sized box carries `data-user-h`, so an auto-grow routine can leave it
  alone.
- The box's parent must be positioned.

## Edges: every edge and corner (since 2026-11-18, TradeHub Quant R1)

For a box whose **size is decided by its caller**, such as a card on a grid
that snaps to units. Tony asked for "resize from any side".

```js
const e = A1Resize.edges(box, {
  label: 'Breadth',                   // the se button's aria-label: "Resize Breadth"
  onStart(edge) {},                   // 'n' 's' 'e' 'w' 'ne' 'nw' 'se' 'sw'
  onMove({ edge, dx, dy }) {},        // px from the press
  onEnd(edge) {},
  onKey(dx, dy) {},                   // the se button's arrow keys: -1 / 0 / +1
});
e.destroy();                          // takes the handles away
```

- **Eight handles** are appended to the box (it must be positioned): thin
  bands on the four edges (7px) and hot spots on the four corners (14px),
  each with its resize cursor. On a coarse pointer (touch) the bands are 14px
  and the corners 24px.
- **The handles only report the drag.** The caller turns `dx` / `dy` into a
  size. For example, TradeHub's grid rounds to grid units and treats a `w` or
  `n` drag as growing the card (`-dx`, `-dy`) in place. Nothing is stored.
- **The se corner is a real button.** It is focusable, carries the aria-label
  and a faint hatch so the handles can be found, and its arrow keys call
  `onKey`. The other seven are `aria-hidden` divs.
- **A press on a handle stops there.** It never starts a drag of the box
  (dragsort.js) underneath. Give the handles' class `.a1-edge` to the
  drag's `ignore` too.
- **No click listener on the bands.** A click listener made Chrome's touch
  adjustment snap a finger pressed on a card's title, 7px away, onto the top
  band, so the card was resized instead of moved (2026-11-18). Only the se
  button swallows its click.

## Tests

- A1 `tests/resizegrip.test.js`: the grip, edges (8 handles, dx/dy per edge,
  the press stopping there, keys, cursors, coarse sizes, destroy), and one
  byte-identical copy.
- TradeHub's use of it: A1 `tests/live/tradehub-quant-cards.live.js` and
  `tradehub-quant-a1rules.live.js`.
