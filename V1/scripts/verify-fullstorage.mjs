// StudyOS on a FULL localStorage, in a real headless browser.
//
// Every A1 page shares one origin and its 5 MB of localStorage, and on Veda's
// Brave it was full to the byte (2026-09-30). Three faults followed, all silent:
//   1. Firestore's multi-tab manager threw QuotaExceededError inside its queue,
//      failed an internal assertion, and rejected every read and write after.
//   2. persist() threw at localStorage.setItem BEFORE _fbSaveStudyOs, so edits
//      never reached the cloud; a remote update died half-applied, unrendered.
//   3. KSU files kept their PDFs inline as base64, so the whole synced document
//      (~600 KB of it) was re-sent on every edit — and those files would not open.
// This fills the store, boots the built page, and checks all three.
import { launch, connect } from './cdp.mjs';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist/studyos/index.html');
if (!existsSync(dist)) {
  console.error('Build first:  npm run build');
  process.exit(2);
}
const PAGE = 'file:///' + dist.split(String.fromCharCode(92)).join('/');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name, extra == null ? '' : '\n       ' + JSON.stringify(extra)); }
};

try {
  await launch();
} catch (e) {
  if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); }
  throw e;
}
const { send, evalJs, events } = await connect();
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

// ── Seed a KSU file stored the legacy way, then fill the store to the byte ──
await send('Page.navigate', { url: 'about:blank' });
await new Promise(r => setTimeout(r, 300));
await send('Page.navigate', { url: PAGE });
await new Promise(r => setTimeout(r, 1500));
const seeded = await evalJs(`(() => {
  localStorage.clear();
  // A few KB of fake PDF, so the file is big enough to dominate the payload.
  const b64 = btoa('%PDF-1.4\\n' + 'x'.repeat(30000) + '\\n%%EOF');
  localStorage.setItem('studyos_classes', JSON.stringify([{ id: 'c1', name: 'Seed Class', code: '', instructor: '', color: '#9dc0ee', modules: [] }]));
  localStorage.setItem('studyos_ksu', JSON.stringify({ modules: [{ id: 'k1', name: 'PARKING', type: 'documents', icon: 'doc', prompts: [], notes: [],
    files: [{ name: 'Permit.pdf', size: 30020, dataUrl: 'data:application/pdf;base64,' + b64 }] }] }));
  // Fill in shrinking chunks until not even one character fits.
  let i = 0;
  for (let n = 1 << 20; n >= 1; n >>= 1) {
    const chunk = 'f'.repeat(n);
    for (;;) { try { localStorage.setItem('__fill_' + (i++), chunk); } catch (e) { break; } }
  }
  let full = false; try { localStorage.setItem('__probe', 'x'); localStorage.removeItem('__probe'); } catch (e) { full = true; }
  return { full, ksuLen: localStorage.getItem('studyos_ksu').length };
})()`);
t('localStorage is full before boot', seeded.full, seeded);

events.length = 0;
await send('Page.reload', {});
await new Promise(r => setTimeout(r, 6000));

// ── 1. Firestore must survive the full store ─────────────────────────────
const texts = events.map(e =>
  e.method === 'Runtime.exceptionThrown'
    ? (e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || '')
    : e.method === 'Log.entryAdded' ? e.params.entry.text
    : e.method === 'Runtime.consoleAPICalled' ? (e.params.args || []).map(a => a.value || a.description || '').join(' ')
    : '');
const fsFatal = texts.filter(s => /INTERNAL ASSERTION FAILED|firestore_sequence_number/.test(s));
console.log('\nFirestore');
t('no Firestore assertion / quota failures', fsFatal.length === 0, fsFatal.slice(0, 2).map(s => s.slice(0, 160)));

// ── 2. A growing edit still reaches the cloud save ─────────────────────────
console.log('\nsaves');
const save = await evalJs(`(() => {
  const calls = [];
  const orig = window._fbSaveStudyOs;
  window._fbSaveStudyOs = (p) => calls.push(p);
  let threw = null;
  classes.push({ id: 'c2', name: 'Added While Full', code: '', instructor: '', color: '#dea2d6', modules: [] });
  try { persist(); } catch (e) { threw = String(e).slice(0, 100); }
  window._fbSaveStudyOs = orig;
  const p = calls[0];
  return { threw, calls: calls.length, hasNewClass: !!(p && p.classes.some(c => c.id === 'c2')),
           ksuDataUrls: p ? p.ksu.modules.reduce((n, m) => n + m.files.filter(f => f.dataUrl).length, 0) : -1,
           bytes: p ? JSON.stringify(p).length : 0 };
})()`);
t('persist() does not throw on a full store', !save.threw, save.threw);
t('the edit is handed to the cloud save', save.calls === 1 && save.hasNewClass, save);

// ── 3. KSU files leave the synced document and open from IndexedDB ────────
console.log('\nKSU files');
t('cloud payload carries no KSU dataUrl', save.ksuDataUrls === 0, save);
t('cloud payload is small (< 10 KB)', save.bytes > 0 && save.bytes < 10000, save.bytes);
const ksu = await evalJs(`(async () => {
  const f = ksuData.modules[0].files[0];
  const blob = await sosResolveBlob(f);
  return { fileId: f.fileId || null, dataUrl: !!f.dataUrl, blobSize: blob ? blob.size : 0 };
})()`);
t('KSU file migrated to a content-derived fileId', /^sf_ksu_/.test(ksu.fileId || ''), ksu);
t('KSU file opens (blob resolves)', ksu.blobSize > 30000, ksu);

// ── 4. A remote update still carrying the dataUrl applies in full ─────────
console.log('\nremote apply');
const remote = await evalJs(`(async () => {
  const b64 = btoa('%PDF-1.4\\n' + 'x'.repeat(30000) + '\\n%%EOF');
  const before = ksuData.modules[0].files[0].fileId;
  let err = null;
  const onErr = (e) => { err = e.message; };
  window.addEventListener('error', onErr);
  window.dispatchEvent(new CustomEvent('fb-sos-remote', { detail: {
    classes: classes.concat([{ id: 'c3', name: 'From Another Device', code: '', instructor: '', color: '#88d2ba', modules: [] }]),
    events, tasks: tasks.concat([{ id: 't9', name: 'Remote task', done: false, dueDate: '2026-10-01' }]), notes: notesList,
    ksu: { modules: [{ id: 'k1', name: 'PARKING', type: 'documents', icon: 'doc', prompts: [], notes: [],
      files: [{ name: 'Permit.pdf', size: 30020, dataUrl: 'data:application/pdf;base64,' + b64 }] }] },
  } }));
  await new Promise(r => setTimeout(r, 1000));
  window.removeEventListener('error', onErr);
  const f = ksuData.modules[0].files[0];
  return { err, task: tasks.some(t => t.id === 't9'), rendered: document.body.innerText.includes('From Another Device'),
           sameId: f.fileId === before, dataUrl: !!f.dataUrl };
})()`);
t('remote update does not throw', !remote.err, remote.err);
t('remote tasks and classes applied and rendered', remote.task && remote.rendered, remote);
t('re-migration reuses the same fileId (no duplicate blobs)', remote.sameId && !remote.dataUrl, remote);

// Leave the shared test browser's storage empty for the next suite.
await evalJs('localStorage.clear()');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
