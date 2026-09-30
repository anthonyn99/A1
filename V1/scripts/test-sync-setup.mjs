// StudyOS's Firestore setup must stay out of TaskHub's way.
//
// Every A1 page is the same origin and the same Firebase project, and under the
// [DEFAULT] app name they shared ONE Firestore IndexedDB cache, which TaskHub
// takes with forceOwnership. When StudyOS held it and TaskHub then opened (or
// re-inited), StudyOS's Firestore failed an internal assertion ("Failed to
// obtain exclusive access to the persistence layer") and every save failed:
// the "sync failed" pill, and no StudyOS work reaching TaskHub (2026-09-30,
// reproduced offline with two pages). These pins keep the fix in place.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // comments may name what the code must not do
const fbs = read('js/firebase-sync.js'), fbsCode = code(fbs);
const tm = read('js/taskmirror.js'), tmCode = code(tm);

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };

console.log('\nfirebase-sync.js');
t("initializes a NAMED app ('studyos'), so its cache is its own", /initializeApp\(\{[\s\S]*?\},\s*'studyos'\)/.test(fbsCode));
t('never uses the multi-tab manager', !/persistentMultipleTabManager/.test(fbsCode));
t('never forces ownership', !/forceOwnership/.test(fbsCode));
t('uses the single-tab manager', /persistentSingleTabManager\(\{\}\)/.test(fbsCode));
const snapAt = fbs.indexOf('_sosUnsubscribe = onSnapshot(');
const snap = fbs.slice(snapAt, fbs.indexOf('}, (err) =>', snapAt));
t('unlocks writes only after emitting server data', snap.indexOf('_sosEmitRemote(') > 0 && snap.indexOf('_sosEmitRemote(') < snap.indexOf('_sosMarkServerSeen()'));
const loadAt = fbs.indexOf('window._fbLoadStudyOs = async');
t('the one-shot load does not unlock writes', !/_sosMarkServerSeen\(\)/.test(code(fbs.slice(loadAt, fbs.indexOf('};', loadAt)))));
t('every write is rebuilt from current state', /window\._sosBuildPayload\(\)/.test(fbsCode));

console.log('\ntaskmirror.js');
t('takes the app firebase-sync.js created (getApps()[0])', /getApps\(\)\[0\]/.test(tmCode));
t('waits for applied server state before publishing', /_fbSosServerSeen && !window\._fbSosServerSeen\(\)\) \{ schedule\(/.test(tmCode));
t('bounds every mirror write with a timeout', (tmCode.match(/await bounded\(setDoc\(/g) || []).length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
