#!/usr/bin/env node
/**
 * Archive/un-archive regression tests.
 *
 * WHY THIS FILE EXISTS
 * Veda reported "my tasks reverted by a lot of days" after opening TaskHub on
 * her phone. It was NOT one of the three known sync races. The real cause:
 *
 *   1. `data` grew past TH_ARCHIVE_SOFT_BYTES (780 KB).
 *   2. thSplitArchivable's overflow branch then stopped archiving only
 *      6-year-old days and began moving RECENT days (oldest-first) into
 *      per-year sidecar docs until the live doc fit — 226 days in repro.
 *   3. The archiver called setData(split.keep), so those days vanished from
 *      the UI as well as the live doc.
 *   4. The un-archive that should have restored them REFUSED, because merging
 *      them back exceeded the very same 780 KB cap. The two guards deadlocked
 *      and the history could never come back.
 *
 * Nothing was ever lost server-side, which is exactly why it read as a revert.
 *
 * WHY IT CAME BACK (2026-09-01, "my last 5 days are gone")
 * The fix above kept archived days on screen via an in-memory registry, but the
 * registry was memory-only while the MERGED data was written to localStorage.
 * Three consequences, all now tested here:
 *
 *   A. On the next cold load the cache held archived history with no flag on it,
 *      so buildPayload uploaded ~1.1 MB back into the live doc — re-inflating it
 *      or tripping the 900 KB write guard and stopping sync outright.
 *   B. The archiver then saw an oversize doc again and ran the size valve, which
 *      stopped only at TODAY. So it kept eating forward, one bite per device per
 *      day, until it was archiving LAST WEEK.
 *   C. The restore was latched once-per-device (td*_unarchived_v2), while the
 *      archiver runs once per device per DAY — so days the phone archived after
 *      the PC's single restore were simply absent on the PC, permanently.
 *
 * Fixes: persist the registry (thLoad/thSaveArchivedKeys), give the valve a real
 * floor (TH_ARCHIVE_MIN_AGE_DAYS), drop the latch so the restore runs every load,
 * and reclaim recent days the old valve took back into the live document.
 *
 * Run: node tests/archive-visibility.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  \u2717 ' + name); }
}
function section(s) { console.log('\n' + s); }

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

section('Static: archived days stay visible and stay out of writes');

t('Veda tracks archived day-keys in a PERSISTED ref',
  /const vdArchivedRef=useRef\(thLoadArchivedKeys\("td_archivedKeys"\)\)/.test(HTML),
  'A memory-only registry forgets on reload while the merged data survives in ' +
  'localStorage — the next save then re-uploads archived history into the live doc.');

t('buildVdPayload strips archived day-keys from the upload',
  /sanitizeData=d=>\{[^\n]*vdArchivedRef\.current\[dk\]\)return;/.test(HTML),
  'Re-uploading archived days would re-create the oversize doc that pruned them.');

t('un-archive no longer refuses on the soft-byte cap',
  !/\[Unarchive\] Veda: restore would be/.test(HTML),
  'That size gate deadlocked against the prune: restoring re-made the oversize doc.');

t('un-archive renders read-only history without pushing it',
  /setDataLocalOnly\(merged\)/.test(HTML),
  'Display-only history must not enqueue a cloud write; only a RECLAIM does.');

t('a read failure is not mistaken for an empty sidecar',
  (HTML.match(/if\(a===null\)throw new Error\("archive read failed for "\+y\);/g) || []).length === 2,
  'Treating a failed read as "no archive for that year" would rebuild the registry ' +
  'from a partial scan and un-flag history that is still only in a sidecar.');

t('setDataLocalOnly exists and does not call vdFbPush',
  /const setDataLocalOnly=useCallback\(next=>\{setDataState\(prev=>\{[^}]*saveJ\(SK\.data,n\)/.test(HTML) &&
  !/const setDataLocalOnly=useCallback\([^;]*vdFbPush/.test(HTML),
  'It must write state + localStorage only.');

const _vdArchIdx = HTML.indexOf('_fbArchiveDays("vedasdash"');
const _vdArchBody = HTML.slice(_vdArchIdx, HTML.indexOf('const t=setTimeout(run,20000)', _vdArchIdx));
t('Veda archiver keeps just-archived days on screen (no live setData(split.keep))',
  !/^\s*setData\(split\.keep\);/m.test(_vdArchBody) && /setDataLocalOnly\(_merged\)/.test(_vdArchBody),
  'Pruning the live doc must not also delete the days from the UI.');

t('archiver excludes already-archived keys from the splitter',
  /if\(!vdArchivedRef\.current\[k\]\)_liveOnly\[k\]=v;/.test(HTML),
  'Otherwise restored history gets re-archived on every pass.');

t('no persisted un-archive latch survives (Veda)',
  !/localStorage\.(get|set)Item\("td_unarchived_v\d"/.test(HTML),
  'A once-per-DEVICE restore cannot recover from a once-per-device-per-DAY archiver: ' +
  'days the phone archived after the PC restored were unreachable on the PC forever.');

t('Veda restore persists the rebuilt registry',
  /thSaveArchivedKeys\("td_archivedKeys",nextArchived\)/.test(HTML));

t('Veda archiver persists newly archived keys',
  /thSaveArchivedKeys\("td_archivedKeys",vdArchivedRef\.current\)/.test(HTML));

t('Veda archiver refuses to prune before the restore has run',
  /if\(!unarchiveRanRef\.current\)return;[\s\S]{0,400}?"td_archive_at"/.test(HTML),
  'Pruning first would measure history the restore has not recognised yet, and its ' +
  'fresh flags would be overwritten by the registry rebuild moments later.');

t('Veda restore reclaims recent days as editable',
  /const floorKey=thMinAgeKey\(\);[\s\S]{0,800}?delete nextArchived\[k\];reclaimed\.push\(k\)/.test(HTML) &&
  /if\(reclaimed\.length\)\{reclaimed\.sort\(\);vdFbPush\(\);\}/.test(HTML),
  'Days the old valve took out of the recent window must go BACK into the live doc, ' +
  'editable — and that needs a real write, not just setDataLocalOnly.');

t('archived days are read-only in the UI',
  (HTML.match(/vdArchivedRef\.current\[k\]\)\{if\(window\._planReadOnlyNudge\)/g) || []).length >= 2,
  'Both tog() and del() must refuse edits to archived day-keys.');

section('The reclaim converges (2026-09-01 regression)');

// Reclaiming pulls a day out of the sidecar back into the live document. The
// sidecar is NEVER pruned, so without remembering that a day was already
// reclaimed, the next load re-flags it from the sidecar, reclaims it again and
// pushes the whole ~640 KB document again — on every page load, on every
// device, forever, racing whatever the user is typing. The reported symptom was
// "edits hang on Syncing and a refresh loses my changes".
['td6_reclaimedKeys', 'td_reclaimedKeys'].forEach((k) => {
  t('a persisted reclaimed-set exists (' + k + ')',
    HTML.includes('thLoadArchivedKeys("' + k + '")') &&
    HTML.includes('thSaveArchivedKeys("' + k + '",reclaimedEver)'),
    'Without this the reclaim never converges.');
});
t('the sidecar scan skips keys already reclaimed',
  (HTML.match(/if\(!reclaimedEver\[k\]\)nextArchived\[k\]=true;/g) || []).length === 2,
  'Re-flagging a reclaimed day is what made the push repeat on every load.');
t('a reclaim is recorded so it is not repeated',
  (HTML.match(/reclaimed\.forEach\(k=>\{reclaimedEver\[k\]=true;\}\);/g) || []).length === 2);
t('the push only happens when something was actually reclaimed',
  (HTML.match(/if\(reclaimed\.length\)\{reclaimed\.sort\(\);(fbPush|vdFbPush)\(\);\}/g) || []).length === 2,
  'A push with nothing to say is a large write for no reason.');

section("Static: the same fix is ported to Tony's TaskHub");

t('Tony tracks archived day-keys in a PERSISTED ref',
  /const thArchivedRef=useRef\(thLoadArchivedKeys\("td6_archivedKeys"\)\)/.test(HTML));

t('buildPayload strips archived day-keys from the upload',
  /if\(thArchivedRef\.current\[dk\]\)return;/.test(HTML),
  'Re-uploading archived days would re-create the oversize doc that pruned them.');

t('Tony un-archive no longer refuses on the soft-byte cap',
  !/\[Unarchive\] Tony: restore would be/.test(HTML));

t('no persisted un-archive latch survives (Tony)',
  !/localStorage\.(get|set)Item\("td6_unarchived_v\d"/.test(HTML));

t('Tony restore persists the rebuilt registry',
  /thSaveArchivedKeys\("td6_archivedKeys",nextArchived\)/.test(HTML));

t('Tony archiver persists newly archived keys',
  /thSaveArchivedKeys\("td6_archivedKeys",thArchivedRef\.current\)/.test(HTML));

t('Tony archiver refuses to prune before the restore has run',
  /if\(!unarchiveRanRef\.current\)return;[\s\S]{0,400}?"td6_archive_at"/.test(HTML));

t('Tony restore reclaims recent days as editable',
  /if\(reclaimed\.length\)\{reclaimed\.sort\(\);fbPush\(\);\}/.test(HTML));

const _thArchIdx = HTML.indexOf('_fbArchiveDays("main"');
const _thArchBody = HTML.slice(_thArchIdx, HTML.indexOf('const t=setTimeout(run,20000)', _thArchIdx));
t('Tony archiver keeps just-archived days on screen',
  !/^\s*setData\(split\.keep\);/m.test(_thArchBody) && /setDataLocalOnly\(_merged\)/.test(_thArchBody));

t('Tony archiver excludes already-archived keys from the splitter',
  /if\(!thArchivedRef\.current\[k\]\)_liveOnly\[k\]=v;/.test(HTML));

t('Tony archived days are read-only in the UI',
  (HTML.match(/thArchivedRef\.current\[k\]\)\{if\(window\._planReadOnlyNudge\)/g) || []).length >= 2,
  'Both tog() and del() must refuse edits to archived day-keys.');

t('the size valve stops at a recent-days floor, not at today',
  !/if\(k>=todayKey\)break;/.test(HTML) &&
  (HTML.match(/const floorKey=thMinAgeKey\(\);\s*for\(const k of recent\)\{\s*if\(k>=floorKey\)break;/g) || []).length === 2,
  '`k>=todayKey` protected exactly one day, so an oversize doc archived yesterday.');

t('an unfixable oversize doc is reported, not paid for with recent days',
  (HTML.match(/if\(over>TH_ARCHIVE_SOFT_BYTES\)out\.overCap=over;/g) || []).length === 2 &&
  (HTML.match(/if\(split\.overCap\)console\.error/g) || []).length === 2);

t('no LIVE setData(split.keep) call survives anywhere in the file',
  !HTML.split(/\r?\n/).some(l => /setData\(split\.keep\)/.test(l) && !/^\s*\/\//.test(l)),
  'Both profiles must keep archived days visible after a prune (comments are fine).');

// ───────────────────────── behavioural ─────────────────────────
section('Behaviour: the real thSplitArchivable overflow branch');

// Lift the shipped functions straight out of index.html (Veda scope).
function grab(name, from) {
  const i = HTML.indexOf('function ' + name + '(', from);
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, started = false, j = i;
  for (; j < HTML.length; j++) {
    const c = HTML[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) { j++; break; } }
  }
  return HTML.slice(i, j);
}
const vedaScope = HTML.indexOf('Weekly-data retention (mirror of');
const vedaTop = HTML.lastIndexOf('function dkey(', vedaScope);
const src = [grab('dkey', vedaTop), grab('thDataBytes', vedaScope),
             grab('thTodayKey', vedaScope), grab('thMinAgeKey', vedaScope),
             grab('thLoadArchivedKeys', vedaScope), grab('thSaveArchivedKeys', vedaScope),
             grab('thSplitArchivable', vedaScope)].join('\n');
const TH_DAYKEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TH_ARCHIVE_YEARS = 6, TH_ARCHIVE_SOFT_BYTES = 780000;
// Read the floor out of the shipped source rather than restating it here, so
// nobody can quietly shrink the guard and still have these tests pass.
const TH_ARCHIVE_MIN_AGE_DAYS = Number(/const TH_ARCHIVE_MIN_AGE_DAYS=(\d+);/.exec(HTML)[1]);
// The registry helpers really do touch localStorage, so give them one.
const _store = {};
const localStorageShim = {
  getItem: k => (k in _store ? _store[k] : null),
  setItem: (k, v) => { _store[k] = String(v); }
};
const { thSplitArchivable, thDataBytes, dkey, thMinAgeKey,
        thLoadArchivedKeys, thSaveArchivedKeys } = new Function(
  'TH_DAYKEY_RE', 'TH_ARCHIVE_YEARS', 'TH_ARCHIVE_SOFT_BYTES',
  'TH_ARCHIVE_MIN_AGE_DAYS', 'localStorage',
  src + '\nreturn {thSplitArchivable,thDataBytes,thTodayKey,dkey,thMinAgeKey,' +
        'thLoadArchivedKeys,thSaveArchivedKeys};'
)(TH_DAYKEY_RE, TH_ARCHIVE_YEARS, TH_ARCHIVE_SOFT_BYTES,
  TH_ARCHIVE_MIN_AGE_DAYS, localStorageShim);

// ~4 years of realistic daily tasks. Two years no longer overflows on its own now
// that the floor protects the recent window, and the point of this fixture is to
// make the valve actually fire with plenty of archivable history behind the floor.
const data = {};
const today = new Date();
function mk(n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push({ id: 'id' + i, type: 'task', done: i % 2 === 0,
    title: 'Some reasonably long task title for realism ' + i, category: 'study', notes: 'x'.repeat(120) });
  return a;
}
for (let back = 0; back < 1460; back++) {
  const d = new Date(today); d.setDate(d.getDate() - back);
  data[dkey(d.getFullYear(), d.getMonth(), d.getDate())] = mk(6);
}

const split = thSplitArchivable(data);
const movedKeys = [];
Object.keys(split.byYear).forEach(y => Object.keys(split.byYear[y]).forEach(k => movedKeys.push(k)));

t('the overflow branch really does move recent (in-window) days',
  movedKeys.length > 0,
  'If this stops being true the scenario changed; the guards below still matter.');

t('the live doc really is pruned under the cap',
  thDataBytes(split.keep) <= TH_ARCHIVE_SOFT_BYTES);

// The deadlock: merging the archive back exceeds the cap that caused the prune.
const merged = { ...split.keep };
Object.keys(split.byYear).forEach(y => Object.entries(split.byYear[y]).forEach(([k, v]) => { merged[k] = v; }));
t('restoring the archive exceeds the soft cap (this is why the old gate deadlocked)',
  thDataBytes(merged) > TH_ARCHIVE_SOFT_BYTES,
  'The old un-archive returned early here, so the days could never come back.');

// With the fix, the merged view is what the user sees, and the payload is what ships.
const archivedFlags = {};
movedKeys.forEach(k => { archivedFlags[k] = true; });
const payloadData = {};
Object.entries(merged).forEach(([k, v]) => { if (!archivedFlags[k]) payloadData[k] = v; });

t('every archived day is visible in the merged UI state',
  movedKeys.every(k => k in merged),
  'No day may disappear from the grid just because it left the live document.');

t('no archived day is present in the upload payload',
  movedKeys.every(k => !(k in payloadData)));

t('the upload payload still fits under the soft cap',
  thDataBytes(payloadData) <= TH_ARCHIVE_SOFT_BYTES,
  'Visibility must not cost live-document bytes.');

t('the payload keeps every non-archived day',
  Object.keys(merged).filter(k => !archivedFlags[k]).every(k => k in payloadData));

// ────────── the 2026-09-01 recurrence: recent days must survive ──────────
section('Behaviour: the size valve may never touch recent days');

// The reported symptom, stated as data.
const lastFive = [];
for (let back = 1; back <= 5; back++) {
  const d = new Date(today); d.setDate(d.getDate() - back);
  lastFive.push(dkey(d.getFullYear(), d.getMonth(), d.getDate()));
}
const floorKey = thMinAgeKey();

t('the floor sits ' + TH_ARCHIVE_MIN_AGE_DAYS + ' days back, well clear of this week',
  lastFive.every(k => k > floorKey));

// A floor is only useful if the archiver can still get under the cap WITH it in
// place. 550 days was tried first and is 800 KB at this density — over the cap on
// its own, which would have left the doc permanently oversize.
const protectedWindow = {};
Object.keys(data).forEach(k => { if (k >= floorKey) protectedWindow[k] = data[k]; });
t('the protected window itself fits under the soft cap',
  thDataBytes(protectedWindow) <= TH_ARCHIVE_SOFT_BYTES,
  'At ~' + Math.round(thDataBytes(protectedWindow) / Object.keys(protectedWindow).length) +
  ' bytes/day the floor costs ' + (thDataBytes(protectedWindow) / 1024).toFixed(0) +
  ' KB of a ' + (TH_ARCHIVE_SOFT_BYTES / 1024).toFixed(0) + ' KB budget. Raise the floor ' +
  'and the archiver can no longer reach the cap at all.');

t('NO day inside the floor is archived, even though the doc is far over the cap',
  movedKeys.every(k => k < floorKey),
  'This is the whole bug: the old valve stopped at todayKey, so it archived ' +
  'yesterday, then the day before, one bite per device per day.');

t('specifically, all five of the reported days survive in the live doc',
  lastFive.every(k => k in split.keep) && lastFive.every(k => !movedKeys.includes(k)),
  'Veda opened TaskHub and found the last five days gone.');

t('an oversize doc that cannot be fixed is REPORTED, not paid for',
  thDataBytes(split.keep) > TH_ARCHIVE_SOFT_BYTES
    ? split.overCap === thDataBytes(split.keep)
    : split.overCap === undefined,
  'overCap is how the archiver knows to shout instead of eating the present.');

section('Behaviour: the archived-key registry survives a reload');

// A device archives, flags the keys, persists the registry — then the tab closes.
const reg = {};
movedKeys.forEach(k => { reg[k] = true; });
thSaveArchivedKeys('td_archivedKeys', reg);

// …and comes back. `data` rehydrates from localStorage still holding the merged
// history, because that is exactly what setDataLocalOnly wrote to it.
const coldData = { ...merged };
const coldReg = thLoadArchivedKeys('td_archivedKeys');

t('every archived key is still flagged after a cold load',
  movedKeys.length > 0 && movedKeys.every(k => coldReg[k] === true),
  'A memory-only registry came back empty here, which is how archived history got ' +
  're-uploaded into the live document on the very next save.');

const coldPayload = {};
Object.entries(coldData).forEach(([k, v]) => { if (!coldReg[k]) coldPayload[k] = v; });

t('the cold-load payload still excludes archived history',
  movedKeys.every(k => !(k in coldPayload)));

t('the cold-load payload stays under the 900 KB write guard',
  thDataBytes(coldPayload) <= 900000 && thDataBytes(coldData) > thDataBytes(coldPayload),
  'Without the persisted registry this payload was the full merged doc, which the ' +
  'guard refuses outright — sync stops and the device silently diverges.');

t('an absent registry reads as empty rather than throwing',
  Object.keys(thLoadArchivedKeys('td_nope_not_a_key')).length === 0);

section('Behaviour: recent days archived by the OLD valve are reclaimed');

// What Veda's device looks like right now: a registry left behind by the pre-fix
// valve, flagging days that are only a few days old.
const staleReg = { ...reg };
lastFive.forEach(k => { staleReg[k] = true; });
const staleMerged = { ...merged };

// The shipped reclaim rule, applied to that state.
const reclaimable = Object.keys(staleReg).filter(k => k >= floorKey && (k in staleMerged));

t('the reclaim rule selects exactly the wrongly-archived recent days',
  lastFive.every(k => reclaimable.includes(k)) && reclaimable.every(k => k >= floorKey),
  'Old history stays read-only; only what the valve should never have taken comes back.');

// The shipped loop is budgeted: newest-first, stopping at the cap, so a reclaim
// can never re-create the oversize document that started all of this.
const afterReclaim = { ...staleReg };
const liveOnly = {};
Object.keys(staleMerged).forEach(k => { if (!afterReclaim[k]) liveOnly[k] = staleMerged[k]; });
let liveBytes = thDataBytes(liveOnly);
const reclaimed = [];
for (const k of reclaimable.slice().sort().reverse()) {
  const add = thDataBytes({ [k]: staleMerged[k] });
  if (liveBytes + add > TH_ARCHIVE_SOFT_BYTES) break;
  liveBytes += add; delete afterReclaim[k]; reclaimed.push(k);
}
const reclaimedPayload = {};
Object.entries(staleMerged).forEach(([k, v]) => { if (!afterReclaim[k]) reclaimedPayload[k] = v; });

t('reclaimed days are back in the upload payload (editable again)',
  lastFive.every(k => reclaimed.includes(k)) && lastFive.every(k => k in reclaimedPayload),
  'The newest days are taken first, so the ones the user just lost come back first.');

t('reclaiming does not re-create an oversize live document',
  thDataBytes(reclaimedPayload) <= TH_ARCHIVE_SOFT_BYTES,
  'The shipped loop adds days newest-first and stops at the cap for exactly this.');

t('genuinely old history is NOT reclaimed',
  movedKeys.filter(k => k < floorKey).every(k => afterReclaim[k] === true));

console.log('\n' + '─'.repeat(64));
if (fail) {
  console.log(fail + ' FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('All ' + pass + ' archive-visibility checks passed.');
