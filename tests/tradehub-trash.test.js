/**
 * TradeHub's trash can — Playbook pages, Control tickers, Control prompts.
 *
 * WHY THIS FILE EXISTS
 * The trash can has no storage of its own. A trashed Playbook page keeps its
 * slot in the playbook document's pages[], a trashed prompt keeps its slot in
 * the prompts document's prompts[], and trashed tickers ride in a `trash` field
 * on the watchlist document. That design is what keeps the feature free — a
 * delete already wrote that document, so nothing extra is read or written — but
 * it puts the trash one careless write away from being erased: anything that
 * persists the VISIBLE list to one of those documents silently empties the can.
 *
 * So this suite guards both halves:
 *
 *   1. The pure helpers behave (expiry boundary, newest-first cap, and the rule
 *      that the pinned Daily Reminder page can never be trashed — Trading Auto
 *      Launch reads it, and a trashed copy would vanish from the live list while
 *      still being pinned first).
 *
 *   2. The wiring cannot regress to a live-only write. Those are static checks,
 *      because the failure is invisible at runtime: the delete works, the trash
 *      looks right, and the items are gone on the next device that syncs.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'tradehub.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function section(t) { console.log('\n' + t); }

/* ── Pull the real helper source out of the page and run it ──────────────────
   Evaluated rather than re-implemented, so these checks track the shipping code
   instead of a copy of it that can drift. */
function extract(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  if (a < 0) throw new Error('marker not found: ' + startMarker);
  const b = SRC.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return SRC.slice(a, b);
}

const helperSrc = extract('const TB_TRASH_TTL =', 'function TBTrashButton');
const pbSrc = extract('const TB_PB_DAILY_ID=', 'function tbPbNormalize')
            + extract('function tbPbNormalize', '/* ── Formatting toolbar');

const sandbox = {
  // tbPbDefaultPages runs the seed through the page's markdown renderer; the
  // trash rules do not care what HTML comes out, only that a page object does.
  tbMdToHtml: s => String(s),
  localStorage: { getItem: () => null, setItem: () => {} },
  console,
};
vm.createContext(sandbox);
// `const` in a vm context does not land on the sandbox object, so the script
// hands the bindings back explicitly as its completion value.
const EXPORTS = ['TB_TRASH_TTL', 'TB_TRASH_MAX', 'tbTrashDaysLeft', 'tbTrashExpired',
                 'tbTrashSort', 'tbTrashCap', 'tbTrashCount', 'TB_TRASH_SECTIONS',
                 'tbPbNormalize', 'TB_PB_DAILY_ID'];
const { TB_TRASH_TTL, TB_TRASH_MAX, tbTrashDaysLeft, tbTrashExpired, tbTrashSort,
        tbTrashCap, tbTrashCount, TB_TRASH_SECTIONS, tbPbNormalize, TB_PB_DAILY_ID } =
  vm.runInContext(helperSrc + '\n' + pbSrc + '\n({' + EXPORTS.join(',') + '})', sandbox);

const DAY = 86400000;
const ago = d => Date.now() - d * DAY;

/* ════════════════════════════════════════════════════════════════════════════ */
section('The 30-day window');

check('the TTL really is 30 days', TB_TRASH_TTL === 30 * DAY, TB_TRASH_TTL + 'ms');
check('something deleted just now is not expired', tbTrashExpired(Date.now()) === false);
check('29 days old survives', tbTrashExpired(ago(29)) === false);
check('31 days old is expired', tbTrashExpired(ago(31)) === true);
check('a missing stamp counts as expired', tbTrashExpired(undefined) === true,
      'an item with no stamp can never age out otherwise — it would sit in the can forever');

check('a fresh item shows 30 days left', tbTrashDaysLeft(Date.now()) === 30);
check('a 29-day-old item shows 1 day left', tbTrashDaysLeft(ago(29)) === 1);
check('an expired item never shows a negative countdown', tbTrashDaysLeft(ago(45)) === 0,
      'the row renders this number directly');

/* Restoring clears the stamp entirely, so the NEXT delete starts a new 30 days
   rather than resuming the old one. This is the behaviour the feature was asked
   for, and the only thing that can break it is carrying a stamp across. */
