# TaskHub drag and drop

Both TaskHubs (Tony's and Veda's) drag with **A1Drag** (`dragsort.js`), the
same drag every other A1 program uses. Rebuilt 2026-10-27 at Tony's request;
it replaced the HTML5 `draggable` handlers, the `useTouchReorder*` touch hooks
and the `_XDRAG` registry on both sides.

## How it behaves

- **Mouse:** press any part of a row that is not a button and move it.
- **Finger:** hold the row still for 300ms, then drag. A quick swipe still
  scrolls the page. Near the screen's edge the page scrolls under the drag.
- **Any time:** edit mode is not needed (Tony, 2026-10-27).
- The lifted row follows the pointer, the rows it passes slide out of its
  way, and on release it glides into its slot.

## What can go where

All of a profile's lists are one A1Drag group (`th-tony` / `th-veda`):

| From | To |
|---|---|
| a day's task or event | another place in that day, another day, Daily Habits, the goals |
| a habit | another place in Daily Habits, a day, the goals |
| a goal | another place in its list, the other goals tab, a day, Daily Habits |

- **Goals tabs** ("Short-term" / "Long-term") are drop targets. A drop on a
  tab appends to that tab's list. Tabs do not switch while you drag, because
  that would swap out the list the row came from.
- **Phone day strip:** each day button is a drop target, so a task can reach
  a day that is not on screen. Tabs show an accent ring while a row is over
  them.
- **Shared plans** reorder within their day but never change day: the date
  belongs to `dashboards/plans` (`_plGuard`).
- **Everwell's Prayer row** stays in Daily Habits (`crossMove` refuses it).

## Code (index.html)

- `window.thDragRef(who, zone, h)`: the ref a list element takes. It marks
  the list `data-thz=<zone>` (`week:<day>`, `habit`, `goal`, `goalm`) and wires
  `A1Drag.sort` on it. Rows carry `data-dkey=<id>`. Rows must be **direct
  children** of the list.
- `thDragDrop` turns a drop into one handler call:
  - `h.reorder(zone, ids)` gets the list's ids in their new displayed order.
  - `h.move(fromZone, id, toZone, beforeId)` handles a move between lists.
- `window.thApplyOrder(arr, ids)` writes a displayed order back into an array.
  Items that are not shown (hidden done goals, multi-day copies) keep their slots.
- **Tony's ticked tasks** display newest-tick first (`wkSortTasks`), so a
  reorder among them re-stamps their `doneAt` in the new order
  (`_wkStampDone`).
- **Each component's `thDrag`** holds the handlers. Moves between sections
  reuse `crossMove` / `vCrossMove`.

## Testing

Drive real input over CDP: `Input.dispatchMouseEvent` for the mouse, and
`Input.dispatchTouchEvent` with a 300ms+ hold for touch. Then assert the order
in `window._thVoice` / `window._vdVoice` `.getState()`.
`tests/live/everwell-taskhub.live.js` drags with synthetic `PointerEvent`s,
which A1Drag accepts. Note that day buttons and goal tabs also carry
`data-thz`, so select lists as `div[data-thz=...]`.
