# MAGI Theme Overhaul — Tony's side of every A1 program (living plan)

> **This file is the hand-off between sessions.** One phase per session. A new
> session starts by reading **§0 Hand-off**, builds exactly the phase it names,
> and ends by rewriting §0. Nothing needed to continue lives anywhere else.

---

## 0. Hand-off — read this first

**Last updated:** 2026-10-02, at the end of **Phase 1b** (`dragsort.js` +
Tony's index.html chrome drags). Done, tested, pushed.
**Tags:** phase 1 `theme-p1-start` → `theme-p1-end`; phase 1b
`theme-p1b-start` → `theme-p1b-end`.
**Next phase:** **Phase 2: Index B, MyJournal** (theme + its drags + its
resize handles, no gradient fills; see §3, §4 "Phase 2"). Start it only when
Tony says "continue theme" / "next theme phase".

**Phase 1b, what shipped:**
- `dragsort.js` (`window.A1Drag`: `sort`, `grip`, `order`, `refocus`,
  `later`, `active`): MAGI's dragSort ported, plus `axis:'x'|'grid'`, a touch
  `hold` for rows without a grip, and cross-list `group` moves. Pinned by
  `tests/dragsort.test.js` (jsdom, 36 checks); in `tests/syntax-check.js`.
- Tony's program nav (hold 300ms on touch), the nav dropdown (real grip
  buttons, ↑/↓ on a focused grip) and Settings → External links rows all run
  on A1Drag. Veda's nav, dropdown and Settings drags are unchanged
  (`attachPanelDrag`, `attachTouchDrag`, `attachSettingsDrag` are hers now).
- `tests/live/index-drag.live.js`: real mouse + touch over CDP, asserting the
  SAVED order, plus "the nav is not re-rendered under a resting cursor" and
  "a plain click opens MyJournal".
- **Gotcha that broke the nav for a few minutes:** `scheduleReapply()`
  re-renders Tony's nav while any `.tn-btn` lacks a mark. The old drag code
  set that mark (`_noAttached`); deleting it made every render queue the next,
  rebuilding the buttons every ~100ms (hover flicker, clicks lost).
  `renderTonyNav` now sets `btn._tnPlaced`. Anything that replaces a nav
  helper must keep that mark.
- React rows (later phases): dragsort writes only `style.transform` during a
  drag and calls onDrop after the 170ms glide. Don't let React own
  `transform` on draggable rows. Redraws arriving mid-drag go through
  `A1Drag.later(fn)`.