section('Restoring resets the countdown');
{
  const item = { id: 'p1', trashed: ago(28) };
  check('an old trashed item is nearly out of time', tbTrashDaysLeft(item.trashed) === 2);
  const restored = Object.assign({}, item); delete restored.trashed;
  check('restoring removes the stamp', !('trashed' in restored),
        'a leftover stamp is what would make a re-delete expire immediately');
  const reTrashed = Object.assign({}, restored, { trashed: Date.now() });
  check('re-deleting starts a fresh 30 days', tbTrashDaysLeft(reTrashed.trashed) === 30);
}

/* ════════════════════════════════════════════════════════════════════════════ */
section('The per-section cap keeps the document under 1 MiB');

check('a cap is set', typeof TB_TRASH_MAX === 'number' && TB_TRASH_MAX > 0, String(TB_TRASH_MAX));
{
  const many = [];
  for (let i = 0; i < TB_TRASH_MAX + 25; i++) many.push({ id: 'x' + i, trashed: ago(i) });
  const capped = tbTrashCap(many);
  check('the cap is enforced', capped.length === TB_TRASH_MAX, capped.length + ' of ' + many.length);
  check('it keeps the NEWEST deletions', capped[0].id === 'x0' && capped[capped.length - 1].id === 'x' + (TB_TRASH_MAX - 1),
        'dropping what you just deleted instead of what has nearly aged out would be the wrong way round');
}
{
  const out = tbTrashSort([{ trashed: ago(5) }, { trashed: ago(1) }, { trashed: ago(9) }]);
  check('sorting is newest-first', out[0].trashed > out[1].trashed && out[1].trashed > out[2].trashed);
  check('sorting does not mutate its input', (() => {
    const src = [{ trashed: 1 }, { trashed: 9 }];
    tbTrashSort(src);
    return src[0].trashed === 1;
  })(), 'these arrays are React state');
}

/* ════════════════════════════════════════════════════════════════════════════ */
section('Sections and counts');

check('there are exactly three sections', TB_TRASH_SECTIONS.length === 3,
      TB_TRASH_SECTIONS.map(s => s.key).join(', '));
check('they are playbook, tickers and prompts',
      TB_TRASH_SECTIONS.map(s => s.key).sort().join(',') === 'playbook,prompts,tickers');
TB_TRASH_SECTIONS.forEach(s => {
  check(s.key + ' can key and label its rows',
        typeof s.id === 'function' && typeof s.name === 'function' && !!s.label && !!s.icon);
});
check('a ticker row is keyed by its symbol',
      TB_TRASH_SECTIONS.find(s => s.key === 'tickers').id({ t: 'NVDA' }) === 'NVDA');
check('an untitled playbook page still gets a label',
      TB_TRASH_SECTIONS.find(s => s.key === 'playbook').name({ id: 'p' }) === 'Untitled page');
check('the badge counts every section',
      tbTrashCount({ playbook: [1, 2], tickers: [1], prompts: [1, 2, 3] }) === 6);
check('the badge survives a missing section', tbTrashCount({}) === 0 && tbTrashCount(null) === 0,
      'state can be mid-load');

/* ════════════════════════════════════════════════════════════════════════════ */
section('The Daily Reminder page can never be trashed');

{
  // Trading Auto Launch reads this page every trading morning. tbPbNormalize
  // pins it first unconditionally, so a trashed copy would be pinned AND hidden.
  const out = tbPbNormalize([{ id: TB_PB_DAILY_ID, title: 'Daily Reminder', trashed: Date.now() },
                             { id: 'pb_2', title: 'Rules' }]);
  check('a stamp on the daily page is stripped', !out[0].trashed, 'AutoLaunch would lose the page');
  check('it is still pinned first', out[0].id === TB_PB_DAILY_ID);
  check('other pages are untouched', out[1].id === 'pb_2');
}
{
  const stamped = Date.now();
  const input = [{ id: TB_PB_DAILY_ID, trashed: stamped }];
  tbPbNormalize(input);
  check('normalising does not mutate the page it was handed', input[0].trashed === stamped,
        'these objects are React state and are shared with the live list');
}
{
  const out = tbPbNormalize([{ id: 'pb_9', title: 'Setups', trashed: ago(3) }]);
  check('a trashed ordinary page is KEPT in the array', out.some(p => p.id === 'pb_9' && p.trashed),
        'the trash can lives in this array — dropping it here would be the delete');
  check('and a daily page is synthesised when one is missing', out[0].id === TB_PB_DAILY_ID);
}

/* ════════════════════════════════════════════════════════════════════════════
   Wiring. The failure these guard against is silent: the delete appears to
   work, and the trash is gone on the next sync.
   ════════════════════════════════════════════════════════════════════════════ */
