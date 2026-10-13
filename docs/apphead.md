# apphead.js: the app mark and the sync pill

Every program's header shares two things (Tony, 2026-10-13), both drawn by
[apphead.js](../apphead.js) at the repo root:

1. **The app mark beside the title**, the way Shield draws it: a line glyph in
   the accent colour, as tall as the title, a small gap (.4em) before the word.
   Markup: `<span class="a1-app-ic" data-a1-app="mylist"></span>MyList`. React
   headers use `h(A1Head.AppIcon, { app })`. Markup added later is filled with
   `A1Head.fill(root)`. The glyphs are each program's favicon mark without its
   tile; a new program adds its glyph to `G` in apphead.js.
2. **The sync status in Everwell's design**: a dot and a word, no outline.
   "Syncing…" pulses gold, "Synced" turns green and fades after two seconds,
   "Sync failed" is red and stays, "Offline" is grey.
   `A1Head.sync(el, 'busy' | 'ok' | 'err' | 'off' | 'idle')`, or
   `h(A1Head.SyncPill, { status })` in React (`saving` / `saved` / `error`).

Rules:

- A program never builds its own sync indicator or styles the mark; it loads
  apphead.js (A1 pages relatively, A1-Priv pages from
  `https://anthonyn99.github.io/A1/apphead.js`) and uses the two pieces.
- The mark's gap is `!important`, because a host's reset
  (TradeHub's `#tradeboard-root *{margin:0}`) otherwise closes it.
- Where the header has no room beside the title on a phone, the pill moves
  under the title (Insight, Vault, MAGI's top bar), still in the header.
- Everwell keeps its own pill: it is the design the others copy. Shield and
  Everwell draw their own mark. Notebook styles its pills itself (an instance's
  host may not load apphead.js), in the same design.
- The extensions (PriceWatch, Vault, V1/Launcher) carry byte-identical copies.
  [tests/apphead-wiring.test.js](../tests/apphead-wiring.test.js) enforces the
  copies, that every program loads the file and shows its mark, and that no
  old indicator is left.