**Also done 2026-10-02 (Tony's asks during 1b):**
- Tony's icon is a purple fleur-de-lis SVG (see §1), in MAGI, the TaskHub
  chooser and MyList.
- NO GRADIENT FILLS rule (§2): selected states are solid fills like Veda's,
  in purple (current app, mic, Timer); `TH_SEL` returns `none`; weekly bars,
  week cards and Tony's waiting plan card are solid.
- App-lock card: every border/icon follows the lock's colour, BOTH profiles.
- Tesla widget greens are the suite pastel `#a4b986`.
- Boot spinner purple (Veda-main devices keep gold).
- RESIZE HANDLES rule (§2 "Resize handles"): MAGI's exact corner grip
  everywhere, via a shared `resizegrip.js` built in the first phase that needs
  it.

**Start-of-session checklist**
1. `git pull`, then `git tag theme-pN-start && git push origin theme-pN-start`.
2. Read the phase's row in §3 and its notes in §4.
3. Take "before" shots: `node tests/live/theme-shots.live.js pN-before <page>`
   (see §5). For a same-moment comparison, serve the start tag from a worktree
   with `A1_ROOT` (§5).
4. Build. Use the recipe in §2. Keep Veda's side byte-for-byte unchanged.
5. `npm test` (all suites), then take "after" shots and pixel-diff Veda's.
6. Show Tony before/after, tag `theme-pN-end`, push it, and rewrite this §0.

**Done after phase 1, same day (2026-10-02, Tony's asks):**
- **Every A1 app icon is purple-on-charcoal now** (was gold). That covers:
  - each page's favicon, home-screen icon and PWA manifest: index, insight,
    mylist, oneinbox, shield (its T half), solace, tradehub, vault;
  - LifeHub's tiles (`ICONS` in LifeHub/lifehub.js);
  - the `KC_APP_ICONS` maps (index.html and vault.html, twins);
  - MyList's notification icons;
  - the Vault and PriceWatch extension PNGs (gold pixels remapped, edges kept);
  - the Shield desktop icons (`desktop/shield/tools/make-icon.js`: `GOLD`
    renamed `TONY` = `#c0aeea`, then regenerated).

  The rule: **any new app icon is MAGI purple `#c0aeea` strokes on `#1a1a1d`**.
  Veda-only marks (Wellness, the V1 Launcher) stay her mauve. MAGI and RiftIQ
  were already purple.

  To actually SEE them:
  - **Shield desktop:** the exe/tray icon is baked in at build, so it needs a
    `desktop/shield/build.ps1` rebuild and reinstall. Not done.
  - **Extensions:** reload them in `chrome://extensions`.
  - **Installed PWAs:** may keep the old icon until reinstalled.
- **Program-nav labels are lighter and NOT all caps:** weight 600, tracking
  .3px, mixed case (MAGI's .btn is 700/1px uppercase). The row holds a dozen
  programs; Tony wanted it narrower, then the names as written. That covers
  the buttons, `#tn-mobile-select` and `#tn-dd-trigger`.

**What phase 1 left for later (deliberately)**
- **The dead cooking CSS (index.html `<style>` right after the Veda header
  block, `/* ── Cooking Dashboard styles ── */`, ~1,800 lines) was NOT deleted.**
  It is dead (there is no `#cooking-view`), but it carries bare global rules
  (`*`, `.btn`, `.card`, `.modal`, `.header`, `.form-*`…) that may be quietly
  styling live markup on BOTH profiles. Deleting it needs its own careful pass
  with Veda before/after diffs. It is not part of any theme phase.
- The boot spinner (`#th-boot-spin`) is purple (Tony, 2026-10-02). A device
  whose `td6_mainDash` is Veda's keeps the old gold.
- The profile chooser's "Who goes there?" (Lora) and its card shape are shared
  and unchanged. Only Tony's card colour is now purple.
- The Plans panel, HabitModal, TimePicker and DayPicker are SHARED with Veda
  (defined in Tony's babel block, used by both). Phase 1 changed only what flows
  through Tony's theme object (`T.AC`, `T.SEL`). Their hard-coded radii and
  fonts are untouched.
- MyJournal's `#tj-root` carries `data-hoverfx="classic"` so it keeps the old
  hover until phase 2. **Phase 2 removes that attribute.**

---

## 1. What this is

Tony wants MAGI's look on his side of every program: the colours (pastel, with
**purple dominant and gold kept as an accent**), fonts, UI and button-highlight
mechanics. His profile colour is MAGI purple and his icon is a purple fleur-de-lis: an em-sized inline SVG
(the ⚜️ emoji is always gold) sized like Veda's ✦. He went ⚜️ → ☯️ → 👾 → ◆ →
this on 2026-10-02.
**And drag and drop:** every reorder, on desktop AND mobile, behaves like
MAGI's unit chips and queues (added by Tony 2026-10-02: "make it proper").
**Veda's side is never touched.** That covers her TaskHub, Brainstorm Journal,
MyList and Shield profiles, and her colours in shared dialogs.

**Undo.** Every phase is bracketed by tags. To undo one phase:
`git revert --no-edit theme-pN-start..theme-pN-end`, then push.
- Phases 2–10 touch their own files or regions, so each reverts on its own.
- Reverting phase 1 also removes hoverfx's magi mode. That would strip the
  hover/press from any later phase too, so revert later phases first.

## 2. The spec, and how it is applied

### Tokens (magi.html `:root`)
| Role | Value |
|---|---|
| bg / s1 / s2 / s3 | `#1a1a1d` / `#232327` / `#2c2c31` / `#34343a` |
| bd (hairline) / bdl (visible) | `rgba(255,255,255,.06)` / `#45454c` |
| tx / txd / txm | `#f4f3f0` / `#adadb2` / `#8d8d94` |
| **ac (MAGI purple)** / acl / acd | **`#c0aeea`** / `#dbd0f5` / `#9a86c9` |
| **gold (kept accent)** | **`#e0b874`** |
| grn / red / blue | `#a4b986` / `#d68a7c` / `#8fa6d8` (pastels; no `#f85149`) |
| radii | 4 chips · 6 buttons · 8 cards |

**Where gold stays:**
- stars, favourites and pinned items
- warnings and amber states
- progress fills (the TaskHub weekly bars)
- money/value highlights
- the Tesla charging amber, the weather sun and the LifeHub crest

Everything else that was gold is purple.

**App icons:** MAGI purple `#c0aeea` strokes on the `#1a1a1d` tile, for every
program (done 2026-10-02, see §0).

**Fonts:**
- Inter is the UI face, Manrope is for headings and wordmarks, and IBM Plex
  Mono is for numbers and tracked labels.
- No serif on Tony's side: Fraunces goes. In index.html `#root` redefines
  `--font-accent` to Inter.
- Fonts a user picks inside the DOCX editor are content, so they stay.

**NO GRADIENT FILLS, anywhere on Tony's side (Tony, 2026-10-02).** Every
button, chip, card, bar and selected state is EITHER a solid fill OR an
outline highlight. Never a `linear-gradient`/`radial-gradient` fill, and never
a see-through tint or soft halo that reads as one.
- **Selected / current = Veda's look in Tony's colours:** a SOLID `#c0aeea`
  fill with a dark `#1a1a1d` label (the program nav's current app, the mic,
  Timer, Plan chip). Or an accent outline on a transparent button. Nothing is
  laid over a fill: `TH_SEL` returns `none` (an opaque inset wash once
  darkened the solid mic button).
- Never `color-mix(… transparent)` or an rgba wash as a fill.
- No hover halos on a selected button (the old 3px ring at 22% is gone).
- Every phase greps its program for `gradient(` and for translucent
  backgrounds on controls, and makes them solid. Veda's side keeps hers.
- Done so far (2026-10-02): the program nav's current app, `TH_SEL`, the
  weekly bars, the week's parcel /
  bill / catalyst cards (`OI_CARD_BG`) and Tony's waiting plan card.
- **Borders follow the accent too:** no gold outline on a purple control. The
  app-lock card's outline, focus ring, button border and icon all take the
  lock's own colour (`--al-glow`), for both profiles.

**Shapes:**
- Panel titles: Manrope, ~11–12px, weight 800, uppercase, tracking 1.6–2px,
  in `acl`.
- Field labels: 9px, weight 700, uppercase, tracked, in `txm`.
- Buttons: 10px, weight 700, uppercase, tracking 1px, radius 6, a `bdl`
  border at rest.
- Dialogs: a `rgba(0,0,0,.62)` backdrop with a 2px blur, an s1 box on a
  hairline border, radius 8.

### Button mechanics (magi.html "global hover layer")
- **Hover:** `brightness(1.15)`, and the outline turns accent.
- **Press:** `brightness(.94)` plus 1px down.
- **Selected/active:** a SOLID accent fill with a dark label, like Veda's
  buttons in Tony's purple; or an accent outline. No glow, no wash, no hover
  ring (Tony: no gradient fills).
- **Focus:** a 2px accent outline at 1px offset (keyboard only).
- **Fields:** an accent border plus a 3px ring at 16%.

**How each part is carried:**
- **hoverfx.js `data-hoverfx="magi"`** (phase 1) does the hover lift, the
  press and the focus ring for ANY control inside the subtree, inline-styled
  React included.
  - The NEAREST `data-hoverfx` wins, so `data-hoverfx="classic"` opts a
    subtree back out.
  - The press writes `translate`, never `transform`. The hover writes
    `filter` only.
  - The four copies (Vault/, PriceWatch/, V1/Launcher/, desktop/shield/ui/)
    must stay byte-identical (`tests/hoverfx-wiring.test.js`).
  - Behaviour is pinned by `tests/hoverfx-magi.test.js`.
- **"The outline turns accent"** on inline-styled React comes from a CSS
  `:hover` box-shadow ring. index.html sets `#root{--suite-glow:0 0 0 1px
  rgba(192,174,234,.6)}`. A 1px ring draws the outline without fighting
  React's inline `border-color`.
- **The selected state** from JS (index.html) comes from
  `TH_SEL(hex)`:
  - It returns `none`: the call sites already paint a solid fill or an
    accent border, and anything laid over them read as a gradient.
  - It reaches call sites through the theme object (`THEMES.dark.SEL`). Every
    site calls `(T.SEL||GLOW)(…)`, so shared components handed Veda's `VD_T`
    keep her glow.
- **Plain CSS programs:** copy MAGI's rules with the program's own selectors.

### Drag and drop (added 2026-10-02): MAGI's, everywhere
**The source is magi.html:**
- `dragSort()`, `dragGrip()`, `dropOrder()`, `dragRefocus()` (search
  `══ drag to reorder`, ~line 15215).
- Its CSS (search `drag to reorder (dragSort)`, ~4650).
- The unit chips' hold-to-pick-up (`unitDragStart`/`Move`/`End`, ~18565).
- The `.chip.dragged` CSS (~690).

**What "MAGI's DnD" means, all of it required:**
- **One code path:** pointer events, so mouse, touch and pen behave the same.
- **Mouse:** a press anywhere on the row that is not a control picks it up
  after 4px of movement. Text selection is prevented.
- **Touch:**
  - Lists: only the grip (⋮⋮, a real `<button>`) starts a drag, so the list
    still scrolls under a finger.
  - Chip rows: a 300ms hold picks up. Moving 8px before the hold completes is
    a scroll, not a drag.
  - Haptic tick on pickup.
- **While dragging:** the lifted row follows the pointer with `transform`
  ONLY, so nothing is laid out per frame.
  - Lifted look: s2, an accent ring, a deep shadow; chips scale 1.06.
  - Neighbours slide out of the way once the dragged row's LEADING edge passes
    their middle.
  - `html.dsort-grabbing` sets the cursor everywhere and kills text selection.
- **Edges:** near the top or bottom of the scroll container (48px zone), it
  auto-scrolls.
- **Release:** a 170ms glide into the slot, then ONE redraw / `onDrop(from,
  to)`.
  - The click a release fires is swallowed (only that one).
  - Escape or pointercancel puts the row back.
- **Keyboard:** focus a grip and ↑/↓ move the row one place (`onKey`), then
  the grip is refocused after the redraw.
- **Reduced motion:** no transitions.
- **Synced lists:** new order numbers come from `dropOrder()` (the midpoint of
  the new neighbours), so only the moved item changes. That keeps Firestore
  merges simple.

**How it is shipped:**
- ONE shared file, `dragsort.js` at the A1 root, exposing `window.A1Drag`.
  It is built in phase 1b.
  - It ports magi.html's code faithfully, CSS included (injected, using
    `--ds-ac`/`--ds-s2` with MAGI fallbacks so a program can tint it).
  - It also does what A1 needs and MAGI never did:
    - `axis:'x'` / `'grid'` (chip rows, wrapping grids, card boards).
    - **cross-list moves:** lists sharing a `group` accept each other's rows,
      e.g. MyList's lists or a kanban-style board.
      `onDrop` then receives `(from, to, fromList, toList)`.
  - Extensions that cannot reach the root carry a byte-identical copy, like
    hoverfx. A wiring test enforces it, plus a jsdom behaviour test.
- Each program phase replaces that program's Tony-side drag code
  (HTML5 `draggable`, `useTouchReorder*`, `thDragList`, `attachPanelDrag`,
  `vault-drag.js`, etc.) with `A1Drag`. Veda's copies are untouched, as with
  the theme.
- **NOT Tony's TaskHub.** Tony said to keep its current drag and drop: the
  week, habits and goals, `useTouchReorder*` and `_XDRAG`. Never replace it.
- A phase's drag work is verified on desktop AND phone width over CDP. Use
  `Input.dispatchMouseEvent` for the mouse, and `Input.dispatchTouchEvent` for
  the hold-then-drag. Assert the persisted order.
- MAGI itself switches to `dragsort.js` in the wrap-up phase, so there is one
  copy of the code.

### Resize handles (added 2026-10-02): MAGI's, EXACTLY, everywhere
Tony: every box with a drag-to-resize / expand handle (TradeHub has them,
other programs too) must look and work EXACTLY like MAGI's prompt box, on
desktop AND mobile. That includes Tony's TaskHub: the "keep its own drag"
exception is for reordering only, not resizing. Veda's side keeps hers.

**The source is magi.html:**
- CSS `.qbar-grip` (search `A corner resize handle`, ~470): a 38px invisible
  hit area over the bottom-right corner, the two diagonal hatch strokes (11px
  and 6px), `cursor: nwse-resize`, `touch-action: none`. Colour `txd` at
  rest, `tx` on hover/focus, `ac` while held or while a hand-chosen height is
  set (`.on`). Focus: a 1px accent outline at -4px offset.
- JS `attachGrip(ta, grip, key, resize)` + `gripButton()` (search
  `Resize by dragging the grip`, ~9975).

**What "MAGI's resize" means, all of it required:**
- The grip is a real `<button>` (title "Drag to resize. Click to expand or
  compress.", an aria-label naming the box). No native `resize:` corner.
- Pointer events, so mouse, touch and pen are one path; pointer capture on
  the grip; vertical only.
- **Drag** (3px or more) sets the height, clamped between 26px and
  `max(160px, 60% of the viewport)`. A chosen height lifts the box's own CSS
  max-height cap, so the drag never stops halfway.
- **Click** (under 3px) toggles: compressed → expanded (+120px, at least
  260px, under the cap); expanded/hand-sized → back to auto.
- Enter / Space on the focused grip do the same toggle.
- A hand-chosen height stops auto-grow until the grip hands it back.
- The height is remembered per box in localStorage (behind the storage guard;
  Veda's Brave throws).

**How it is shipped:** ONE shared file, `resizegrip.js` at the A1 root,
exposing `window.A1Resize.attach(box, grip, key, onAuto)` and
`A1Resize.grip(label)`, with the CSS injected (MAGI fallbacks, tintable with
the same `--ds-*` vars as dragsort.js). Byte-identical copies for extensions,
a wiring test and a jsdom test (drag, click toggle, Enter/Space, cap, 26px
floor, persistence, storage throwing). Built in the first phase whose program
has a resize handle. MAGI moves onto it in the wrap-up phase.

### Per-profile gating in a shared page (index.html)
- `goTony()` / `goVeda()` / `showProfile()` call `_markProfile(who)`:
  - `body[data-th-profile="tony"|"veda"]`, removed on the chooser.
  - `body[data-hoverfx="magi"]` only for Tony.
- Shared overlays appended to `<body>` (uiModal, settings, app lock, voice)
  style Tony with `body[data-th-profile="tony"] …` rules, or with
  `#thset-box:not(.veda)`. Veda's rules are left exactly as they were.

### Gotchas found in phase 1
- **Both TaskHub babel blocks share ONE global scope.** Babel turns top-level
  `const` into `var`, so the later block (Veda's) silently wins any name both
  define. `GLOW` was Veda's at runtime all along, even for Tony's code. Never
  give a Tony-only helper a name Veda's block also defines; use a unique name
  (`TH_SEL`).
- Shared components live in Tony's block: Plans (`PlanPanel`, `PlanCheck`),
  `HabitModal`, `TimePicker`, `DayPicker`, `CR_*`. Change them only through
  the `T`/`P` they are passed, never with literals.
- `function App(){` appears twice. Tony's is the FIRST. Range-limit edits
  between `function App(){` and
  `ReactDOM.render(React.createElement(Root),document.getElementById("root"));`.
- The program-nav dropdown panel (`#tn-dd-panel`) is appended to `<body>`, so
  it does NOT inherit `--tn-*` from the nav. Its fallbacks are the real colours.
- Python one-off edit scripts: write them with the Write tool, not a bash
  heredoc. Heredocs mangle `\u` escapes (memory `heredoc-mangles-escapes`).

## 3. Phases (one per session)

| # | Program | Status |
|---|---|---|
| 1 | Foundation + **Index A: Tony's TaskHub + chrome** | **done 2026-10-02** |
| 1b | **`dragsort.js` (MAGI's DnD, shared) + index chrome drags (nav, dropdown, Settings rows); TaskHub's own DnD stays** | **done 2026-10-02** |
| 2 | **Index B: MyJournal** (theme + its drags + resize handles) | **next** |
| 3 | OneInbox (theme + drags) | |
| 4 | TradeHub (theme + drags) | |
| 5 | MyList, Tony profile only (theme + drags) | |
| 6 | Insight (theme + drags) | |
| 7 | Vault (Keychain) + Vault extension (theme + drags) | |
| 8 | Solace (theme + drags) | |
| 9 | Shield + Shield (HTML) (theme + drags) | |
| 10 | Wrap-up: LifeHub, MAGI onto dragsort.js, sweep | |

**From phase 2 on, every phase = theme + that program's drag and drop + its resize handles (no gradient fills).**
The drag half:
1. Inventory every reorder/move in the program (grep `draggable`,
   `dragstart`, `touchstart`, `pointerdown`, `reorder`, `dnd`, `grip`).
2. Replace each with `A1Drag`, keeping its persistence call.
3. Delete the old code and its comments.
4. Verify mouse + touch.

The resize half (§2 "Resize handles"):
1. Inventory every resizable box (grep `resize:`, `resize-handle`,
   `grip`, `nwse-resize`, `ns-resize`, `expand`).
2. Replace each with `A1Resize` (build `resizegrip.js` first if this is the
   first phase that needs it), keeping each box's own min/max if it has one.
3. Verify over CDP on desktop and phone width: drag, click toggle, reload
   keeps the height.

## 4. Phase notes

### Phase 1 — done (Foundation + Tony's TaskHub)

**Foundation:**
- hoverfx.js gained magi mode (nearest declaration wins), with its tests.
- Tony's icon in magi.html, index.html and mylist.html is a purple
  fleur-de-lis SVG (index `TONY_MARK_SVG`, MAGI `avatar()` for `ink: true`).
- MAGI's Tony profile colour is `#c0aeea` (`tests/magi-profiles.test.js`
  updated).
- `tests/live/theme-shots.live.js` was added. `tests/live/cdp.js` gained
  `CDP_ALLOW_FONTS` and `A1_ROOT`.

**index.html:**
- `THEMES.dark` is MAGI's palette, plus `GOLD`, `S3`, `BLUE` and `SEL`.
  **Category colours are NOT themed** (Tony, 2026-10-02): `CC_DARK` (urgent
  stays bright red `#f85149`) and the catalyst importance colours keep their
  original values. The same goes for every program's category/tag colours.
- `PLAN_PAL_TONY.AC` is purple.
- The weekly bars use `T.GOLD`.
- Wordmark `#dbd0f5`. Section titles (`stt`) are uppercase, tracked, in `acl`.
  Cards (`sec`) use radius 8 on a hairline.
- `hbtn` is MAGI's `.btn`. Tony's App radii 4 → 6; widget cards radius 8.
- Program nav: CSS rewritten to MAGI's `.btn`/`.navitem.active`.
  `_updateTonyNavActive` is simplified, with no RiftIQ special case. The
  dropdown is MAGI's `.side-item`.
- Chooser: Tony's card is purple.
- uiModal, app lock (`AL_LABELS` tony_* plus the card CSS), settings
  (`ACCENT.tony`, `#thset-box:not(.veda)`), the voice overlays (`accent()`)
  and the Main pill: all purple for Tony, unchanged for Veda.

**Veda before/after:** identical apart from the random quote and the live
temperature band.

### Phase 1b — dragsort.js + index chrome drags (done 2026-10-02)
**1. Build `dragsort.js`** (spec in §2 "Drag and drop") by porting magi.html's
`dragSort`/`dragGrip`/`dropOrder`/`dragRefocus` and its CSS verbatim, then
adding `axis` and cross-list `group`.
- `tests/dragsort.test.js` (jsdom): reorder down/up, threshold, click
  swallowed, Escape restores, ↑/↓, cross-list drop, and touch grip-only vs
  hold.
- Add the file to the root-script list in `tests/syntax-check.js`.

**2. Leave the TaskHub alone.** Tony's TaskHub KEEPS its current drag and
drop (Tony, 2026-10-02). Do not touch `useTouchReorder*`, `_XDRAG` or its
HTML5 drags.

**3. Tony's chrome drags in index.html** (outside the TaskHub itself):
- Program nav buttons and the dropdown items (`attachPanelDrag`, nav
  `cursor:grab`).
- The Settings link rows (`.thset-grip`).

**Careful:**
- `attachPanelDrag` and the Settings grip are shared with Veda's nav/settings.
  Gate by profile so Veda keeps her current drag.
- React (later programs): `dragsort` writes only `style.transform` during a
  drag, and `onDrop` sets state after the glide. Don't let React own
  `transform` on draggable rows.

### Phase 2 — Index B: MyJournal
- **Hover:** remove `data-hoverfx="classic"` from `<div id="tj-root">`
  (`<body>` is already magi for Tony). Update the assertion in
  `tests/hoverfx-wiring.test.js` that pins it.
- **Variables:** `#tj-root` CSS vars (search `#tj-root {` near the MyJournal
  CSS). `--purple` currently HOLDS GOLD (inherited names from Veda's journal),
  so rename while there. Also `tjApplyTheme` hard-codes title colours.
- **Shared CSS:** the DOCX editor and journal-shell CSS (search
  `/* DOCX module`, ~34,600–35,500) has `#tj-root` / `#bj-root` selector
  PAIRS with Tony's charcoal/gold hard-coded for both. Split them, so only the
  `#tj-root` half changes.
- **Fonts:** MyJournal uses DM Sans / DM Mono / Bebas (`--font`, journal
  `--font-display`). Move it to Inter / Plex Mono / Manrope. DOCX
  user-chosen fonts stay.
- **Other gold:** `#tj-root .mjd-rail-btn.on` has a gold rgba glow (in the
  rail CSS).
- **Scope:** OurJournal is a tab inside BOTH journals. Theme it only inside
  `#tj-root`.

### Phases 3–10 (from the original survey; re-read each file before building)

**3. OneInbox:**
- All `:root` tokens (lines 54–101), about 6 stray JS hex values, and class
  hovers at 203–631.
- Remap `--gold` to purple and add a real `--gold`.
- Add `data-hoverfx="magi"` on `<body>`.

**4. TradeHub (Tony-only):**
- `:root` 73–86 and the `TB_STYLES` vars ~1468–1788.
- Hard-coded app-lock CSS 117–164 and the `uiModal` copy (~11289+).
- 28 gold `rgba`s and 24 inline `onMouseEnter` handlers.
- Chart and category colours go pastel.

**5. MyList (Tony profile only):**
- `body{}` tokens 87–101 and the `body:not([data-profile=veda])` block
  140–183.
- The Tony profile card at 188–211.
- `enterProfile()` (~2291) sets `data-hoverfx="magi"` for Tony only.
- The theme-color meta.
- Nunito is used but never loaded.

**6. Insight (Tony-only):** `:root` 77–106. Its gold is off-suite (`#ecc78c`).

**7. Vault + extension:**
- `vault.html` has `:root` (84), a JS `THEME` (1602) and a `uiModal` string
  (2712) that must change together. The `CD` card palette stays.
- Extension: `popup.html` `:root`, the CSS strings in
  `vault-controls/ui/id-ui/apikey-ui/cloud-ui.js`, and `content.js`.
- Card-brand gradients stay.
- Run `Vault/*.test.js` by hand, because run-all skips them.

**8. Solace (Tony-only):**
- Tokenise `#mc-root` (MotionCore, about 56 literals) first.
- Also the `uiModal` string and JS `cssText`.
- Bebas Neue / DM Sans become Plex Mono.

**9. Shield:**
- `shield.html`: only the `body,body[data-profile="tony"]` block, the Tony
  chooser card and the Tony `accent:` entries. It also skins the desktop app,
  which loads the live page.
- `desktop/shield/ui/index.html` (the offline page).
- `themeFor('tony')` sets `data-hoverfx="magi"`.
- Leave the `.ico` files unless Tony asks (they need a Rust rebuild).

**10. Wrap-up:**
- LifeHub's Tony default `data-accent` becomes purple everywhere (Veda's
  `#A892B0` stays).
- Sweep for gold doing an identity job.
- Update memories (`ui-width-cap-2000`, `in-ui-modal-system`, plus a new
  `magi-theme-spec`).

## 5. Verifying a phase
```
node tests/live/theme-shots.live.js pN-after [page] [chooser,tony,veda,overlays]
git worktree add <scratch>/wt theme-pN-start
A1_ROOT=<scratch>/wt node tests/live/theme-shots.live.js pN-before [page]
git worktree remove --force <scratch>/wt
```
- **Where shots go:** `%TEMP%\magi-live-shots\`.
- **Diffing Veda's shots:** Python + Pillow
  (`ImageChops.difference(a,b).getbbox()`). The only allowed difference is the
  quote/weather band.
- **Probe output:** the probe prints what hoverfx wrote on a real button.
  - A magi subtree must show `brightness(1.15)` on hover, and
    `brightness(0.94)` / `0px 1px` on press.
  - A classic one shows the measured `1.18`/`0.86` and no press.
- **Firebase stays blocked**, so TaskHub shows its seeded demo data.
