// StudyOS self-cleanup, in a real headless browser against the built page.
//
// Removing a class or module used to leave every file's bytes in IndexedDB
// (50 of 52 on Veda's Brave, 94 MB, 2026-09-30). Two fixes, checked here:
//   - removing a class drops its files' bytes (_sosDropFilesOf);
//   - sweep.js item "studyos-orphan-files" runs through the page adapter
//     window._a1SweepIdb['studyos-orphan-files'], which must wait for applied
//     server state, skip anything uploaded within a day, wait capDays before
//     listing, and re-check the reference before deleting.
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
const { send, evalJs } = await connect();
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: PAGE });
await new Promise(r => setTimeout(r, 1500));
await evalJs('localStorage.clear()');
await send('Page.reload', {});
await new Promise(r => setTimeout(r, 5000));

const OLD = 'sf_1000000000000_keep', ORPHAN = 'sf_1000000000000_gone', FRESH = 'sf_' + Date.now() + '_new';

console.log('\nadapter');
const r = await evalJs(`(async () => {
  const A = window._a1SweepIdb && window._a1SweepIdb['studyos-orphan-files'];
  if (!A) return { missing: true };
  const blob = () => new Blob(['%PDF-1.4 test'], { type: 'application/pdf' });
  for (const id of ['${OLD}', '${ORPHAN}', '${FRESH}']) await SosFileStore.putById(id, blob(), id + '.pdf');
  classes.push({ id: 'cc1', name: 'Kept', code: '', instructor: '', color: '#9dc0ee',
    modules: [{ id: 'mm1', name: 'Docs', type: 'documents', icon: 'doc', prompts: [], notes: [],
      files: [{ id: '${OLD}', fileId: '${OLD}', name: 'kept.pdf', size: 13, mime: 'application/pdf' }] }] });
  const out = {};
  out.readyBefore = A.ready();
  const realSeen = window._fbSosServerSeen;
  window._fbSosServerSeen = () => true;          // as if server state has been applied
  out.readyAfter = A.ready();
  // Only this suite's own files are judged: other suites share this headless
  // browser and can leave their own (correctly orphaned) files in IndexedDB.
  const mine = new Set(['${OLD}', '${ORPHAN}', '${FRESH}']);
  out.firstList = (await A.list(30)).map(x => x.key).filter(k => mine.has(k));
  const since = JSON.parse(localStorage.getItem('studyos_orphan_since') || '{}');
  out.tracked = Object.keys(since).filter(k => mine.has(k)).sort();
  out.agedList = (await A.list(0)).map(x => x.key).filter(k => mine.has(k));
  let threw = null; try { await A.del('${OLD}'); } catch (e) { threw = e.message; }
  out.delReferencedThrew = threw;
  await A.del('${ORPHAN}');
  out.orphanGone = !(await SosFileStore.has('${ORPHAN}'));
  out.keptStill = await SosFileStore.has('${OLD}');
  out.freshStill = await SosFileStore.has('${FRESH}');
  window._fbSosServerSeen = realSeen;
  return out;
})()`);
t('the adapter is published', !r.missing, r);
t('not ready before server state is applied', r.readyBefore === false, r);
t('ready once server state is applied', r.readyAfter === true, r);
t('first sweep lists nothing (the orphan wait starts)', Array.isArray(r.firstList) && r.firstList.length === 0, r.firstList);
t('only the old orphan is tracked (referenced and fresh are not)', JSON.stringify(r.tracked) === JSON.stringify([ORPHAN]), r.tracked);
t('after the wait, only the old orphan is listed', JSON.stringify(r.agedList) === JSON.stringify([ORPHAN]), r.agedList);
t('del() refuses a file that is referenced', r.delReferencedThrew === 'referenced again', r.delReferencedThrew);
t('del() removes the orphan', r.orphanGone === true, r);
t('the referenced file and the fresh upload stay', r.keptStill && r.freshStill, r);

console.log('\nremoving a class drops its files');
const d = await evalJs(`(async () => {
  await SosFileStore.putById('sf_1000000000001_cls', new Blob(['x']), 'x.pdf');
  const cls = { id: 'cc2', name: 'Going', modules: [{ id: 'mm2', files: [{ fileId: 'sf_1000000000001_cls', name: 'x.pdf' }] }] };
  const removed = [];
  const realRemove = SosCloud.remove;
  SosCloud.remove = (id) => { removed.push(id); };   // never reach the real Worker from a test
  _sosDropFilesOf(cls.modules);
  await new Promise(r => setTimeout(r, 300));
  SosCloud.remove = realRemove;
  return { gone: !(await SosFileStore.has('sf_1000000000001_cls')), cloud: removed };
})()`);
t('its bytes leave IndexedDB', d.gone === true, d);
t('its cloud copy is removed too', JSON.stringify(d.cloud) === JSON.stringify(['sf_1000000000001_cls']), d.cloud);

console.log('\nsweep wiring');
const s = await evalJs(`(() => ({ sweep: !!window.A1Sweep, program: window.A1Sweep && window.A1Sweep.program }))()`);
// file:// has no ../sweep.js beside dist/studyos, so this only checks it does no harm there.
t('page boots whether or not sweep.js is reachable', typeof s.sweep === 'boolean', s);

await evalJs(`(async () => { for (const id of ['${OLD}', '${FRESH}']) await SosFileStore.delete(id); localStorage.clear(); })()`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