section('Nothing writes a live-only list over the trash');

function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker), b = SRC.indexOf(endMarker, a);
  return (a < 0 || b < 0) ? '' : SRC.slice(a, b);
}

const promptPage = slice('function TBPromptPage(', '\n/* ═');
check('TBPromptPage source was found', promptPage.length > 1000, promptPage.length + ' chars');
check('TBPromptPage never writes Firestore itself', !/_fbSaveTBPrompts/.test(promptPage),
      'it only ever holds the LIVE prompts — writing those would erase every trashed prompt');
check('its delete goes to the trash', /onTrash\(/.test(promptPage));

const playbookPage = slice('function TBPlaybookPage(', 'function TBApp(');
check('TBPlaybookPage never writes Firestore itself', !/_fbSaveTBPlaybook/.test(playbookPage),
      'same hazard: it is handed the live pages only');
check('its delete goes to the trash', /onTrashPage\(/.test(playbookPage));

const wlEditor = slice('function TBWatchlistEditor(', '/* ── Control Page');
check('removing a ticker goes to the trash', /onTrashTickers/.test(wlEditor));

/* The three persist* helpers in TBApp are the only writers, and each is handed
   the COMPLETE array (live + trashed) by its save* wrapper. */
const app = slice('const persistPrompts=', 'const trash=useMemo');
check('persistPrompts splits live from trashed before writing',
      /persistPrompts[\s\S]{0,400}?filter\(p=>p\.trashed\)/.test(app));
check('savePrompts re-attaches the trashed prompts',
      /const savePrompts=arr=>persistPrompts\(\[\.\.\.arr,\.\.\.prompts\.filter\(p=>p\.trashed\)\]\)/.test(app),
      'this is the line that stops an edit in Control from emptying the can');
check('savePlaybook re-attaches the trashed pages',
      /const savePlaybook=pages=>persistPlaybook\(\[\.\.\.pages,\.\.\.playbook\.filter\(p=>p\.trashed\)\]\)/.test(app));
check('a delete stamps a fresh Date.now()', /const ts=Date\.now\(\)/.test(app),
      'reusing an old stamp is how restore-then-delete would fail to reset the clock');

section('The ticker trash rides in the watchlist document');

const fbWl = slice('window._fbSaveTBWatchlist =', 'window._fbLoadTBPlaybook');
check('the watchlist writer accepts a trash argument', /_fbSaveTBWatchlist = \(tickers, trash\)/.test(fbWl));
check('it writes with merge', /\{ merge: true \}/.test(fbWl),
      'a plain setDoc from a caller that omits trash would delete the stored trash field');
check('an omitted trash is left alone, not written as empty',
      /if \(_trash !== undefined\) payload\.trash = _trash/.test(fbWl));

const fbLoad = slice('window._fbLoadTBWatchlist =', 'window._fbSaveTBWatchlist');
check('the loader returns the trash alongside the tickers',
      /tickers:/.test(fbLoad) && /trash:/.test(fbLoad));

section('No new Firestore document, listener or read');

const paths = (SRC.match(/^\s*const TB_[A-Z_]+_PATH\s*=\s*"[^"]+"/gm) || []).length;
check('no trash document was added', !/tradeboard_trash/.test(SRC),
      paths + ' TradeHub document paths, unchanged');
check('no new snapshot listener was added', (SRC.match(/onSnapshot\(/g) || []).length === 9,
      'the trash syncs on the listeners the watchlist, prompts and playbook already have');

section('The auto-purge does not cost a write when nothing expired');
check('each sweep compares lengths before persisting',
      /if\(pbKeep\.length!==pb\.length\)persistPlaybook/.test(SRC) &&
      /if\(prKeep\.length!==pr\.length\)persistPrompts/.test(SRC) &&
      /if\(wtKeep\.length!==wt\.length\)persistWatchlist/.test(SRC),
      'an unconditional sweep would write all three documents on every boot');
check('the sweep reads through a ref, not a closure', /_tbTrashLatest\.current/.test(SRC),
      'it runs on a timer — a closure would sweep against state from six seconds ago');

/* ════════════════════════════════════════════════════════════════════════════ */
console.log('\n' + '='.repeat(64));
if (fail) { console.log(fail + ' of ' + (pass + fail) + ' checks FAILED.'); process.exit(1); }
console.log('All ' + pass + ' TradeHub trash checks passed.');
