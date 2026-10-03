# MAGI Theme Overhaul — Tony's side of every A1 program (living plan)

> **This file is the hand-off between sessions.** One phase per session. A new
> session starts by reading **§0 Hand-off**, builds exactly the phase it names,
> and ends by rewriting §0. Nothing needed to continue lives anywhere else.

---

## 0. Hand-off — read this first

**Last updated:** 2026-10-02, at the end of **Phase 7** (Vault + the Vault
Launcher extension: theme, drags, resize grips, NUMBERS). Done, tested, pushed.
**Tags:** phase N is bracketed by `theme-pN-start` → `theme-pN-end`, for
N = 1, 1b, 2, 3, 4, 5, 6, 7.
**Next phase:** **Phase 8: Solace** (theme + its drags + its resize handles +
the §2 NUMBERS rule, no gradient fills; see §3, §4 "Phases 3–10"). Start it
only when Tony says "continue theme" / "next theme phase".

**Phase 7, what shipped (Vault is Tony-only, so no Veda diff):**
- **Tokens** (vault.html `:root` AND `#kc-root`, plus the JS `THEME` that
  `applyTheme()` writes onto `#kc-root`): `--ac`/`--acs` `#c0aeea`, `--acp`
  `#dbd0f5` (wordmark, panel titles, dialog titles), `--acd` = `--acl`
  `#9a86c9` (accent LINES; `--acl` was a gold rgba wash), `--bd` the hairline
  `rgba(255,255,255,.06)`, `--bdl` `#45454c` (every control's resting
  outline), `--s3` `#34343a`, `--gold` (warnings only), `--ring` (fields'
  3px ring at 16%), radius 8, `--ds-ac`/`--ds-s2`. The old suite block
  (`--gold-*`, `.suite-title`, `.suite-accent`) and Fraunces are gone;
  `--font-accent` is Inter.
- **Buttons** (`.kc-hbtn`, `.kc-new-btn`, `.kc-btn-*`, `.vault-btn`,
  `.vault-tab`, `.vault-gen-tab`, uiModal, lock menu) are MAGI's `.btn`:
  10px / 700 / uppercase / 1px, `bdl` outline that turns accent on hover, no
  glows. Selected = solid purple with a dark label: the current tab, New
  Connection, `.kc-btn-primary`, `.vault-btn.primary`, the generator's
  current mode, the uiModal OK (danger = red outline), Unlock / lock-menu
  accent rows. Fields: accent border + `--ring`. Labels 9px/700/txm.
- **Dialogs** (`.kc-overlay`/`.kc-modal`, `.vault-overlay`/`.vault-modal`,
  uiModal): `rgba(0,0,0,.62)` + 2px blur, s1 box on a hairline, radius 8;
  titles in `acp`. The lock: no radial glow, `acd` card outline, radius 8.
- **Gold stays only where it means something:** expiry/staging/weak-password
  warnings (`.warn` chips, the strength meter's middle step, the plain-text
  export notice, `.vault-health-warn`), the pinned ★, the file-type colour
  for docs (a category colour). Card-brand faces keep their gradients (the
  plan's rule); the range slider's two-tone track is a hard-stop gradient
  that reads solid (`vault-controls.js`, kept).
- **No gradients otherwise:** the lock's radial glow, the ID thumbnail veil
  (solid `rgba(26,26,29,.55)`), an empty ID card's media band, and both
  loading skeletons (Files, ID viewer) are solid with an opacity pulse.
  Washes became `s3` (dropdown options, calendar cells) or went.
- **NUMBERS:** body + controls `tabular-nums`, Inter; one-time codes
  (`.vault-totp-code`), the card-face number, ID document numbers, the
  health score, the popup's card number/expiry are Inter 500 tabular.
  Passwords, API keys, the recovery key and the generator output stay mono
  (secrets/tokens, per §2).
- `<body data-hoverfx="magi">` on vault.html AND the popup.
- **Drag (`dragsort.js` in vault.html's `<head>`; the popup carries a
  byte-identical `Vault/dragsort.js`, enforced by `tests/dragsort.test.js`):**
  - Keychain cards (edit mode only): each `.kc-col` is a list,
    `group:'kc-cards'`, `hold:300`; a drop rewrites `conns` + `kc_colmap`
    (`onCardDrop`). In edit mode the columns stretch full height so a card
    drops below a column's last card too.
  - Keychain link rows: each card's `.kc-items` is a list,
    `group:'kc-items'`, so a row moves between cards (`onItemDrop`).
  - The header buttons (`[data-hk]`, `axis:'x'`) and the tab bar
    (`.vault-tab`, `axis:'x'`), both `hold:300`; `VaultOrder.apply()` (new, in
    vault-ui.js) puts a saved order on either strip. Saves as before
    (`hdrOrder` in vault_cloud, `tabOrder` in the keychain doc).
  - Secure Notes, Payments and API Keys: `host.makeReorderable()` is now
    A1Drag (`row:'.vault-site'`, `ignore:'.vault-rowbody'` so an open row's
    text stays selectable, `canDrag` off while a search is on). The `.vault-drag`
    grip buttons, `dragHandle()` and the "Clear the search to reorder" toasts
    are gone.
  - The Launcher popup's cards (Reorder mode only): each `.col` is a list,
    `group:'pop-cards'`; `onCardDrop` → the existing `persistOrder()`.
  - Deleted: `Vault/vault-drag.js`, `Vault/vault-card-drag.js`, the hand-rolled
    card/item drags in vault.html (`kc-card-fly`, placeholders, handles), the
    `KCI.grip` icon.
  - Not changed: Vault Files' HTML5 "drag a file onto a folder" (a move into a
    folder, not a reorder) and the ID viewer's pan/swipe.
