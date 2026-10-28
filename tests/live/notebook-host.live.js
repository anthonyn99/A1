// Notebook in a program that is not index.html (docs/Notebook/README.md): a
// throwaway host (tests/live/fixtures/notebook-host.html) mounts each side as an
// instance, inline, with a pinned page, templates ['page'] and the
// onSave/onReady hooks: Tony's ({ profile: 'tony' }, key nb, store nb_test) and
// Veda's ({ profile: 'veda' }, key vn, store vn_test). Real browser, fake
// Firestore (fake-firebase.js).
//
// For each side it checks the instance works on its own documents and never
// touches either native journal's: open, list (pinned first), new page + typing
// -> saved to its own store only, the pinned page can't be trashed, the size
// guard, a remote edit arrives, a reload keeps everything, Notebook.open,
// attach/detach.
//
// Run: node tests/live/notebook-host.live.js [tony|veda]   (both by default)
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

const SIDES = {
  tony: { K: 'nb', S: 'nb_test', mount: {}, nativeName: 'MyJournal', localRx: /^tony_journal|_tj$|^tj_|^brainstorm_journal|^bj_/ },
  veda: { K: 'vn', S: 'vn_test', mount: { profile: 'veda', key: 'vn', store: 'vn_test', title: 'Veda Notes' }, nativeName: 'Brainstorm', localRx: /^tony_journal|_tj$|^tj_|^brainstorm_journal|^bj_|_bj$/ },
};
const T0 = Date.now();
const seedFor = (S) => ({
  ['dashboards/' + S]: { _order: ['e_1_alpha'], activeId: 'e_1_alpha', savedAt: T0 - 60000,
    e_e_1_alpha: { id: 'e_1_alpha', title: 'Alpha rules', template: 'page', created: T0 - 86400000, updated: T0 - 60000,
      tags: [], data: { html: '<p>Cut losers fast.</p>', attachments: [] }, rev: 1 } },
  // The two native journals, which an instance must never read into or write.
  'dashboards/tony_journal': { _order: ['e_9_tony'], savedAt: T0 - 60000,
    e_e_9_tony: { id: 'e_9_tony', title: 'Tony private', template: 'page', created: T0, updated: T0, tags: [], data: { html: '<p>x</p>' }, rev: 1 } },
  'dashboards/journal': { _order: ['e_8_veda'], savedAt: T0 - 60000,
    e_e_8_veda: { id: 'e_8_veda', title: 'Veda private', template: 'page', created: T0, updated: T0, tags: [], data: { html: '<p>y</p>' }, rev: 1 } },
});

