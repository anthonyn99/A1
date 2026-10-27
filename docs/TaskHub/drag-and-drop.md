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
- The lifted row floats freely under the pointer, sideways too, the whole way
  between days and sections (`free`). What you hold is a copy floating over the
  page (`.dsort-ghost`); the row itself stays hidden in its list as the gap
  (`.dsort-hole`). Weekly is its own scroll box and clipped a row dragged out
  of it. The rows it passes slide out of its way, and on release the copy
  glides into the slot and the row shows again.
- **No crossovers.** A day draws open tasks (Veda: SOS ones first), then
  checked tasks, then events. Goals draw open, then done. A row only lands
  among rows of its own kind (`segment` → `thDragRank`), including in the list
  it is dropped into, so nothing lands where the next redraw would sort it
  straight back out.

## What can go where

All of a profile's lists are one A1Drag group (`th-tony` / `th-veda`):

| From | To |
|---|---|
| a day's task or event | another place in that day, another day, Daily Habits, the goals |
| a habit | another place in Daily Habits, a day, the goals |
| a goal | another place in its list, the other goals tab, a day, Daily Habits |

- **Goals tabs** ("Short-term" / "Long-term"): holding a row over the other
  tab opens it, and the drag carries on into that list (a pointer watcher clicks
  the tab, since a held pointer gets no hover events). Both lists are always
  mounted. The list a goal was lifted from stays mounted, invisible and 0
  tall (`goalListStyle`), so the lifted row survives the switch. A drop on a
  tab itself appends to that tab's list.
- **Phone day strip:** each day button is a drop target, so a task can reach
  a day that is not on screen. Tabs show an accent ring while a row is over
  them.
- **Rows that stay** (`data-stay`, from `thRowData`) never leave their list,
  and other lists ignore them during the drag (`canMoveTo` → `thDragCanMove`):
  - shared plans: the date belongs to `dashboards/plans`;
  - Veda's SOS items: the SOS reconcile owns them;
  - Everwell's Prayer row.

  A row also never drops onto its own list's tab or day button.

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