- **`dragsort.js` gained (all programs):** `ignore` (presses inside it are
  never a drag); nested lists (the innermost list that takes a press keeps
  it: `e.a1DragClaimed`); and a **bug fix**: a lifted chip's 1.06 was the
  CSS `scale` property, which also scales the translate, so chips/tabs
  trailed the pointer by 6% of the distance (23px on a long drag). It is now
  `scale(1.06)` inside the row's own transform. 43 jsdom checks.
- **Resize:** `vault-controls.js`'s textarea grip is MAGI's (`A1Resize`,
  key `a1.h.vault.<id|name|placeholder>`); `resizegrip.js` loads in
  vault.html's `<head>`. The popup has no text boxes, so it carries no copy.
  The popup's width/height rails are window sizing, not a box grip: kept.
- **The extension popup** (`Vault/popup.html`): MAGI tokens, Google Fonts
  link for Inter/Manrope, wordmark `#dbd0f5` (was gradient text), solid
  current tab / primary / Fill, `bdl` outlines, Reorder toggle in purple,
  dialogs `.62` + blur. **`content.js`** (the autofill dropdown on other
  sites): Inter, a Manrope `acl` header, purple icons; warnings and the ★ stay
  gold. Reload the extension in `chrome://extensions` to see it.
- **Tests:** `tests/live/vault-theme.live.js` (46 checks): vault.html theme,
  numbers, no gradients/gold; cards by mouse (down a column, across columns,
  saved order + colmap), link rows within and between cards, a row's button
  still clicks, header drag, the modal's grip (drag + stored), MAGI dialog +
  uiModal, phone swipe vs 300ms hold; the harness's Secure Notes (mouse drag,
  saved order, open-row text never drags, off while searching); the popup
  (theme, no grips, cross-column drag PUT to the keychain doc, Reorder off =
  no drag) with chrome.* + the Worker stubbed. Against `theme-p7-start` it
  fails 35 of 46. `tests/live/vault-apikey.live.js` follows the tab drag
  (`.dsort-drag`), 117/117.
