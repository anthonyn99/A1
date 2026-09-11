/**
 * Every A1 program caps its UI at 2000px.
 *
 * Past that width only the page BACKGROUND may keep growing -- the interface
 * itself stays a centred column, so an ultrawide monitor does not stretch a
 * two-column layout across a metre of glass. index.html has always worked this
 * way; OneInbox and several others did not, which is what this test exists to
 * stop happening again.
 *
 * Two distinct failures are checked, because the second is the one that hides:
 *
 *  1. The cap is declared at all (the `ui-cap-2000` block).
 *  2. No position:fixed bar ESCAPES it. A fixed element is laid out against the
 *     viewport, so it ignores an ancestor's max-width completely -- add a new
 *     fixed top/bottom bar and it runs full width while everything around it
 *     narrows, which reads as "the cap broke" rather than "this bar is new".
 *     Any such bar must restate the cap on itself.
 *
 * Full-screen modal/overlay dims are exempt: a dim IS background, and the card
 * inside it is centred by its own layout.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES = [
  'index.html', 'insight.html', 'magi.html', 'mylist.html', 'oneinbox.html',
  'riftiq.html', 'shield.html', 'solace.html', 'tradehub.html', 'vault.html',
  'wellness.html',
];
// StudyOS is the one multi-file app; its cap lives in its stylesheet.
const SHEETS = ['V1/css/studyos.css'];

const CAP = /max-width:\s*2000px/;
// Selectors whose NAME says backdrop. A dim is background, and the card
// inside it centres itself, so neither needs the cap. Nothing is exempted
// for merely being full-screen -- see findEscapingFixedBars.
const OVERLAY_NAME =
  /(overlay|backdrop|modal|scrim|sheet|dim|veil|omni|lockscreen|lock-screen|picker|scrolllocked|toast|snack)/i;
// Surfaces allowed to span the viewport, each for a stated reason rather than
// by accident. Add to this list only WITH a reason — an entry here is the one
// way a genuinely uncapped piece of UI can get past this test.
const DELIBERATE_FULL_BLEED = [
  // The journals' page-fullscreen mode declares `max-width:none !important` on
  // purpose. The document page inside it has its own fixed width, so capping
  // the editor shell would only narrow the grey margin around a page that was
  // never going to grow.
  /page-fs/,
  // The viz board's fullscreen mode is a drawing canvas. Its content is the
  // surface itself, so every pixel of width is usable area, not stretched UI.
  /viz-fs/,
  // Shield's Emergency screen is a full-bleed background gradient; the content
  // inside it is `.emg-wrap`, already capped at 520px and centred. Capping the
  // screen would clip the gradient, which is the background this cap exists to
  // let through.
  /emg-screen/,
];
const failures = [];

const BS = String.fromCharCode(92);
const RE_SPECIAL = '.*+?^${}()|[]' + BS;
const escapeRe = (s) =>
  s.split('').map((c) => (RE_SPECIAL.indexOf(c) >= 0 ? BS + c : c)).join('');

// `inset` is a shorthand and only SOME of its forms pin both horizontal edges.
// Matching the bare word treated MAGI's phone drawer — `inset: 0 auto auto 0`,
// which is top+left only and 300px wide — as a full-width bar, and a test that
// cries wolf gets an exemption written for it, which is how a real one later
// slips through. The forms, per CSS box-edge order:
//   1 value  -> all four            : spans
//   2 values -> block, inline       : spans iff inline is 0
//   3 values -> top, inline, bottom : spans iff inline is 0
//   4 values -> top, right, bottom, left : spans iff right AND left are 0
function insetSpans(decls) {
  const m = decls.match(/(^|[;{ ])inset:\s*([^;}]+)/);
  if (!m) return false;
  const v = m[2].trim().split(/\s+/);
  const zero = (s) => /^0([a-z%]*)$/.test(s);
  if (v.length === 1) return zero(v[0]);
  if (v.length === 2 || v.length === 3) return zero(v[1]);
  if (v.length === 4) return zero(v[1]) && zero(v[3]);
  return false;
}

function bodyIsCapped(css, file) {
  if (!/body\s*\{[^{}]*max-width:\s*2000px[^{}]*\}/.test(css)) {
    failures.push(file + ': no `body { max-width: 2000px }` -- the UI is uncapped');
  }
}

// A fixed box only escapes the body cap if it actually spans the viewport.
// `inset: 0` is listed explicitly and deliberately: it is the shorthand that
// hid TradeHub's entire app shell from an earlier version of this check, which
// looked only for a literal left:0 AND right:0 pair and so reported a clean
// pass while the whole UI ran the full 3000px. Spelling every form out is the
// point -- any shorthand that pins the horizontal edges counts as spanning.
function findEscapingFixedBars(css, file) {
  const rule = /(^|\n)([^\n{}]{1,200}?)\{([^{}]*position:\s*fixed[^{}]*)\}/g;
  let m;
  while ((m = rule.exec(css)) !== null) {
    const selector = m[2].trim();
    const decls = m[3].replace(/\s+/g, ' ');
    const spans = (/left:\s*0/.test(decls) && /right:\s*0/.test(decls)) ||
                  /width:\s*100(%|vw)/.test(decls) ||
                  insetSpans(decls) ||
                  /inset-inline:\s*0(\s|;|})/.test(decls);
    if (!spans) continue;
    if (CAP.test(decls)) continue;                                      // caps itself
    // Covering all four insets does NOT make something a backdrop. TradeHub's
    // entire app shell is `position:fixed; inset:0`, so an "it fills the
    // screen, therefore it is a dim" rule waved the whole UI through while the
    // test reported a pass. Only names that say overlay are exempt, and a dim
    // still has to be a dim -- pinned top AND bottom as well as left and right.
    if (OVERLAY_NAME.test(selector)) continue;
    if (DELIBERATE_FULL_BLEED.some((re) => re.test(selector))) continue;
    // Anything left is a real bar. It is allowed only if the file also caps it
    // by name, or it wraps an inner element that carries the cap instead.
    //
    // The cap usually names several bars in one selector list, so the match has
    // to cross the `{` that opens that shared rule -- hence the explicit brace
    // rather than a plain [^{}] run. The bar's OWN rule is passed over
    // harmlessly: it has no max-width, so the scan simply moves to the next
    // occurrence of the selector, which is the cap.
    const byName = new RegExp(
      escapeRe(selector) + '[^{}]{0,200}' + BS + '{[^{}]{0,400}?max-width:' + BS + 's*2000px');
    const inner = new RegExp(escapeRe(selector) + '-inner');
    if (byName.test(css) || inner.test(css)) continue;
    failures.push(file + ': fixed bar `' + selector + '` spans the viewport and ' +
                  'never restates the 2000px cap -- it will run full width');
  }
}

for (const rel of PAGES) {
  const css = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (!/id="ui-cap-2000"/.test(css)) failures.push(rel + ': missing the ui-cap-2000 style block');
  bodyIsCapped(css, rel);
  findEscapingFixedBars(css, rel);
}
for (const rel of SHEETS) {
  const css = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (!/ui-cap-2000/.test(css)) failures.push(rel + ': missing the ui-cap-2000 block');
  bodyIsCapped(css, rel);
  findEscapingFixedBars(css, rel);
}

if (failures.length) {
  console.error('FAIL ui-width-cap\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('PASS ui-width-cap (' + (PAGES.length + SHEETS.length) + ' programs capped at 2000px)');
