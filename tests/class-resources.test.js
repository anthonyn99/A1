#!/usr/bin/env node
/**
 * Class Resources regression tests.
 *
 * WHY THIS FILE EXISTS
 * The launch feature spans four files that must agree with each other, and two
 * of those agreements are invisible at any single edit site:
 *
 *   1. THE PATH REGEX. index.html, shield.html and V1/js/studyos.js each hold
 *      their own copy of _isLocalPath. A string one file calls a local path and
 *      another calls a URL either opens a dead browser tab or silently launches
 *      nothing - and nothing in either app errors when it happens. The first
 *      draft of the studyos.js copy was mangled so the UNC branch stopped
 *      matching network paths, and it looked completely fine in review.
 *
 *   2. RESOURCES MUST NOT RIDE ON MIRROR ITEMS. TaskHub's reconcile signature
 *      hashes exactly [_sosId, title, done, time, _sosClassName]. A resource
 *      blob attached to an item would not change that signature, so the
 *      reconcile would conclude nothing changed and DROP the edit. The side
 *      table exists solely to avoid that, and the property is easy to undo by
 *      accident later.
 *
 * Run: node tests/class-resources.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  FAIL ' + name); }
}
function section(s) { console.log('\n' + s); }

const R = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const INDEX   = R('index.html');
const SHIELD  = R('shield.html');
const STUDYOS = R('V1/js/studyos.js');
const MIRROR  = R('V1/js/taskmirror.js');

// ---------------- Part 1: the path regex must be byte-identical -------------
section('Path classifier is byte-identical across all three copies');

// These files are CRLF on disk, so the line breaks around the body must be
// matched as \r?\n - anchoring on \n alone silently yields null for ALL THREE
// bodies, and the equality assertions below then "pass" as null === null. That
// is why each extractor is asserted non-null before any comparison runs.
// Line endings are then normalised so a future LF/CRLF difference between the
// files is not reported as a regex mismatch.
function body(src, fnName) {
  const m = new RegExp('function ' + fnName + '\\(u\\)\\{\\r?\\n([\\s\\S]*?)\\r?\\n\\}').exec(src);
  return m ? m[1].replace(/\r\n/g, '\n') : null;
}
const bIndex   = body(INDEX,   '_isLocalPath');
const bShield  = body(SHIELD,  'isLocalPath');
const bStudyos = body(STUDYOS, '_sosIsLocalPath');

t('index.html defines _isLocalPath',    bIndex   !== null);
t('shield.html defines isLocalPath',    bShield  !== null);
t('studyos.js defines _sosIsLocalPath', bStudyos !== null);
t('index.html and shield.html agree',   bIndex === bShield,
  'These two already had to match; a drift breaks local links, not just resources.');
t('studyos.js matches the other two',   bIndex === bStudyos,
  'StudyOS decides kind:app vs kind:web at save time. If its regex disagrees,\n' +
  '      a path is stored as a URL (dead tab) or a URL as a path (never launches).');

// Behavioural check: run the real body against known inputs.
if (bStudyos) {
  const isLocal = new Function('u', bStudyos);
  t('classifies https:// as NOT local', isLocal('https://example.com') === false);
  t('classifies http:// as NOT local',  isLocal('http://example.com') === false);
  t('classifies drive-backslash path as local',
    isLocal('C:\\Program Files\\MATLAB\\bin\\matlab.exe') === true);
  t('classifies drive-forwardslash path as local',
    isLocal('C:/Program Files/app.exe') === true);
  t('classifies UNC path as local', isLocal('\\\\fileserver\\share\\app.exe') === true,
    'The mangling that actually happened halved the escaped backslashes and\n' +
    '      silently stopped matching every network path.');
  // A bare host matches neither branch, so it is neither a URL nor a path.
  // saveResource() must therefore reject it explicitly rather than assuming
  // "not local" means "safe to open as a URL" - otherwise it would be stored
  // as kind:web and open a dead tab.
  t('bare "google.com" is NOT local (and is not a URL either)',
    isLocal('google.com') === false);
  t('saveResource rejects a target that is neither a URL nor a path',
    /!local\s*&&\s*!\/\^https\?:\\\/\\\/\/i\.test\(target\)/.test(STUDYOS),
    'Without this check a bare host is saved as kind:web and opens nothing.');
  t('non-string input is safe', isLocal(undefined) === false && isLocal(null) === false);
}

// ---------------- Part 2: transport shape -----------------------------------
section('Resources travel as a side table, never on mirror items');

t('buildClasses() exists in taskmirror', /function buildClasses\s*\(/.test(MIRROR));

t('mirror write includes the classes side table',
  /setDoc\(mirrorRef,\s*\{\s*items,\s*classes:\s*cls,/.test(MIRROR),
  'The classes key is what keeps resources out of the TaskHub data map.');

t('change-compare spans items AND classes',
  /JSON\.stringify\(\[items,\s*cls\]\)/.test(MIRROR),
  'Keyed on items alone, a pure-resource edit (no task touched) looks unchanged\n' +
  '      and is never written at all.');

t('items carry _sosClassId for the class lookup',
  (MIRROR.match(/_sosClassId:\s*c\s*\?\s*c\.id\s*:\s*''/g) || []).length === 2,
  'Expected on both the task and the event builder.');

t('reconcile signature is unchanged (5 fields)',
  /\[t\._sosId,t\.title,t\.done,t\.time\|\|"",t\._sosClassName\|\|""\]/.test(INDEX),
  'If a resource field is ever added here, every label edit triggers a full\n' +
  '      strip-and-re-add of every StudyOS row plus a whole-document write.');

t('resource payload is NOT attached to mirror items',
  !/items\[sid\]\s*=\s*\{[\s\S]{0,400}?resources:/.test(MIRROR),
  'Attaching resources to an item makes the edit invisible to sig() and it gets\n' +
  '      silently dropped. Use the classes side table.');

section('Native paths never reach the phone-visible mirror');

t('buildClasses omits r.path',
  !/\{\s*id:\s*r\.id,\s*kind:\s*'app',[^}]*path/.test(MIRROR),
  'App paths belong only in the Shield-only class-apps document.');

t('a separate class-apps document is written',
  /setDoc\(appsRef,\s*\{\s*apps,/.test(MIRROR) && /classAppsDoc/.test(MIRROR));

t('class-apps has its own change-compare', /lastAppsSerialized/.test(MIRROR),
  'App paths change about once a semester; they must not rewrite on task churn.');

// ---------------- Part 3: TaskHub read path stays read-only -----------------
section('TaskHub launch path never writes');

const sosBlock = (INDEX.match(/const \[sosResMap,setSosResMap\][\s\S]{0,2000}?const sosMirrorSigRef/) || [''])[0];
t('sosResMap block exists', sosBlock.length > 0);
t('sosResMap never calls setData/setDataBg',
  sosBlock.length > 0 && !/setData\s*\(|setDataBg\s*\(/.test(sosBlock),
  'This is display state only. A write here would replay stale state over the\n' +
  '      good cloud document - and if it ever must write, it is setDataBg, never setData.');

t('_sosMirrorClasses is set after the fromCache guard',
  /fromCache\)\s*return;[\s\S]{0,900}?window\._sosMirrorClasses\s*=/.test(INDEX),
  'Set before the guard, it would carry cached-doc data on a phone open.');

const lh = /window\._sosLaunchClass\s*=\s*function[\s\S]*?\n};/.exec(INDEX);
t('launch handler exists', !!lh);
t('launch handler requests tabs before the protocol navigation',
  !!lh && lh[0].indexOf('_tnOpenTab') < lh[0].indexOf("'shieldopen:class/"),
  'The protocol call can raise a dialog that ends the user gesture, blocking\n' +
  '      every tab that had not been requested yet.');
t('launch handler defers nothing out of the user gesture',
  !!lh && !/setTimeout|requestAnimationFrame|\.then\(/.test(lh[0]),
  'Anything asynchronous here is guaranteed to be popup-blocked.');

section('StudyOS editor persists through the supported path');

t('saveResource calls persist()',          /function saveResource\(\)[\s\S]*?persist\(\);/.test(STUDYOS));
t('saveResource nudges the task mirror',   /function saveResource\(\)[\s\S]*?_vedaUpdateTask/.test(STUDYOS),
  'persist() alone never rebuilds the mirror, so the change would not reach TaskHub.');
t('deleteResource nudges the task mirror', /function deleteResource\(id\)[\s\S]*?_vedaUpdateTask/.test(STUDYOS));
t('editing app to web clears the stale path',
  /delete r\.path/.test(STUDYOS) && /delete r\.url/.test(STUDYOS),
  'A leftover path would still be launched by Shield.');

// ---------------------------- summary ---------------------------------------
console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' class-resources: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFailures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