- **TradeHub, same session (Tony's ask):** Control's Watchlist buttons wrap
  on a phone (the group was `flexShrink:0`, pushing Trash off the screen).
  `tests/live/tradehub-mobile-fit.live.js` checks every TradeHub page at
  360/390/430px for anything off the screen (commit `39ea0a2`).

**Start-of-session checklist**
1. `git pull`, then `git tag theme-pN-start && git push origin theme-pN-start`.
2. Read the phase's row in §3 and its notes in §4.
3. Take "before" shots: `node tests/live/theme-shots.live.js pN-before <page>`
   (see §5). For a same-moment comparison, serve the start tag from a worktree
   with `A1_ROOT` (§5).
4. Build. Use the recipe in §2. Keep Veda's side byte-for-byte unchanged.
5. `npm test` (all suites), then take "after" shots and pixel-diff Veda's.
6. Show Tony before/after, tag `theme-pN-end`, push it, and rewrite this §0.
7. End the report to Tony with how many phases are left (Tony, 2026-10-02).

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
- MyJournal's `#tj-root` carried `data-hoverfx="classic"` until phase 2,
  which removed it (done).

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
- the Tesla charging amber and the weather sun (the LifeHub diamond went
  purple in phase 3, Tony's ask)

Everything else that was gold is purple.

**App icons:** MAGI purple `#c0aeea` strokes on the `#1a1a1d` tile, for every
program (done 2026-10-02, see §0).

**NUMBERS: ONE FACE ACROSS A1 (Tony, 2026-10-02).** Every number on Tony's
side of every program (amounts, prices, counts, dates, times, percentages,
stats, scores, KDA, timers, badges) uses Insight's numbers face: **Inter,
weight 500 (Medium), `font-variant-numeric: tabular-nums`**, so every digit
is the same width and columns line up. NOT IBM Plex Mono, NOT a serif/
display face for figures. How:
- Set `font-variant-numeric: tabular-nums` on the page's (or Tony root's)
  body, plus `input, select, textarea, button` (controls don't inherit it).
- Anything that names a mono or display face just for figures
  (`var(--mono)`, `'IBM Plex Mono'`, `'DM Mono'`, `'Bebas Neue'`, Fraunces
  numerals) switches to Inter 500 tabular. Mono stays only for real code/
  monospace content (MAGI's code view, diffs, tokens, keys).
- Veda's side keeps hers (standing rule). Each phase from 7 on does this for
  its program; phase 10 sweeps the programs already done + RiftIQ.
- Verify: computed `fontVariantNumeric` is `tabular-nums` and the font is
  Inter on a sample of numbers (the live test of each program checks it, as
  `tests/live/insight-theme.live.js` does).

**Fonts:**
- Inter is the UI face, Manrope is for headings and wordmarks. Numbers: see
  the rule above. (IBM Plex Mono was the figures face in phases 1–5; phase
  10 replaces it.)
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
- **NO GRIP DOTS (Tony, 2026-10-02).** Never draw a ⋮⋮ grip (no
  `A1Drag.grip`, no `.dsort-grip`) on Tony's side: just implement the drag.
  Every row, list or chip, is taken by the row itself: `hold:300` on every
  `A1Drag.sort`. Grips were removed the same day from MyJournal's entries,
  index's nav dropdown and Settings links, OneInbox's accounts and MyList's
  items. Arrow-key moves needed a focused grip, so they went with them
  (`onKey` is unused). dragsort.js still supports grips; Tony's pages don't
  use them. Veda's own grips are hers and stay.
- **One code path:** pointer events, so mouse, touch and pen behave the same.
- **Mouse:** a press anywhere on the row that is not a control picks it up
  after 4px of movement. Text selection is prevented.
- **Touch:** a 300ms hold on the row picks it up, for lists and chip rows
  alike. Moving 8px before the hold completes is a scroll, not a drag, so a
  list still scrolls under a finger.
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
  `vault-drag.js`, etc. — Vault's are gone since phase 7) with `A1Drag`. Veda's copies are untouched, as with
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
  `max(160px, 60% of the viewport)`. A chosen height overrides the box's own
  CSS min- AND max-height, so the drag never stops halfway (phase 2 found a
  34vh min-height doing exactly that).
- **Click** (under 3px) toggles: compressed → expanded (+120px, at least
  260px, under the cap); expanded/hand-sized → back to auto.
- Enter / Space on the focused grip do the same toggle.
- A hand-chosen height stops auto-grow until the grip hands it back.
- The height is remembered per box in localStorage (behind the storage guard;
  Veda's Brave throws).

**How it is shipped:** ONE shared file, `resizegrip.js` at the A1 root,
exposing `window.A1Resize.attach(box, grip, key, onAuto)` and
`A1Resize.grip(label)`, with the CSS injected (MAGI fallbacks, tintable with
the same `--ds-*` vars as dragsort.js). **Built in phase 2.** The box's
parent must be positioned (wrap the box, as MyJournal's `docxTonyGrip`
does); heights are stored as `a1.h.<key>`; a hand-sized box carries
`data-user-h` for any auto-grow code to respect. `tests/resizegrip.test.js`
covers the jsdom behaviour and checks that every copy is byte-identical
(extensions get a copy when a phase needs one). MAGI moves onto it in the
wrap-up phase.

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
| 2 | **Index B: MyJournal** (theme + its drags + resize handles) | **done 2026-10-02** |
| 3 | **OneInbox** (theme + drags + resize; also LifeHub colours, RiftIQ icon) | **done 2026-10-02** |
| 4 | **TradeHub** (theme + drags + resize grips) | **done 2026-10-02** |
| 5 | **MyList, Tony profile only (theme + drags + resize grips)** | **done 2026-10-02** |
| 6 | **Insight (theme + drags + resize grips)** | **done 2026-10-02** |
| 7 | **Vault (Keychain) + Vault extension (theme + drags + resize + numbers)** | **done 2026-10-02** |
| 8 | Solace (theme + drags + numbers) | **next** |
| 9 | Shield + Shield (HTML) (theme + drags + numbers) | |
| 10 | **Numbers sweep** (§2 "NUMBERS"): Tony's TaskHub + chrome, MyJournal, OneInbox, TradeHub, MyList (Tony), **RiftIQ: WarRoom AND ProView**, MAGI | |
| 11 | Wrap-up: **PriceWatch extension**, MAGI onto dragsort.js, sweep (LifeHub colours done in 3) | |

**From phase 2 on, every phase = theme + that program's drag and drop + its resize handles (no gradient fills).** From phase 7 on it also applies the NUMBERS rule (§2).
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

**What 1b shipped, and Tony's asks during it** (moved here from §0 at the
end of phase 2):
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

### Phase 2 — Index B: MyJournal (done 2026-10-02)
**What shipped** (moved here from §0 at the end of phase 3):
- **MyJournal is MAGI.** `#tj-root` tokens are MAGI's: `--ac` `#c0aeea`,
  `--acl`, `--acd`, `--gold` (the locked lock only), `--blue` (links,
  syncing). `--purple`/`--purple2`/`--cyan` stay as ALIASES of those,
  because the `#tj-root, #bj-root` pair rules and the journal's script still
  read them. Tony's own rules name `--ac` directly.
  - Fonts are Inter / IBM Plex Mono / Manrope, and `--font-accent` is Inter,
    so no Fraunces placeholders are left.
  - No gold, no washes, no glows. The PAGE/JOURNAL badges are outlined chips.
    The rail's Journal button and the OurJournal tab are solid purple with a
    dark label. Toolbar buttons and New Entry use MAGI's `.btn` type (10px,
    700, uppercase, 1px tracking). The active entry has an accent left edge.
  - The date strip's edge fade is a `mask-image`, not a gradient fill.
- **Wordmark** "MyJournal" is `.suite-title.th-wordmark` (`#dbd0f5`).
  `tjApplyTheme` adds the class and paints no colours.
- **Hover:** `data-hoverfx="classic"` is gone from `#tj-root`, so the probe
  shows `brightness(1.15)`, then `0.94` plus `0px 1px`.
  `tests/hoverfx-wiring.test.js` now pins "no opt-out".
- **The shared DOCX editor:** `<style id="docx-css-tony">` sits just before
  `docx-css`. It ADDS Tony-only rules and never edits the shared ones:
  - `#tj-root …` for the sheet;
  - `body[data-th-profile="tony"] …` for the menus, dialogs, find bar,
    toasts and AI tools that are appended to `<body>`.
  - Word-blue becomes purple, DM Sans becomes Inter, the find bar's gradient
    becomes solid `#232327`, and primary buttons are solid purple with a
    dark label.
  - User-picked fonts and the page content are untouched.
- **Drag (`dragsort.js`):** the sidebar entry list runs on `A1Drag.sort`.
  - A mouse takes a row anywhere; a finger only by its `.tj-grip` button;
    ↑/↓ on a focused grip moves the row.
  - Off while a search or tag filter is on.
  - A move is "this id before/after that id" in `state.entries`, so trashed
    entries keep their place. Then `saveState(); renderSidebar();
    _tjFbOrder()`.
  - `renderSidebar` defers itself with `A1Drag.later` while a row is lifted.
  - The HTML5 drag and `.entry-drag-handle` are gone from MyJournal.
    `window._attachJournalTouchDrag` STAYS: Veda's Brainstorm Journal still
    uses it.
- **Resize (`resizegrip.js`, new, `window.A1Resize`):** MAGI's corner grip
  for the AI prompt box, the "New AI tool" prompt and the math (LaTeX) box,
  in MyJournal only (`docxTonyGrip(ta, app, key, label)`; Brainstorm keeps
  its native corner).
  - Heights are stored as `a1.h.mj.ai-prompt`, `a1.h.mj.ai-newtool` and
    `a1.h.mj.math`.
  - Pinned by `tests/resizegrip.test.js` (jsdom, 24 checks, including
    storage that throws and copies being byte-identical).
  - The image and math OBJECT resizers (`se-resize` corners on pictures) are
    not box-height grips and were left alone.
- **`dragsort.js` and `resizegrip.js` load in `<head>` now.** MyJournal's
  sidebar first renders while the body is still parsing, so at the end of
  `<body>` `A1Drag` did not exist yet and the rows came up without grips.
  Phase 1b's live nav test still passes (15/15).
- **Tests:**
  - `tests/live/myjournal-drag.live.js` (24 checks). It seeds
    `tony_journal_v3` and asserts the SAVED order for: a mouse drag by the
    title, the swallowed click, a plain click, ↑/↓, the search switching
    drags off, a touch on the row (scrolls) versus on the grip (drags), and
    the prompt grip's drag, click toggle and reload. It also checks that
    Veda's list is not a dsort list.
  - `tests/live/theme-shots.live.js` gained a `journals` view.
  - Veda's journal shots (desktop, phone, template picker) are
    pixel-identical before and after.
- **Gotcha:** a box's own CSS `min-height` (the prompt box has 34vh) stopped
  the grip's drag halfway while it stored the smaller height. A hand-chosen
  height now pins `min-height` too (§2 "Resize handles").

**The original notes:**
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

### Phase 3 — OneInbox (done 2026-10-02)
**What shipped** (moved here from §0 at the end of phase 4):
- **OneInbox is MAGI.** `:root` carries MAGI's tokens: `--ac`/`--acl`/`--acd`,
  `--bd` (hairline), `--blue` (links, syncing), `--mono` (IBM Plex Mono for
  counts and sizes). `--gold` is REAL gold now and is used only by the star
  and the coupon category. The `--gold-*` glow/line tokens are gone.
  - Fraunces is gone; `--font-accent` is Inter.
  - `.btn` is MAGI's type (10px, 700, uppercase, 1px), bdl outline that turns
    accent on hover, no glow, no CSS press (hoverfx does it). `.btn.gold` was
    renamed `.btn.ac` (purple text). `.btn.solid` (Compose) is a SOLID purple
    fill with a dark label.
  - Selected states are solid: the active nav row is s2 with a 2px accent left
    edge; an "on" filter chip is a solid fill (a category chip fills in its
    own category colour) with a dark label. Chips and badges are radius 4.
  - Fields: accent border + 3px ring at 16%. Focus: 2px accent outline.
  - Dialogs: `rgba(0,0,0,.62)` + 2px blur, s1 box on a hairline, radius 8.
  - Wordmark `#dbd0f5`; the list title is a MAGI panel title (Manrope 800,
    uppercase, tracked, `acl`).
  - "All accounts" dot was a gold→blue gradient; now solid purple.
  - `<body data-hoverfx="magi">`.
- **Drag:** the account list runs on `A1Drag.sort` (`wireAcctDrag()` in
  `renderSidebar`, rows `.navitem[data-dkey]`). A drop is a splice of
  `S.accounts`, then `syncAcctOrder` (localStorage + Firestore), as before.
  - The hand-rolled pointer code (`acctDrag`, `acctDragJustEnded`, the svg
    `.grip`, `.reordering`/`.dragging` CSS) is deleted.
  - On a mouse the grip floats over the row's end (hidden until hover, so a
    long address keeps its width); on touch it is in the row, always shown.
  - A click on a grip never selects the account. `renderSidebar` and
    `applyRemoteAcctOrder` defer with `A1Drag.later` while a row is lifted.
- **Resize:** the per-account signature boxes have MAGI's corner grip
  (`resizegrip.js`, key `a1.h.oi.sig`, one height for all). No other
  OneInbox box had a handle (compose body is fixed by design).
- **LifeHub (Tony's ask mid-phase):** lifehub.js's default Tony accent is
  `#c0aeea` (was gold), so the current-app outline, the launcher diamond,
  focus rings and the Edit/Done button are purple in every program. Veda's
  `#A892B0` is unchanged. So phase 10's LifeHub item is DONE.
- **RiftIQ icon (Tony's ask):** the grey hexagon is purple `#c0aeea`, the
  tile `#1a1a1d` (was `#16161c`), the grip `#9a86c9`, in every copy:
  riftiq.html (favicon, touch icon, manifest), LifeHub `ICONS`, the
  `KC_APP_ICONS` twins (index.html, vault.html) and both extension popups
  (Vault/popup.js, V1/Launcher/popup.js; reload the extensions to see it).
- **Tests:** `tests/live/oneinbox-drag.live.js` (32 checks: theme, mouse drag
  + saved/synced order, swallowed drop click, ↑/↓, grip click, touch row vs
  grip, signature grip drag/toggle/reload). It FAKES OneInbox's worker and
  Firebase (no-op modules recording `setDoc` in `window.__fsWrites`).
  `--shots <label>` takes desktop / settings / LifeHub / phone / drawer
  shots instead. Against `theme-p3-start` it fails 12+ checks.
  - `tests/live/cdp.js` gained `connect({ mock })`: `mock.patterns` are URL
    pattern STRINGS (objects broke `Fetch.enable` and silently served the
    live GitHub Pages copy), `mock.handle(request)` returns `{status, json}`
    or `{text, type}`.
- OneInbox is Tony-only, so there is no Veda diff for this phase.

### Phase 4 — TradeHub (done 2026-10-02)
**What shipped** (moved here from §0 at the end of phase 5):
- **TradeHub is MAGI.** `TB_STYLES` `#tradeboard-root` carries MAGI's
  tokens: `--ac` `#c0aeea`, `--acs` (accent text), `--acd` `#9a86c9`,
  `--acp` `#dbd0f5` (panel titles), `--acl` (an accent LINE, borders only),
  `--s3` `#34343a`, plus `--gold` (real gold) and `--blue`, and the
  `--ds-ac`/`--ds-s2` tint for dragsort/resizegrip. `--acg` (a gold wash)
  and the `:root` `--gold-*`/`--red-glow` tokens are gone.
  - Fraunces and the DM Sans / DM Mono / Bebas link are gone;
    `--font-accent` is Inter. Lora stays: it is a Playbook font choice.
  - `.tb-btn-primary/-ghost/-danger` are MAGI's `.btn` (10px, 700,
    uppercase, 1px; `font-size` is `!important` because ~25 call sites pass
    an old inline `fontSize`). bdl outline, accent on hover, no glow, no CSS
    press (hoverfx does it). `.tb-x-close` has no wash or halo.
  - `.tb-section-label` is a MAGI panel title. Fields get the accent border
    + 3px ring at 16%; buttons a 2px accent focus outline.
  - Selected = solid: the AI-destination and MAGI-unit chips, the prompt
    chips, the Playbook toolbar's active tool (solid purple, dark label);
    the Playbook page list's active item is s2 with a 2px accent left edge;
    selected Journal rows are s2 (was a gold wash). Every `#fff`/`#000`
    label on a purple fill is `var(--bg)`.
  - Gold stays only where it means something: the ★ favourite in the
    prompt picker and the Playbook storage warning. The Playbook's text and
    highlight colour palettes and `mark` are content, so unchanged.
  - The News bear→bull tone track was a gradient; it is solid `--s3`.
  - Category / importance colours (`TB_CAT_COLORS`, `TB_IMP`, the status
    badges) are NOT themed, per the phase-1 rule.
  - The whole-app lock (CSS + its JS button styles) and `uiModal` are
    purple: no radial gradient, no glows, primary = solid purple; the modal
    is MAGI's dialog (`rgba(0,0,0,.62)` + 2px blur, s1 box, hairline,
    radius 8).
  - Wordmark `#dbd0f5`. `<body data-hoverfx="magi">`.
- **Drag (`dragsort.js`, now loaded in TradeHub's `<head>` with
  `resizegrip.js`):**
  - The page tabs (`TBNavBar`, desktop and phone) run on `A1Drag.sort`
    (`row:'.tb-navtab', axis:'x', hold:300`). A drop hands the new id order
    to `onReorderNav` (localStorage `tb_nav_order_v1` + Firebase), as before.
    The hand-rolled pointer code (`liveIds`, `draggingRef`, `justDraggedRef`
    …) is deleted.
  - The Prompts tab's chips run on `A1Drag.sort` (`row:'.tb-pchip',
    axis:'grid', hold:300`); a drop is a splice + `onSave`, the selection
    follows its chip. The old `dragState`/`overIdx` code is deleted.
  - React pattern used: `A1Drag.sort` re-wired in an effect every render
    (same listeners, new options) with the live values in a ref; React never
    owns `transform` on those rows.
- **Resize (`resizegrip.js`):** three boxes have MAGI's corner grip:
  - the Prompts tab preview (`a1.h.th.prompt`, was a hand-rolled ns-resize
    corner),
  - Analysis → Quick Prompt (`a1.h.th.quick`, was its own pointer grip; the
    old `tb_quick_prompt_h` key is a NEW dry-run item in
    `cleanup-rules.json`, `tradehub-quick-height`),
  - the trade modal's Notes (`a1.h.th.trade-notes`, was native
    `resize:vertical`), via a new `TBGripBox` wrapper component.
  - **Gotcha:** a gripped box's default height must be a CSS class
    (`.tb-prompt-render`, `.tb-quick-box`, `.tb-notes-box` in TB_STYLES),
    never an inline React style: handing the box back to auto clears its
    inline height/min/max.
- **Tests:** `tests/live/tradehub-drag.live.js` (49 checks: theme, desktop tab
  drag + saved order + swallowed drop click + reload, phone hold vs swipe,
  prompt chips by mouse and by held finger, all three grips: drag, store,
  reload, click toggles). Firebase stays blocked; prompts are seeded in
  `tradeboard_prompts_v2`. `--shots <label>` takes every tab, the confirm
  dialog and phone shots. Against `theme-p4-start` it fails from the first
  theme check. TradeHub is Tony-only, so there is no Veda diff.
- **Left for later:** status badges (OPEN/CLOSED/manual) still use their
  translucent tinted backgrounds; they are status colours, not controls.

### Phase 5 — MyList, Tony's profile (done 2026-10-02)
**What shipped** (moved here from §0 at the end of phase 6):
- **MyList is MAGI on Tony's profile; Veda's is pixel-identical** (11 views:
  lists, manual, edit, select, picker, confirm, lock, events, price watch,
  uiModal, phone). Every Tony rule is behind `body:not([data-profile=veda])`.
  - Tokens (`body{}`): `--accent` `#c0aeea`, `--acl` `#dbd0f5` (wordmark,
    panel titles), `--gold` (only the busy sync dot), `--hair`, plus the
    `--ds-ac`/`--ds-s2` tint. `--accent-pale` is `txm` (field labels).
    `--font-accent` is Inter for Tony; Fraunces stays LOADED because Veda's
    item descriptions use it.
  - The old "Insight component language" block (outline-only, gold glows)
    is now MAGI's: `.btn` 10px/700/uppercase/1px, radius 6, bdl border →
    accent on hover, no glow, no CSS press (hoverfx does it); `.btn.solid` is
    a SOLID purple fill with a dark label. Fields: accent border + 3px ring at
    16%. Labels 9px/700/txm.
  - Selected = solid: the current view tab, the active list tab and Manual-on
    are solid purple with a dark label; the mic and Go are solid with no
    halo. A PICKED row (selected item, chosen list type, chosen mic) is s2
    with an accent outline. Store chips are outlined, radius 4.
  - "MAGI shapes" block at the end of the main `<style>`: panel titles
    (group headers, ITEMS, section labels, event years, Manual's
    sub-titles: Manrope 800, uppercase, 1.8px, `acl`), radii 8/6/4, cards on
    a hairline, numbers in IBM Plex Mono, dialogs `rgba(0,0,0,.62)` + 2px
    blur on an s1 box (confirm, type picker, mic picker, extension modal,
    event modal, lock), no halos in the lock menu, the best-price row and
    price-drop banner solid.
  - The Events view's own lighter/deeper golds are gone (dates, rail dots,
    "+ New event" are purple).
  - The chooser's Tony card is purple. `body[data-hoverfx="magi"]` is set in
    `enterProfile` for Tony only (removed for Veda and on the chooser).
    `theme-color` is `#1a1a1d` for Tony.
  - uiModal (shared): for Tony the OK is solid purple with a dark label
    (danger = pastel red), MAGI's dialog and field ring; Veda's values are
    unchanged (`tony()` check at render time).
