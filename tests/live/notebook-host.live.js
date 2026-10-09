// Notebook in a program that is not index.html (docs/Notebook/README.md): a
// throwaway host (tests/live/fixtures/notebook-host.html) mounts MyJournal under
// key nb, store nb_test, inline, with a pinned page, templates ['page'] and the
// onSave/onReady hooks. Real browser, fake Firestore (fake-firebase.js).
//
// It checks the instance works on its own documents and never touches
// MyJournal's or Brainstorm's: open, list (pinned first), new page + typing ->
// saved to dashboards/nb_test only, the pinned page can't be trashed, the size
// guard, a remote edit arrives, a reload keeps everything.
//
// Run: node tests/live/notebook-host.live.js
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');
const fs = require('fs');

const URL = 'https://anthonyn99.github.io/A1/tests/live/fixtures/notebook-host.html';
const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

const T0 = Date.now();
const SEED = {
  'dashboards/nb_test': { _order: ['e_1_alpha'], activeId: 'e_1_alpha', savedAt: T0 - 60000,
    e_e_1_alpha: { id: 'e_1_alpha', title: 'Alpha rules', template: 'page', created: T0 - 86400000, updated: T0 - 60000,
      tags: [], data: { html: '<p>Cut losers fast.</p>', attachments: [] }, rev: 1 } },
  // Tony's MyJournal, which the instance must never read into or write.
  'dashboards/tony_journal': { _order: ['e_9_tony'], savedAt: T0 - 60000,
    e_e_9_tony: { id: 'e_9_tony', title: 'Tony private', template: 'page', created: T0, updated: T0, tags: [], data: { html: '<p>x</p>' }, rev: 1 } },
};

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 8000) / 200; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(200); } return false; };

  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: 'https://anthonyn99.github.io/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(SEED))}); 1`);
  const boot = async () => {
    await c.send('Page.navigate', { url: URL });
    if (!(await until('window.__hostReady', 10000))) throw new Error('host did not load');
    await js('window.__mountP = window.__mount().then(() => { window.__mounted = true; }, (e) => { window.__mountErr = String(e && e.stack || e); }); 1');
    await until('window.__mounted || window.__mountErr', 15000);
    const err = await js('return window.__mountErr || null;');
    if (err) throw new Error('mount failed: ' + err);
    await until('window.__ready', 8000);
    await sleep(800);
  };
  await boot();

  console.log('\nMounted inline, on its own documents');
  ok('the app is inside the host\'s container', await js(`var r=document.getElementById('nb-root'); return !!r && document.getElementById('host').contains(r);`));
  ok('...visible, filling it', await js(`var r=document.getElementById('nb-root').getBoundingClientRect(); return r.width > 1000 && r.height > 600 && r.top >= 40;`),
    await js(`return JSON.stringify(document.getElementById('nb-root').getBoundingClientRect());`));
  ok('onReady fired after the first load', await js('return window.__ready === true;'));
  const rows = async () => JSON.parse(await js(`return JSON.stringify([...document.querySelectorAll('#nb-entries-list .entry-item')].map(r => ({ id: r.dataset.entryId, del: !!r.querySelector('.entry-delete') && getComputedStyle(r.querySelector('.entry-delete')).display !== 'none', t: r.querySelector('.entry-item-title').innerText })));`));
  let R = await rows();
  ok('the list shows the store\'s entry, with the pinned page first', R.length === 2 && R[0].id === 'daily-reminder' && R[1].id === 'e_1_alpha', JSON.stringify(R));
  ok('the pinned page has no trash button; the others do', R[0].del === false && R[1].del === true);
  ok('no OurJournal tab and no lock button (off by default for an instance)',
    await js(`return !document.querySelector('#nb-root .oj-tab') && getComputedStyle(document.getElementById('nb-btn-lock')).display === 'none';`));
  ok('the title is the host\'s', await js(`return document.getElementById('nb-root').innerText.indexOf('MyJournal') < 0;`));

  console.log('\nWriting');
  await js(`document.getElementById('nb-new-entry-btn').click(); 1`); await sleep(400);
  ok('the template picker offers only the page', await js(`return [...document.querySelectorAll('#nb-root .template-card')].filter(c => getComputedStyle(c).display !== 'none').map(c => c.dataset.template).join() === 'page';`),
    await js(`return [...document.querySelectorAll('#nb-root .template-card')].filter(c => getComputedStyle(c).display !== 'none').map(c => c.dataset.template).join();`));
  await js(`document.querySelector('#nb-root .template-card[data-template="page"]').click(); 1`); await sleep(500);
  await js(`var t=document.getElementById('nb-entry-title-input'); t.value='Setups'; t.dispatchEvent(new Event('input',{bubbles:true}));
    var e=document.getElementById('nb-page-editor'); e.focus(); var r=document.createRange(); r.selectNodeContents(e); r.collapse(false); var s=getSelection(); s.removeAllRanges(); s.addRange(r); 1`);
  await c.send('Input.insertText', { text: 'Wait for the retest.' });
  await sleep(3500);
  const doc = async () => JSON.parse(await js(`return JSON.stringify(__fakeFs.docs['dashboards/nb_test'] || null);`));
  let D = await doc();
  const newId = await js(`return (document.querySelector('#nb-entries-list .entry-item.active')||{dataset:{}}).dataset.entryId || null;`);
  const saved = D && newId && D['e_' + newId];
  ok('a new page is saved to dashboards/nb_test', !!saved && saved.title === 'Setups' && /Wait for the retest\./.test(saved.data.html), JSON.stringify(saved));
  ok('...and the order lists it', D && Array.isArray(D._order) && D._order.includes(newId));
  ok('onSave got the entry', await js(`return window.__saved.includes(${JSON.stringify(newId)});`), await js('return JSON.stringify(window.__saved);'));
  const paths = JSON.parse(await js(`return JSON.stringify([...new Set(__fakeFs.log.map(l => l.path))]);`));
  ok('every write went to the instance\'s own documents', paths.length > 0 && paths.every((p) => /^dashboards\/nb_test(_|$)/.test(p)), JSON.stringify(paths));
  ok('MyJournal\'s document is untouched', JSON.stringify(await js(`return JSON.stringify(__fakeFs.docs['dashboards/tony_journal']);`)) === JSON.stringify(JSON.stringify(SEED['dashboards/tony_journal'])));
  ok('nothing was stored locally under MyJournal\'s keys', await js(`return !Object.keys(localStorage).some(k => /^tony_journal|_tj$|^tj_/.test(k));`),
    await js(`return Object.keys(localStorage).join(' ');`));

  console.log('\nThe pinned page');
  await js(`document.querySelector('#nb-entries-list .entry-item[data-entry-id="daily-reminder"] .entry-item-title').click(); 1`); await sleep(500);
  if (!(await js(`return document.getElementById('nb-page-editor').getAttribute('contenteditable')==='true';`))) await js(`document.getElementById('nb-btn-edit').click(); 1`);
  await sleep(300);
  await js(`var e=document.getElementById('nb-page-editor'); e.focus(); var r=document.createRange(); r.selectNodeContents(e); r.collapse(false); var s=getSelection(); s.removeAllRanges(); s.addRange(r); 1`);
  await c.send('Input.insertText', { text: 'Breathe before entries.' });
  await sleep(3500);
  D = await doc();
  ok('editing it saves it under its fixed id', D && D['e_daily-reminder'] && /Breathe before entries\./.test(D['e_daily-reminder'].data.html), JSON.stringify(D && D['e_daily-reminder']));
  ok('...and onSave names it', await js(`return window.__saved.includes('daily-reminder');`));
  // The trash's "delete forever" is the one path left that names it directly.
  await js(`window._nbTrashAPI.purge(['daily-reminder']); 1`); await sleep(1500);
  R = await rows();
  ok('it cannot be deleted, even from the trash\'s purge', R[0] && R[0].id === 'daily-reminder'
    && !!(await js(`return !!(__fakeFs.docs['dashboards/nb_test'] || {})['e_daily-reminder'];`)), JSON.stringify(R));

  console.log('\nThe size guard');
  const nd = await js(`return window.__dialogs.length;`);
  await js(`window._nbAddAttachment('huge.pdf', 'application/pdf', 'data:application/pdf;base64,' + 'A'.repeat(1200000)); 1`); await sleep(300);
  const dl = JSON.parse(await js(`return JSON.stringify(window.__dialogs.slice(${nd}));`));
  ok('a file over 650 KB is refused, through the host\'s own dialog', dl.length === 1 && dl[0][0] === 'alert' && /huge\.pdf/.test(dl[0][1]) && /650 KB/.test(dl[0][1]), JSON.stringify(dl));

  console.log('\nAnother device, then a reload');
  await js(`__fakeFs.remote('dashboards/nb_test', { 'e_e_1_alpha': Object.assign(${JSON.stringify(SEED['dashboards/nb_test'].e_e_1_alpha)}, { title: 'Alpha rules v2', updated: Date.now(), rev: 3 }), savedAt: Date.now() }, { merge: true }); 1`);
  await sleep(1500);
  R = await rows();
  ok('a remote rename shows up', R.some((r) => r.id === 'e_1_alpha' && r.t === 'Alpha rules v2'), JSON.stringify(R));
  await boot();
  R = await rows();
  ok('after a reload: pinned first, the new page and the renamed one kept', R[0] && R[0].id === 'daily-reminder' && R.some((r) => r.id === newId) && R.some((r) => r.t === 'Alpha rules v2'), JSON.stringify(R));
  const shot = shotPath('notebook-host');
  const s = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shot, Buffer.from(s.result.data, 'base64'));
  console.log('  shot ' + shot);
  ok('no page errors', errs.length === 0, errs.join(' | '));

  c.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
