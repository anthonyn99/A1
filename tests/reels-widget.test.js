/* ============================================================================
 * reels-widget.test.js — static checks on the saved-reels widget (window.THRL)
 * ============================================================================
 * These are SOURCE assertions, not DOM tests. The widget's behaviour is verified
 * in a real browser separately (CDP, see the `verify` skill), but that harness
 * cannot run in CI: Firebase App Check refuses to authenticate any origin it is
 * not registered for, so no Firestore snapshot ever arrives there.
 *
 * WHY THIS FILE EXISTS AT ALL
 * On 2026-09-16 three edits to this widget were reported as applied and then
 * silently lost (the patch script asserted its anchors, printed "ok", and died
 * before writing). The result was JS that referenced CSS classes which did not
 * exist and a store field that was never declared — the panel rendered
 * unstyled and the player never opened. Nothing failed; it just quietly did
 * not work. Every invariant below is one that was broken that way and would
 * have been caught in a second by a check this cheap.
 *
 * Run:  node tests/reels-widget.test.js
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let PASS = 0, FAIL = 0;
function t(name, cond, extra) {
  if (cond) { PASS++; console.log('  ok   ' + name); }
  else { FAIL++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

// The widget's script block, so assertions cannot accidentally match another
// part of this 45k-line file.
const start = html.indexOf("var LS_CFG='thrl_cfg_v1'");
const end = html.indexOf('window.THRL={', start);
const blk = start >= 0 && end > start ? html.slice(start, end) : '';
const surface = end >= 0 ? html.slice(end, html.indexOf('})();', end)) : '';

console.log('\nreels widget — module');
t('the widget block is present', blk.length > 1000, `found ${blk.length} chars`);
t('it guards on React being absent',
  html.includes("if(!window.React) return;"),
  'a missing guard takes the whole page down with the widget');

// ── The store ────────────────────────────────────────────────────────────────
// emit() rebuilds S as a fresh literal; any field missing from EITHER the
// declaration or that literal silently becomes undefined, and every consumer
// reads a blank. This is exactly how the player failed to open.
console.log('\nstore fields survive emit()');
const decl = (blk.match(/var S=\{[\s\S]*?\};/) || [''])[0];
const emitLit = (blk.match(/S=\{reels:S\.reels[\s\S]*?\};/) || [''])[0];
for (const f of ['reels', 'at', 'collection', 'filesBase', 'idx',
                 'collections', 'omitted', 'playing']) {
  t(`\`${f}\` is declared`, new RegExp('\\b' + f + ':').test(decl), decl.slice(0, 160));
  t(`\`${f}\` survives emit()`, new RegExp('\\b' + f + ':S\\.' + f).test(emitLit),
    'emit() drops it, so every re-render sees undefined');
}
t('emit() builds a NEW object (React bails on a mutated one)',
  /function emit\(\)\{\s*\/\/[\s\S]*?S=\{/.test(blk) || /S=\{reels:S\.reels/.test(blk));

// ── Playback in the panel, not a browser tab ────────────────────────────────
console.log('\nreels play in the panel');
t('a tile click is intercepted', blk.includes('e.preventDefault();') &&
  blk.includes('S.playing=r.shortcode'),
  'tiles would navigate away — the redirect this feature removed');
t('a deliberate new-tab gesture is still honoured',
  blk.includes('e.metaKey||e.ctrlKey||e.shiftKey'),
  'ctrl/cmd/middle-click should still open Instagram');
t('the band card opens the player directly',
  blk.includes('S.playing=reel.shortcode'));
t("it frames Instagram's own embed page", blk.includes("/embed/"),
  'reels are DASH-segmented (79 paths for one 13s reel), so <video> is not an '
  + 'option and the embed is the only way to play one');
t('autoplay and muted are both requested',
  blk.includes('autoplay=1&muted=1'),
  'browsers only honour autoplay when muted; a feed needing a tap per reel '
  + 'is not a feed');
t('autoplay and fullscreen are permitted on the frame',
  /allow:'autoplay;[^']*fullscreen'/.test(blk));
t('the feed replaces the grid rather than stacking',
  blk.includes('feed||grid'));

// ── The feed ────────────────────────────────────────────────────────────────
// The ask was "that exact Instagram feel": no chrome, autoplay, loop, scroll to
// the next reel. These pin the parts that deliver it.
t('slides snap one reel at a time',
  html.includes('scroll-snap-type:y mandatory') &&
  html.includes('scroll-snap-stop:always'),
  'without scroll-snap-stop a flick skips several reels');
t("the embed's chrome is cropped by the slide, not styled away",
  html.includes('--thrl-crop-top') && html.includes('overflow:hidden'),
  'the header is inside a cross-origin document; only geometry can hide it');
t('the crop values are measured, not guessed',
  html.includes('--thrl-crop-top:54px') && html.includes('--thrl-video-ratio:1.2025'),
  'MEASURED at 300/340/400px: header is 54px always, video is width x 1.2');
t('the crop is width-relative, not a fixed footer offset',
  html.includes('var(--thrl-video-ratio)'),
  'a fixed offset was wrong at every width but the one it was guessed at');
t('only a window of slides mounts an iframe',
  blk.includes('MOUNT_RADIUS') && blk.includes('Math.abs(i - cur) <= MOUNT_RADIUS'),
  'mounting ~1239 iframes would be thousands of requests to Instagram on open');
t('unmounted slides still show their thumbnail',
  blk.includes("className:'thrl-slide-idle'"),
  'black gaps while scrolling ahead read as broken');
t('the visible slide is tracked with IntersectionObserver',
  blk.includes('IntersectionObserver') && blk.includes('threshold'),
  'a scroll handler would run on every frame');
t('the feed opens AT the chosen reel',
  blk.includes('startIdx') && blk.includes('scrollIntoView'),
  'it would otherwise always start at the top of the collection');
t('the caption overlays the video rather than sitting above it',
  html.includes('.thrl-slide-cap') && html.includes('pointer-events:none'),
  'a bar above the video is the chrome this change removes');
t('the feed panel drops its own scrolling',
  html.includes('.thrl-panel.thrl-panel-feed') && blk.includes('thrl-panel-feed'),
  'two nested scroll containers fight each other');
t('the feed contains its overscroll',
  html.includes('overscroll-behavior:contain'),
  'reaching the end would scroll the dashboard behind it');
t('playback stops when the panel closes',
  blk.includes('if(!open&&S.playing)'),
  'a mounted iframe in a closed tree keeps its audio going');
t('there is a way back to the grid', blk.includes("'thrl-back'"));
t('and an escape hatch to Instagram', blk.includes("'thrl-ext'"));

// ── Every class the JS uses must exist in the stylesheet ────────────────────
// The bug: JS referencing .thrl-player / .thrl-back / .thrl-ext while the CSS
// block had been lost, so the panel rendered with default browser styling
// (colliding text, blue links). Cheap to assert, invisible to miss.
console.log('\nevery referenced class is styled');
const used = [...new Set(
  (blk.match(/className:'(thrl-[a-z-]+)'/g) || [])
    .map((m) => m.replace(/.*'(thrl-[a-z-]+)'.*/, '$1'))
)];
t('the JS references some thrl- classes', used.length > 5, JSON.stringify(used));
for (const cls of used) {
  // The class must have a rule whose SUBJECT is this class, i.e. a declaration
  // block opening on it (possibly after a combinator or pseudo). Matching a
  // bare `.cls ` is not enough: `.thrl-player iframe{...}` would satisfy it
  // while the base `.thrl-player{...}` rule was missing — which is precisely
  // the loophole that let the lost stylesheet pass a first version of this test.
  const styled = new RegExp('\.' + cls + '(?:[:.][a-z-]+)*\s*(?:,|\{)').test(html);
  t(`.${cls} has a rule of its own`, styled,
    'referenced by the JS but never styled');
}