async function side(c, name, errs) {
  const { K, S, mount, nativeName, localRx } = SIDES[name];
  const SEED = seedFor(S);
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 8000) / 200; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(200); } return false; };
  const $ = (id) => `document.getElementById('${K}-${id}')`;

  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: 'https://anthonyn99.github.io/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(SEED))}); 1`);
  const boot = async (extra) => {
    await c.send('Page.navigate', { url: URL });
    if (!(await until('window.__hostReady', 10000))) throw new Error('host did not load');
    await js('window.__mountP = window.__mount(' + JSON.stringify(Object.assign({}, mount, extra || {})) + ').then(() => { window.__mounted = true; }, (e) => { window.__mountErr = String(e && e.stack || e); }); 1');
    await until('window.__mounted || window.__mountErr', 15000);
    const err = await js('return window.__mountErr || null;');
    if (err) throw new Error('mount failed: ' + err);
    await until('window.__ready', 8000);
    await sleep(800);
  };
  await boot();

  console.log(`\n[${name}] Mounted inline, on its own documents`);
  ok('the app is inside the host\'s container', await js(`var r=${$('root')}; return !!r && document.getElementById('host').contains(r);`));
  ok('...visible, filling it', await js(`var r=${$('root')}.getBoundingClientRect(); return r.width > 1000 && r.height > 600 && r.top >= 40;`),
    await js(`return JSON.stringify(${$('root')}.getBoundingClientRect());`));
  ok('onReady fired after the first load', await js('return window.__ready === true;'));
  const rows = async () => JSON.parse(await js(`return JSON.stringify([...document.querySelectorAll('#${K}-entries-list .entry-item')].map(r => ({ id: r.dataset.entryId, del: !!r.querySelector('.entry-delete') && getComputedStyle(r.querySelector('.entry-delete')).display !== 'none', drag: r.draggable || !!r.querySelector('.entry-drag-handle'), t: r.querySelector('.entry-item-title').innerText })));`));
  let R = await rows();
  ok('the list shows the store\'s entry, with the pinned page first', R.length === 2 && R[0].id === 'daily-reminder' && R[1].id === 'e_1_alpha', JSON.stringify(R));
  ok('the pinned page has no trash button; the others do', R[0].del === false && R[1].del === true);
  if (name === 'veda') ok('...and it cannot be dragged; the others can', R[0].drag === false && R[1].drag === true, JSON.stringify(R));
  ok('no OurJournal tab and no lock button (off by default for an instance)',
    await js(`return !document.querySelector('#${K}-root .oj-tab') && getComputedStyle(${$('btn-lock')}).display === 'none';`));
  ok('the title is the host\'s', await js(`return ${$('root')}.innerText.indexOf(${JSON.stringify(nativeName)}) < 0;`));
  if (name === 'veda') {
    ok('index\'s header (TaskHub, Gita, App Lock) is not shown', await js(`var h=${$('nav-header')}; return !h || getComputedStyle(h).display === 'none';`));
    ok('it wears Veda\'s look: her body face and accent colour', await js(`var r=getComputedStyle(${$('root')}); return /IBM Plex Mono/.test(r.fontFamily) && /141,\\s*118,\\s*154|8d769a/i.test(r.getPropertyValue('--purple') + r.getPropertyValue('--suite-glow'));`),
      await js(`var r=getComputedStyle(${$('root')}); return r.fontFamily + ' | ' + r.getPropertyValue('--purple') + ' | ' + r.getPropertyValue('--suite-glow');`));
    ok('her faces are loaded for a host that has none', await js(`return !!document.querySelector('link[data-notebook-fonts]');`));
  }

  console.log(`\n[${name}] Writing`);
  await js(`${$('new-entry-btn')}.click(); 1`); await sleep(400);
  ok('the template picker offers only the page', await js(`return [...document.querySelectorAll('#${K}-root .template-card')].filter(c => getComputedStyle(c).display !== 'none').map(c => c.dataset.template).join() === 'page';`),
    await js(`return [...document.querySelectorAll('#${K}-root .template-card')].filter(c => getComputedStyle(c).display !== 'none').map(c => c.dataset.template).join();`));
  await js(`document.querySelector('#${K}-root .template-card[data-template="page"]').click(); 1`); await sleep(500);
  if (!(await js(`return ${$('page-editor')}.getAttribute('contenteditable')==='true';`))) { await js(`${$('btn-edit')}.click(); 1`); await sleep(300); }
  await js(`var t=${$('entry-title-input')}; t.value='Setups'; t.dispatchEvent(new Event('input',{bubbles:true}));
    var e=${$('page-editor')}; e.focus(); var r=document.createRange(); r.selectNodeContents(e); r.collapse(false); var s=getSelection(); s.removeAllRanges(); s.addRange(r); 1`);
  await c.send('Input.insertText', { text: 'Wait for the retest.' });
  const doc = async () => JSON.parse(await js(`return JSON.stringify(__fakeFs.docs['dashboards/${S}'] || null);`));
  const newId = await js(`return (document.querySelector('#${K}-entries-list .entry-item.active')||{dataset:{}}).dataset.entryId || null;`);
  // Autosave + the Firebase write are both debounced, and slower on a busy
  // machine: wait for the save (and its onSave) instead of a fixed sleep.
  let D = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250); D = await doc();
    const e = D && newId && D['e_' + newId];
    if (e && e.title === 'Setups' && /Wait for the retest\./.test((e.data || {}).html || '')
      && await js(`return (window.__saved || []).includes(${JSON.stringify(newId)});`)) break;
  }
  const saved = D && newId && D['e_' + newId];
  ok(`a new page is saved to dashboards/${S}`, !!saved && saved.title === 'Setups' && /Wait for the retest\./.test(saved.data.html), JSON.stringify(saved));
  ok('...and the order lists it', D && Array.isArray(D._order) && D._order.includes(newId));
  ok('onSave got the entry', await js(`return (window.__saved || []).includes(${JSON.stringify(newId)});`), await js('return JSON.stringify(window.__saved);'));
  const paths = JSON.parse(await js(`return JSON.stringify([...new Set(__fakeFs.log.map(l => l.path))]);`));
  ok('every write went to the instance\'s own documents', paths.length > 0 && paths.every((p) => new RegExp('^dashboards/' + S + '(_|$)').test(p)), JSON.stringify(paths));
  ok('both native journals\' documents are untouched',
    await js(`return JSON.stringify(__fakeFs.docs['dashboards/tony_journal']);`) === JSON.stringify(SEED['dashboards/tony_journal'])
    && await js(`return JSON.stringify(__fakeFs.docs['dashboards/journal']);`) === JSON.stringify(SEED['dashboards/journal']));
  ok('nothing was stored locally under a native journal\'s keys', await js(`return !Object.keys(localStorage).some(k => ${localRx}.test(k));`),
    await js(`return Object.keys(localStorage).join(' ');`));

  console.log(`\n[${name}] The pinned page`);
  await js(`document.querySelector('#${K}-entries-list .entry-item[data-entry-id="daily-reminder"] .entry-item-title').click(); 1`); await sleep(500);
  if (!(await js(`return ${$('page-editor')}.getAttribute('contenteditable')==='true';`))) await js(`${$('btn-edit')}.click(); 1`);
  await sleep(300);
  await js(`var e=${$('page-editor')}; e.focus(); var r=document.createRange(); r.selectNodeContents(e); r.collapse(false); var s=getSelection(); s.removeAllRanges(); s.addRange(r); 1`);
  await c.send('Input.insertText', { text: 'Breathe before entries.' });
  // The autosave is debounced: wait for it rather than a fixed sleep it can just miss.
  for (let i = 0; i < 40; i++) { await sleep(250); D = await doc(); if (D && D['e_daily-reminder'] && /Breathe before entries\./.test(D['e_daily-reminder'].data.html)) break; }
  ok('editing it saves it under its fixed id', D && D['e_daily-reminder'] && /Breathe before entries\./.test(D['e_daily-reminder'].data.html), JSON.stringify(D && D['e_daily-reminder']));
  ok('...and onSave names it', await js(`return window.__saved.includes('daily-reminder');`));
  // A margin drag and nothing else is a change too (2026-10-28: it used to leave
  // the pill at Syncing... and save nothing until the text was edited).
  await js(`window._${K}SetPageMargins({ mt: 96, mr: 96, mb: 96, ml: 150 }); window._docxApplyPageSetup('${K}'); 1`);
  for (let i = 0; i < 40; i++) { await sleep(250); D = await doc(); if (D && D['e_daily-reminder'] && D['e_daily-reminder'].data.margins && D['e_daily-reminder'].data.margins.ml === 150) break; }
  ok('a margin drag alone is saved', D && D['e_daily-reminder'] && JSON.stringify(D['e_daily-reminder'].data.margins) === JSON.stringify({ mt: 96, mr: 96, mb: 96, ml: 150 }), JSON.stringify(D && D['e_daily-reminder'] && D['e_daily-reminder'].data.margins));
  for (let i = 0; i < 20 && (await js(`return ${$('sync-text')}.textContent.trim();`)) !== 'Synced'; i++) await sleep(250);
  ok('...and the pill comes back to Synced', await js(`return ${$('sync-text')}.textContent.trim();`) === 'Synced', await js(`return ${$('sync-text')}.textContent;`));
  // A second drag, the way the ruler makes one: it edits the object the Get hook
  // returns, then hands it back. When that object was the entry's own, every
  // drag after the first changed the entry first and was never saved.
  await js(`var m = window._${K}GetPageMargins(); m.ml = 170; window._${K}SetPageMargins(m); window._docxApplyPageSetup('${K}'); 1`);
  for (let i = 0; i < 40; i++) { await sleep(250); D = await doc(); if (D && D['e_daily-reminder'] && D['e_daily-reminder'].data.margins && D['e_daily-reminder'].data.margins.ml === 170) break; }
  ok('a second margin drag is saved too', D && D['e_daily-reminder'] && D['e_daily-reminder'].data.margins && D['e_daily-reminder'].data.margins.ml === 170, JSON.stringify(D && D['e_daily-reminder'] && D['e_daily-reminder'].data.margins));
  for (let i = 0; i < 20 && (await js(`return ${$('sync-text')}.textContent.trim();`)) !== 'Synced'; i++) await sleep(250);
  ok('...and the pill comes back to Synced again', await js(`return ${$('sync-text')}.textContent.trim();`) === 'Synced', await js(`return ${$('sync-text')}.textContent;`));
  // The trash's "delete forever" is the one path left that names it directly.
  await js(`window._${K}TrashAPI.purge(['daily-reminder']); 1`); await sleep(1500);
  R = await rows();
  ok('it cannot be deleted, even from the trash\'s purge', R[0] && R[0].id === 'daily-reminder'
    && !!(await js(`return !!(__fakeFs.docs['dashboards/${S}'] || {})['e_daily-reminder'];`)), JSON.stringify(R));

  console.log(`\n[${name}] The size guard`);
  const nd = await js(`return window.__dialogs.length;`);
  await js(`window._${K}AddAttachment('huge.pdf', 'application/pdf', 'data:application/pdf;base64,' + 'A'.repeat(1200000)); 1`); await sleep(300);
  const dl = JSON.parse(await js(`return JSON.stringify(window.__dialogs.slice(${nd}));`));
  ok('a file over 650 KB is refused, through the host\'s own dialog', dl.length === 1 && dl[0][0] === 'alert' && /huge\.pdf/.test(dl[0][1]) && /650 KB/.test(dl[0][1]), JSON.stringify(dl));

  console.log(`\n[${name}] Another device, then a reload`);
  await js(`__fakeFs.remote('dashboards/${S}', { 'e_e_1_alpha': Object.assign(${JSON.stringify(SEED['dashboards/' + S].e_e_1_alpha)}, { title: 'Alpha rules v2', updated: Date.now(), rev: 3 }), savedAt: Date.now() }, { merge: true }); 1`);
  await sleep(1500);
  R = await rows();
  ok('a remote rename shows up', R.some((r) => r.id === 'e_1_alpha' && r.t === 'Alpha rules v2'), JSON.stringify(R));
  await boot();
  R = await rows();
  ok('after a reload: pinned first, the new page and the renamed one kept', R[0] && R[0].id === 'daily-reminder' && R.some((r) => r.id === newId) && R.some((r) => r.t === 'Alpha rules v2'), JSON.stringify(R));

  console.log(`\n[${name}] A host that picks the page itself (features.sidebar false, Notebook.open)`);
  await boot({ features: { sidebar: false } });
  const shown = (id) => js(`var e=document.getElementById(${JSON.stringify(id)}); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';`);
  ok('no entry list, no phone drawer backdrop', !(await shown(K + '-sidebar')) && !(await shown(K + '-sidebar-backdrop')));
  ok('...and the editor still fills the host', await js(`var r=${$('main')}.getBoundingClientRect(); return r.width > 1000;`),
    await js(`return JSON.stringify(${$('main')}.getBoundingClientRect());`));
  const opened = await js(`return window.Notebook.open('${K}', 'e_1_alpha', { edit: true });`);
  await sleep(400);
  ok('Notebook.open opens the page', opened === true && await js(`return /Alpha rules v2/.test(${$('entry-title-input')}.value);`),
    await js(`return ${$('entry-title-input')}.value;`));
  ok('...in edit mode', await js(`return ${$('page-editor')}.getAttribute('contenteditable') === 'true' && ${$('btn-edit')}.checked;`));
  await js(`window.Notebook.open('${K}', 'daily-reminder', { edit: false }); 1`); await sleep(400);
  ok('another page, in view mode', await js(`return ${$('entry-title-input')}.value === 'Daily Reminder' && ${$('page-editor')}.getAttribute('contenteditable') === 'false';`),
    await js(`return ${$('entry-title-input')}.value + ' ' + ${$('page-editor')}.getAttribute('contenteditable');`));
  await js(`window.__race = []; window.Notebook.open('${K}', 'not-there-yet').then(r => __race.push(['missing', r])); window.Notebook.open('${K}', 'e_1_alpha').then(r => __race.push(['alpha', r])); 1`);
  await sleep(600);
  ok('a newer open takes over from one still waiting', await js(`return JSON.stringify(__race.slice().sort());`) === JSON.stringify([['alpha', true], ['missing', false]]),
    await js(`return JSON.stringify(__race);`));
  let refused = await js(`return window.Notebook.open('zz', 'x').then(() => 'opened', e => String(e.message));`);
  ok('it refuses a key nothing is mounted under', /nothing mounted as zz/.test(refused), refused);

  console.log(`\n[${name}] attach / detach, and the options a mount takes`);
  ok('detach sets the instance aside, hidden and alive', await js(`return window.Notebook.detach('${K}') && document.getElementById('nb-park').contains(${$('root')})
    && getComputedStyle(document.getElementById('nb-park')).display === 'none';`));
  ok('attach puts it back in the host', await js(`return window.Notebook.attach('${K}', document.getElementById('host')) && document.getElementById('host').contains(${$('root')});`));
  ok('...still on the same page, edits intact', await js(`return ${$('entry-title-input')}.value === 'Alpha rules v2';`),
    await js(`return ${$('entry-title-input')}.value;`));
  ok('both say false for a key nothing is mounted under', await js(`return window.Notebook.attach('zz', document.body) === false && window.Notebook.detach('zz') === false;`));
  const bad = (o) => js(`try { window.Notebook.mount(${o}); return 'mounted'; } catch (e) { return String(e.message); }`);
  refused = await bad(`{ profile: '${name}', key: 'zq', store: 'zq_store', sidebarr: false }`);
  ok('mount refuses an option it does not have (a typo)', /unknown option sidebarr/.test(refused), refused);
  refused = await bad(`{ profile: '${name}', key: 'zq', store: 'zq_store', features: { lock: false } }`);
  ok('...and a feature it does not have', /unknown feature lock/.test(refused), refused);
  ok('...and mounts nothing for either', await js(`return !window.Notebook.mounts.zq;`));

  const shot = shotPath('notebook-host-' + name);
  const s = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shot, Buffer.from(s.result.data, 'base64'));
  console.log('  shot ' + shot);
  ok('no page errors', errs.length === 0, errs.join(' | '));
  errs.length = 0;
}

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const want = process.argv[2] ? [process.argv[2]] : Object.keys(SIDES);
  for (const name of want) await side(c, name, errs);
  c.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
