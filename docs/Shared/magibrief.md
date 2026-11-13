# MagiBrief: MAGI's Brief / Text answer views (`Shared/magibrief.js`)

MAGI draws an answer two ways. **Brief** (`briefBody`) lays it out as a
briefing: a headline and summary, a confidence meter, each section as a card,
bold-led bullets as key-point cards, "Bullish if / Bearish if" groups, notes
as a "Worth knowing" panel. **Text** (`verdictBody`) is the plain reading view.
Any program that shows a MAGI answer uses this file so it looks and behaves
exactly like MAGI. TradeHub's Debrief (Analysis ▸ Debrief) is the first host.

## Never edit `Shared/magibrief.js`

It is **generated**: `tools/build-magibrief.js` cuts the renderer and its CSS
out of `magi.html`, verbatim, between named markers, and wraps them. magi.html
is the only source.

- Change how answers look: edit magi.html. The pre-commit hook (section 5)
  rebuilds and stages `Shared/magibrief.js` in the same commit.
- By hand: `node tools/build-magibrief.js`.
- `tests/magibrief.test.js` fails when the file is stale, or when the cut no
  longer runs alone (a helper it needs moved outside the markers). The build
  stops with the marker's name if a marker moves.

## Using it

Load it unpinned in `<head>`:

```html
<script src="https://anthonyn99.github.io/A1/Shared/magibrief.js"></script>
```

```js
MagiBrief.install('#host-root .mb');   // MAGI's CSS, every rule under this scope
const node = MagiBrief.render(markdown); // the current view: Brief or Text
MagiBrief.brief(markdown); MagiBrief.text(markdown);
MagiBrief.view();          // 'brief' | 'text' (MAGI's key, magi.verdict.view, this device)
MagiBrief.setView('text'); // saves it, fires 'magibrief:view' on window: redraw every answer
```

The container that holds the rendered node carries the scope's class (`mb`)
and defines MAGI's tokens there, mapped to the host's own:
`--bg --s1 --s2 --s3 --bd --bdl --tx --txd --txm --ac --acl --acd --grn --red
--amber --gold --font --font-display --font-mono`. Note MAGI's `--acl` is the
light accent shade (TradeHub's `--acp`), not TradeHub's accent line.

The Brief / Text switch is drawn by the host with MAGI's classes
(`.br-seg` > `.br-seg-btn`, `.on` on the chosen one), so it looks like MAGI's.
One choice covers every answer on the page, as in MAGI.

The renderer builds DOM, never `innerHTML` from model text: a model's markup
cannot become markup (the test checks it).