// ── Theming: zero hardcoded palette ─────────────────────────────────────────
console.log('\ntheming');
for (const v of ['--rl-s1', '--rl-bd', '--rl-tx', '--rl-ac', '--rl-radius']) {
  t(`${v} is mapped from the host's tokens`, blk.includes("'" + v + "'"));
}
t("the host's uppercase/mono/radius tokens are honoured",
  blk.includes('t.upper') && blk.includes('t.font') && blk.includes('t.radius'),
  'the card would look foreign in Veda\'s band');

// ── Cloud only ──────────────────────────────────────────────────────────────
console.log('\nnothing local');
t('no localhost bridge anywhere in the page',
  !html.includes('127.0.0.1:8781'),
  'the widget must read the cloud so the phone behaves like the PC');
t('no local sync function remains', !html.includes('window._reelsSync'));
t('the Firestore listener drops cached snapshots',
  html.includes('snap.metadata && snap.metadata.fromCache'),
  'a second doc\'s cached snapshot lands before the main doc and races it');
t('the reels listener is torn down with the others',
  html.includes('window._rlUnsubscribe();') &&
  html.includes('window._rlCfgUnsubscribe();'),
  'a surviving listener bills reads forever');

// ── Public surface ──────────────────────────────────────────────────────────
console.log('\npublic surface');
for (const k of ['Widget', 'state', 'refresh', 'ingest', 'configure',
                 'config', 'syncFromCloud', 'applyRemote']) {
  t(`THRL.${k} is exported`, new RegExp('\\b' + k + ':').test(surface), surface.slice(0, 200));
}
t('config() returns a deep clone',
  /config:function\(\)\{try\{return JSON\.parse\(JSON\.stringify/.test(surface),
  'callers could mutate CFG by reference');

// ── Veda-only ───────────────────────────────────────────────────────────────
console.log('\nrendered for Veda only');
const vedaBand = html.includes('window.THRL&&RC(window.THRL.Widget');
t('the widget is rendered in Veda\'s band', vedaBand);
t('the band carries the .thrl-band modifier',
  html.includes('"thwx-band thrl-band"'),
  'without it the phantom ::after double-counts the right column');
t('.thrl-band retires the phantom column',
  html.includes('.thrl-band::after{display:none;}'));
t('Tony\'s band never renders it',
  (html.match(/window\.THRL&&RC\(window\.THRL\.Widget/g) || []).length === 1,
  'more than one render site means it leaked into the other profile');

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