- **Drag (`dragsort.js`, loaded in `<head>` with `resizegrip.js`):** Tony's
  view tabs, list tabs and items run on `A1Drag`; Veda keeps MyList's own
  engine (`enableDrag` …, now commented as hers, and it ignores presses while
  Tony is the profile).
  - Items: for Tony each store group renders as its own `.ml-grp`
    (header + rows) sharing `group:'ml-items'`, so a row moves between groups.
    Mouse: anywhere on the row. Touch: a 300ms hold. No grip dots (the
    grip + ↑/↓ version shipped first and was removed the same day, Tony's
    ask). Off in select mode and while editing.
  - Tabs: `mlTabsDrag(bar, row, kind)`: `axis:'x'`, `hold:300`.
  - Every drop goes through the existing `applyDrop(kind, id, {store,
    beforeId})`, so both profiles save through the same data code.
  - `render()` defers itself with `A1Drag.later` while a row is lifted (a
    remote update mid-drag waits for the drop).
- **`dragsort.js` gained** (all programs): a list that is ITSELF the
  scroller (MyList's tab strip) auto-scrolls and is measured in content
  coordinates; a drop into an EMPTY list lands under what it already holds
  (a group's header); disconnected lists leave a `group` when a new one
  registers. The other programs' live tests all still pass.
- **Resize (`resizegrip.js`):** MAGI's corner grip on Tony's Details boxes:
  add item + edit item share `a1.h.ml.details`; the event box is
  `a1.h.ml.event` (`mlTonyGrip`, `mlTonyGrips`, `mlEventGrip`). `autoGrow`
  leaves a hand-sized box (`data-user-h`) alone. Veda keeps the old
  ns-resize grip (`GRIP_OLD`, `gripOld()`); the static event box carries both
  and CSS shows each profile its own.
- **Tests:** `tests/live/mylist-theme.live.js` (55 checks: theme, item drag by
  mouse incl. cross-group and into an emptied group, swallowed click, ↑/↓,
  Escape, remote update mid-drag, select mode; tab + view-tab drags and
  saved orders; the grip's click/drag/store/no-auto-grow/shared height and
  the event grip; phone: row vs grip, quick swipe vs hold, tab strip
  auto-scroll; Veda: no A1Drag, her drag, her grip, her gold uiModal).
  `--shots <label>` takes both profiles' views + the chooser. It turns on
  `Emulation.setFocusEmulationEnabled` so `:focus` matches headless. Against
  `theme-p5-start` it fails. `tests/live/mylist-lists.live.js` now asserts
  `.dsort-drag`/`.dsort-on` and a touch drag by the grip (51 checks).
- **Also this session (Tony's asks, TradeHub, commit `bd7bb7b`):** a lifted
  row's label is forced light in `dragsort.js` (a selected prompt chip went
  black mid-drag); "Deploy Trading Auto Launch" swaps its hover fill
  instantly (an inline `!important` `transition-property` outranks
  hoverfx's, which faded the purple out and flashed); the app lock's "Set
  Password" lost an old inline `background:transparent` that hid its solid
  purple behind the dark label.
- **Left for later:** the chooser's shared `.pw-sub` names Nunito, which is
  never loaded (falls back to sans-serif on both profiles; not touched).

### Phase 6 — Insight (done 2026-10-02)
**What shipped** (moved here from §0 at the end of phase 7; Insight is
Tony-only, so no Veda diff):
- **Tokens** (`:root`): `--ac` `#c0aeea`, `--acl` `#dbd0f5` (wordmark,
  panel titles), `--acd` `#9a86c9` (accent lines: the lock card, Manual /
  deposit chips, a hovered account card), `--gold` is the REAL suite gold
  `#e0b874` (was the off-suite `#ecc78c`) and is kept only for money in
  (In / Assets / Net ≥ 0 / recurring totals / cash on hand / `+` amounts),
  "Due soon" and the syncing dot. `--border-soft` is the hairline, `--radius`
  8, `--mono` IBM Plex Mono. The old suite block (`--gold-primary`,
  `--gold-glow`, `.suite-title`, `.suite-accent`, all unused) and Fraunces
  are gone; `--font-accent` is Inter.
- **NEW standing rule, NUMBERS (Tony, 2026-10-02):** Insight's numbers face
  (Inter 500, tabular-nums) for every number in A1 on Tony's side, RiftIQ's
  WarRoom and ProView included. §2 "NUMBERS"; phases 7–9 apply it as they
  go, new phase 10 sweeps everything already done; wrap-up is now 11.
  Insight itself: `body` + controls are `tabular-nums`.
- **Insight keeps its OWN TYPE (Tony, 2026-10-02, right after the phase):**
  Manrope headings, Inter body, figures in Inter Medium + tabular-nums, at
  their old sizes, weights, tracking and case. Only the colours, shapes,
  drags and grips are MAGI's. The Plex Mono / panel-title / 10px-700 type
  below was reverted in the commit after `theme-p6-end`. (Ask before
  assuming the other programs want the same; so far only Insight does.)
- `.btn` has MAGI's mechanics (bdl → accent on hover, no glow, no CSS
  press) in Insight's own type. `.btn.gold` was renamed `.btn.solid` (solid purple, dark
  label) in the markup and in JS (`menuBtn`, the import dupes' chosen
  decision, the missing-payment "Yes"). `toast(msg, good)` → `.toast.good`.
- Selected = solid: the current tab (the editorial underline is gone; tabs
  are MAGI nav buttons), the expense/income segment, display mode on.
- Panel and dialog h3s and institution headers are `acl` (in their old
  Manrope type). The wordmark names `var(--display)` (phase 6 first left it
  on a deleted `--suite-display`, so it fell back to the default face).
- Fields: accent border + 3px ring at 16%; focus 2px accent outline.
  Dialogs: `rgba(0,0,0,.62)` + 2px blur, s1 box on a hairline.
- Gradients removed: the date headers' fading rule (solid hairline) and
  the lock screen's radial glow. `<body data-hoverfx="magi">`.
- **Drag (`dragsort.js`, now in Insight's `<head>` with `resizegrip.js`):**
  - Tabs: `A1Drag.sort($('nav'), {row:'.tab', axis:'x', hold:300})`; a drop
    splices `navOrder`, `renderNav()`, `saveNavOrder()` (Firestore prefs) as
    before. `renderNav` defers with `A1Drag.later`. The hand-rolled
    `enableNavDrag` / `navSuppressClick` are deleted.
  - Recurring: the auto rows and the manual rows now render into their own
    lists (`#recAuto`, `#recManual`, class `.reclist`), each wired by
    `recDrag(list, ids, group)`, so a row never leaves its group. A drop
    writes `recurringOrder` / `recurring` through `saveExpenselog()` as
    before. `renderRecurring` defers with `A1Drag.later`. The old
    `enableRecDrag` (FLIP code, `.dragging`/`.dropping` CSS) is deleted.
- **Resize:** both notes fields (`#mNote`, `#rNotes`) have MAGI's corner
  grip (`makeResizable` → `A1Resize`, keys `a1.h.ins.mNote` /
  `a1.h.ins.rNotes`). The old `.ta-grip` ns-resize handle is deleted.
- **Tests:** `tests/live/insight-theme.live.js` (51 checks): it fakes
  Firebase (seeded `onSnapshot`, `setDoc` → `window.__fsWrites`), the
  insight-api and lock workers and Plaid's script. Theme, no gradients and
  none of the old tan-gold on three screens, magi hover/press, tab drag +
  saved order + swallowed drop click, both Recurring groups + saved orders,
  group isolation, a press on a row's button, the grip (drag, store, click
  back), and phone: swipe vs held finger on a row and a tab. `--shots
  <label>` shots every view, the recurring dialog, the lock manager and the
  phone. Against `theme-p6-start` it fails from the first drag check.
- **Recurring fix (Tony's ask, same session):** `nameSim` now counts a word
  that starts a longer word of 4+ letters ("vasa" ~ "vasafit") and ignores
  generic words (`NAME_FILLER`: fitness, gym, payment, accept, …). A Vasa
  charge renamed from "Paramount Accept Vasafit" to "Vasa Fitness" had shown
  the paid bill as Missing; "fitness" alone would have merged it into Planet
  Fitness. The live test seeds both cases.
- **Recurring made robust (Tony: "any and all bills, now and future"):**
  - `cadenceOf(gaps)` replaces `freqForGap(median)`: a gap may span 2–3
    skipped cycles, but half the gaps must be one cycle (a skipped month no
    longer drops the bill).
  - Pending charges are candidates: never used for the cadence, but a newer
    pending charge is this cycle, paid ("(pending)" on the row).
  - `matchStray`: a charge no bill claimed pays a late bill when it lands in
    its next window at its price (named: within 10%, 30% if variable); with no
    word in common it must be the EXACT price near the expected date. The row
    says `as "<name>"`. Each charge pays one bill.
  - `statusOf`: a new "Due" step. A bill gets max(3 days, its own date
    jitter) past its date before it is Late; grace widens by the same.
  - Live test: Hulu renamed "HLU*SVC LA", Disney pending, Adobe with a skipped
    month, iCloud 2 days behind, Crunchyroll missing next to a same-price
    Corner Store charge (must stay Missing). 56 checks; the four bug cases
    fail on the commit before.
- **Noticed, not changed:** the Recurring click handler reads
  `row.dataset.ovKey`, but the attribute is `data-ovkey` (dataset
  `ovkey`), so a Keep/Remove decision is always saved under the group's
  current key, never the fuzzy-matched older one. Harmless today; a
  one-word fix if Tony wants it.

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
- **Extension (Tony asked for it explicitly, 2026-10-02: colours, fonts
  and everything, to match):** `popup.html` `:root`, the CSS strings in
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

**10. Numbers sweep (Tony, 2026-10-02):** the §2 NUMBERS rule in every
program finished before it was made. Known Plex Mono / mono-figure sites:
- index.html (~33 Plex Mono refs: TaskHub stats, weekly bars, timers,
  Tesla/weather widgets, catalysts; MyJournal date strip/counts), Tony's
  side only (Veda's block untouched);
- tradehub.html (~70 refs: prices, P/L, Journal, News, Analysis);
- mylist.html (`--mono` numbers on Tony's profile only), oneinbox.html
  (`--mono` counts/sizes);
- **riftiq.html: BOTH programs, WarRoom and ProView** (`--mono` at ~477 and
  inline `fontFamily` Plex Mono on records like `rec.w+'-'+rec.l` ~12651;
  KDA, CS, gold, timers, LP, win rates, schedules). The uiModal's Plex Mono
  error/button TEXT is not a number: it follows the theme, not this rule;
- magi.html: numbers in Inter tabular; Plex Mono stays for code, diffs and
  tokens.
Each program's live test gains a "numbers are Inter tabular" check; Veda
diffs stay pixel-identical.

**11. Wrap-up:**
- ~~LifeHub's Tony default accent becomes purple~~ DONE in phase 3
  (lifehub.js default `#c0aeea`; Veda's `#A892B0` stays).
- **PriceWatch extension (Tony, 2026-10-02):** MAGI's colours, fonts,
  buttons and hover like the rest: `PriceWatch/` popup/options CSS and any
  injected UI; its hoverfx copy stays byte-identical. Same rules as the
  Vault extension in phase 7.
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
