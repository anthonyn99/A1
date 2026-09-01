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

t('Veda tracks archived day-keys in a ref',
  /const vdArchivedRef=useRef\(\{\}\)/.test(HTML),
  'vdArchivedRef is what separates "in the live doc" from "display-only history".');

t('buildVdPayload strips archived day-keys from the upload',
  /sanitizeData=d=>\{[^\n]*vdArchivedRef\.current\[dk\]\)return;/.test(HTML),
  'Re-uploading archived days would re-create the oversize doc that pruned them.');

t('un-archive no longer refuses on the soft-byte cap',
  !/\[Unarchive\] Veda: restore would be/.test(HTML),
  'That size gate deadlocked against the prune: restoring re-made the oversize doc.');

t('un-archive restores WITHOUT pushing to Firestore',
  /setDataLocalOnly\(merged\)/.test(HTML),
  'Display-only history must not enqueue a cloud write.');

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

t('the un-archive latch key was bumped past the stuck _v1',
  /localStorage\.getItem\("td_unarchived_v2"\)/.test(HTML) &&
  /localStorage\.setItem\("td_unarchived_v2","1"\)/.test(HTML) &&
  !/td_unarchived_v1/.test(HTML),
  'A device that took the old under-cap exit has _v1 stuck at "1"; reusing that key ' +
  'would skip the corrected restore and the archived days would never reappear.');

t('archived days are read-only in the UI',
  (HTML.match(/vdArchivedRef\.current\[k\]\)\{if\(window\._planReadOnlyNudge\)/g) || []).length >= 2,
  'Both tog() and del() must refuse edits to archived day-keys.');

section("Static: the same fix is ported to Tony's TaskHub");

t('Tony tracks archived day-keys in a ref',
  /const thArchivedRef=useRef\(\{\}\)/.test(HTML));

t('buildPayload strips archived day-keys from the upload',
  /if\(thArchivedRef\.current\[dk\]\)return;/.test(HTML),
  'Re-uploading archived days would re-create the oversize doc that pruned them.');

t('Tony un-archive no longer refuses on the soft-byte cap',
  !/\[Unarchive\] Tony: restore would be/.test(HTML));

t('Tony un-archive latch bumped past the stuck _v1',
  /td6_unarchived_v2/.test(HTML) && !/td6_unarchived_v1/.test(HTML));

const _thArchIdx = HTML.indexOf('_fbArchiveDays("main"');
const _thArchBody = HTML.slice(_thArchIdx, HTML.indexOf('const t=setTimeout(run,20000)', _thArchIdx));
t('Tony archiver keeps just-archived days on screen',
  !/^\s*setData\(split\.keep\);/m.test(_thArchBody) && /setDataLocalOnly\(_merged\)/.test(_thArchBody));

t('Tony archiver excludes already-archived keys from the splitter',
  /if\(!thArchivedRef\.current\[k\]\)_liveOnly\[k\]=v;/.test(HTML));

t('Tony archived days are read-only in the UI',
  (HTML.match(/thArchivedRef\.current\[k\]\)\{if\(window\._planReadOnlyNudge\)/g) || []).length >= 2,
  'Both tog() and del() must refuse edits to archived day-keys.');

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
             grab('thTodayKey', vedaScope), grab('thSplitArchivable', vedaScope)].join('\n');
const TH_DAYKEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TH_ARCHIVE_YEARS = 6, TH_ARCHIVE_SOFT_BYTES = 780000;
const { thSplitArchivable, thDataBytes, dkey } = new Function(
  'TH_DAYKEY_RE', 'TH_ARCHIVE_YEARS', 'TH_ARCHIVE_SOFT_BYTES',
  src + '\nreturn {thSplitArchivable,thDataBytes,thTodayKey,dkey};'
)(TH_DAYKEY_RE, TH_ARCHIVE_YEARS, TH_ARCHIVE_SOFT_BYTES);

// ~2 years of realistic daily tasks — enough to blow past the soft cap.
const data = {};
const today = new Date();
function mk(n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push({ id: 'id' + i, type: 'task', done: i % 2 === 0,
    title: 'Some reasonably long task title for realism ' + i, category: 'study', notes: 'x'.repeat(120) });
  return a;
}
for (let back = 0; back < 730; back++) {
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

console.log('\n' + '\u2500'.repeat(64));
if (fail) {
  console.log(fail + ' FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('All ' + pass + ' archive-visibility checks passed.');
