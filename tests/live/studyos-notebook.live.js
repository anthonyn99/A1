// StudyOS's notes are V's Notebook (V1/js/sos-notebook.js, 2026-10-29): one
// instance (key stn, store dashboards/studyos_notebook) shown in the Quick
// Notes view (folder 'quick') and in each Notes module's modal (folder = the
// module id). Real StudyOS page, real Notebook, fake Firestore.
//
// Seeded with every kind of note StudyOS ever kept, it checks that ALL of it
// moves in, once, into the right place, and that the old copies are left as
// the backup:
//   - quick notes (the main document's `notes`)
//   - a Notes module's page-editor document (studyos_notes/<id>): ids, dates,
//     tags, the Trash, an image (moved to its own document), plus a page only
//     this device's cache had and a newer local edit
//   - a Notes module's old textarea notes (mod.notes), and a documents
//     module's (which never showed): those go to Quick Notes, tagged
//   - a KSU Notes module
// Then: each place lists only its own pages; a new page lands in the folder on
// screen; a reload moves nothing again; a generated note is a page that a
// re-run replaces; Make flashcards reads the pages; on a phone the notes and
// the module modal fill the screen above StudyOS's bottom nav.
//
// Run: node tests/live/studyos-notebook.live.js
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');
const fs = require('fs');

const URL = 'https://anthonyn99.github.io/A1/V1/studyos.html';
const ORIGIN = 'https://anthonyn99.github.io';
const S = 'dashboards/studyos_notebook';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

const T0 = Date.now();
const IMG = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(600);
const SEED = {
  'dashboards/studyos': { classes: [{ id: 'c1', name: 'Biology', code: 'BIO101', color: '#8D769A', modules: [
      { id: 'm1', name: 'Lectures', type: 'notes', files: [], prompts: [], notes: [{ id: 'n1', title: 'Old textarea', body: 'Line one\nLine two\n\nPara <two>', updated: T0 - 500000 }] },
      { id: 'm2', name: 'Readings', type: 'documents', files: [], prompts: [], notes: [{ id: 'n9', title: 'Stray', body: 'stray text', updated: T0 - 400000 }] }] }],
    events: [], tasks: [], notes: [{ id: 'q1', title: 'Groceries', body: 'milk\neggs', updated: T0 - 300000 }],
    ksu: { modules: [{ id: 'k1', name: 'KSU notes', type: 'notes', files: [], prompts: [], notes: [] }] } },
  'studyos_notes/m1': { savedAt: T0 - 100000, activeId: 'e_100_a', entries: [
    { id: 'e_100_a', title: 'Cell structure', template: 'page', created: T0 - 900000, updated: T0 - 200000, tags: ['bio'], data: { html: '<h2>Cell</h2><p>Mitochondria make ATP.</p>', attachments: [] } },
    { id: 'e_102_i', title: 'Diagram', template: 'page', created: T0 - 700000, updated: T0 - 600000, tags: [], data: { html: '<p>See:</p><span class="pg-img-wrap"><img src="' + IMG + '"></span>' } },
    { id: 'e_101_t', title: 'Old trash', template: 'page', created: T0 - 900000, updated: T0 - 800000, trashed: T0 - 86400000, trashChangedAt: T0 - 86400000, tags: [], data: { html: '<p>gone</p>' } },
    { id: 'e_103_g', title: 'Generated lecture', template: 'page', created: T0 - 50000, updated: T0 - 50000, tags: ['generated'], data: { html: '<p>gen v1</p>' }, _sos: { generated: true, sourceFileId: 'deck7' } }] },
  'studyos_notes/k1': { savedAt: T0, entries: [{ id: 'e_200_b', title: 'KSU page', template: 'page', created: T0 - 50000, updated: T0 - 50000, tags: [], data: { html: '<p>ksu body</p>' } }] },
};
// This device's cache of the Lectures module: a newer edit of one page and a
// page that never reached the cloud.
const LOCAL = { studyos_notes_m1: JSON.stringify({ entries: [
  { id: 'e_100_a', title: 'Cell structure', template: 'page', created: T0 - 900000, updated: T0 - 1000, tags: ['bio'], data: { html: '<h2>Cell</h2><p>Mitochondria make ATP. And this edit.</p>' } },
  { id: 'e_300_l', title: 'Offline page', template: 'page', created: T0 - 2000, updated: T0 - 2000, tags: [], data: { html: '<p>only here</p>' } }] }) };

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 8000) / 200; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(200); } return false; };
  const doc = async (p) => JSON.parse(await js(`return JSON.stringify(__fakeFs.docs[${JSON.stringify(p)}] || null);`));
  const rows = async () => JSON.parse(await js(`return JSON.stringify([...document.querySelectorAll('#stn-entries-list .entry-item')].map(r => ({ id: r.dataset.entryId, t: r.querySelector('.entry-item-title').innerText })));`));
  const visible = (sel) => js(`var e=document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';`);
  const shot = async (n) => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shotPath(n), Buffer.from(s.result.data, 'base64')); console.log('  shot ' + shotPath(n)); };
  const boot = async () => {
    await c.send('Page.navigate', { url: URL });
    if (!(await until(`window.SOSNotes && document.body.dataset.sosGate === 'open'`, 15000))) throw new Error('StudyOS did not open');
    await sleep(1500);
  };
  const openModule = async (cid, mid) => {
    await js(`switchView('class', '${cid}'); var cls = classes.find(c => c.id === '${cid}'); openModuleDetail(cls, cls.modules.find(m => m.id === '${mid}')); 1`);
    await until(`document.querySelector('#module-detail-body .sos-nb-modal-host #stn-root')`, 15000);
    await sleep(900);
  };

  await c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 860, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: 'https://anthonyn99.github.io/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(SEED))});
    var L = ${JSON.stringify(LOCAL)}; for (var k in L) localStorage.setItem(k, L[k]); 1`);
  await boot();

  console.log('\nThe old editor is gone; nothing loads until notes open');
  ok('no #so-root, no docx-engine, no notes-sync', await js(`return !document.getElementById('so-root') && ![...document.scripts].some(s => /docx-engine|notes-sync/.test(s.src));`));
  ok('Notebook is loaded lazily and not mounted yet', await js(`return !!window.Notebook && !window.Notebook.mounts.stn && !window.SOSNotes.mounted();`));

  console.log('\nQuick Notes: V\'s Notebook on the quick folder; every old note moves in');
  await js(`switchView('notes'); 1`);
  ok('it mounts in the view', await until(`document.querySelector('#sos-notes-host #stn-root')`, 15000));
  ok('...as Veda\'s side', await js(`return document.getElementById('stn-root').getAttribute('data-notebook-side') === 'veda';`));
  let D = null;
  for (let i = 0; i < 60; i++) { await sleep(250); D = await doc(S); if (D && D._imported && D._imported['sos-quick'] && D._imported['sos-mod-m1'] && D._imported['sos-mod-k1']) break; }
  ok('the quick notes, both Notes modules and KSU are moved (one tag each)', D && D._imported && ['sos-quick', 'sos-mod-m1', 'sos-mod-k1'].every((t) => D._imported[t] > 0), JSON.stringify(D && D._imported));
  const page = (id) => D && D['e_' + id];
  ok('a quick note is a page in folder quick, its lines kept', page('sosq_q1') && page('sosq_q1').folder === 'quick' && page('sosq_q1').title === 'Groceries'
    && page('sosq_q1').data.html === '<p>milk<br>eggs</p>', JSON.stringify(page('sosq_q1')));
  ok('a documents module\'s hidden textarea note goes to Quick Notes, tagged with where it was', page('sosn_m2_n9') && page('sosn_m2_n9').folder === 'quick'
    && page('sosn_m2_n9').tags.join() === 'Biology,Readings', JSON.stringify(page('sosn_m2_n9')));
  ok('a Notes module\'s pages keep their ids, folder, dates and tags', page('e_100_a') && page('e_100_a').folder === 'm1' && page('e_100_a').created === T0 - 900000
    && page('e_100_a').tags[0] === 'bio', JSON.stringify(page('e_100_a')));
  ok('...the newer local edit wins over the older cloud copy', page('e_100_a') && /And this edit\./.test(page('e_100_a').data.html));
  ok('...a page only this device had is moved too', page('e_300_l') && page('e_300_l').folder === 'm1');
  ok('...a trashed page stays in the Trash, with its date', page('e_101_t') && page('e_101_t').trashed === T0 - 86400000);
  ok('...an image moves to its own document', page('e_102_i') && !/data:image/.test(page('e_102_i').data.html)
    && await js(`return Object.keys(__fakeFs.docs).some(k => k.indexOf('dashboards/studyos_notebook_img_e_102_i_') === 0);`));
  ok('...a generated page keeps its source', page('e_103_g') && page('e_103_g').host && page('e_103_g').host.sourceFileId === 'deck7');
  ok('the module\'s old textarea note is a page in its folder, escaped, paragraphs kept', page('sosn_m1_n1') && page('sosn_m1_n1').folder === 'm1'
    && page('sosn_m1_n1').data.html === '<p>Line one<br>Line two</p><p>Para &lt;two&gt;</p>', JSON.stringify(page('sosn_m1_n1')));
  ok('the KSU module\'s page is in its folder', page('e_200_b') && page('e_200_b').folder === 'k1');
  ok('the old copies are untouched (the backup)', JSON.stringify(await doc('studyos_notes/m1')) === JSON.stringify(SEED['studyos_notes/m1'])
    && JSON.stringify((await doc('dashboards/studyos')).notes) === JSON.stringify(SEED['dashboards/studyos'].notes));
  await sleep(800);
  let R = await rows();
  ok('the view lists the quick folder only', R.map((r) => r.id).sort().join() === 'sosn_m2_n9,sosq_q1', JSON.stringify(R));
  ok('its page fits the box (fit-width zoom)', await js(`var w=document.querySelector('#stn-root .docx-sheet, #stn-page-editor'); var b=document.getElementById('sos-notes-host').getBoundingClientRect(); var r=document.getElementById('stn-page-editor').getBoundingClientRect(); return r.right <= b.right + 1 && r.left >= b.left - 1;`),
    await js(`return JSON.stringify([document.getElementById('stn-page-editor').getBoundingClientRect(), document.getElementById('sos-notes-host').getBoundingClientRect()]);`));
  ok('the page title has room', await js(`return document.getElementById('stn-entry-title-input').getBoundingClientRect().width >= 120;`));
  await shot('studyos-notebook-quick');

  console.log('\nA Notes module: the same notebook, on the module\'s folder');
  await openModule('c1', 'm1');
  R = await rows();
  ok('the modal lists the module\'s live pages only', R.map((r) => r.id).sort().join() === 'e_100_a,e_102_i,e_103_g,e_300_l,sosn_m1_n1', JSON.stringify(R));
  ok('its Trash holds its trashed page', await js(`return window._stnTrashAPI.list().map(e => e.id).join() === 'e_101_t';`));
  ok('the modal is wide (notes-mode) and Make flashcards shows', await js(`var m=document.getElementById('module-detail-modal'); return m.classList.contains('notes-mode') && m.getBoundingClientRect().width > 1100;`)
    && await visible('#module-detail-cards-btn'));
  await js(`document.querySelector('#stn-entries-list .entry-item[data-entry-id="e_102_i"] .entry-item-title').click(); 1`);
  ok('a page with a moved image shows the image again', await until(`document.querySelector('#stn-page-editor img[src^="data:image"]')`, 8000));
  // A new page here belongs to this module.
  await js(`document.getElementById('stn-new-entry-btn').click(); 1`); await sleep(300);
  await js(`document.querySelector('#stn-root .template-card[data-template="page"]').click(); 1`); await sleep(500);
  await js(`var t=document.getElementById('stn-entry-title-input'); t.value='Lecture 9'; t.dispatchEvent(new Event('input',{bubbles:true})); 1`);
  const newId = await js(`return document.querySelector('#stn-entries-list .entry-item.active').dataset.entryId;`);
  for (let i = 0; i < 40; i++) { await sleep(250); D = await doc(S); if (D['e_' + newId] && D['e_' + newId].title === 'Lecture 9') break; }
  ok('a page made in the module is saved in its folder', D['e_' + newId] && D['e_' + newId].folder === 'm1', JSON.stringify(D['e_' + newId]));
  await js(`closeModuleDetail(); 1`); await sleep(400);
  ok('closing sets the notes aside', await js(`return !document.querySelector('#module-detail-body #stn-root') && !document.getElementById('module-detail-modal').classList.contains('notes-mode');`));
  await js(`switchView('ksu'); openKsuModuleDetail(ksuData.modules[0]); 1`);
  await until(`document.querySelector('#module-detail-body #stn-root')`, 8000); await sleep(600);
  R = await rows();
  ok('a KSU Notes module lists its own page', R.map((r) => r.id).join() === 'e_200_b', JSON.stringify(R));
  await js(`closeModuleDetail(); 1`);
  await js(`switchView('notes'); 1`); await sleep(800);
  R = await rows();
  ok('Quick Notes again: still only its own pages', R.map((r) => r.id).sort().join() === 'sosn_m2_n9,sosq_q1', JSON.stringify(R));

  console.log('\nGenerated notes and flashcards');
  const gen = JSON.parse(await js(`return window._sosBridge.addGeneratedNote({ classId: 'c1', moduleId: 'm1', title: 'Lecture 7 rewritten', body: '## Krebs\\n- **ATP** is made', meta: { sourceFileId: 'deck7', promptVersion: 2 } }).saved.then(r => JSON.stringify(r));`));
  for (let i = 0; i < 40; i++) { await sleep(250); D = await doc(S); if (D.e_e_103_g && /Krebs/.test(D.e_e_103_g.data.html)) break; }
  ok('re-running a source replaces its page (same id), as markdown made HTML', gen && gen.id === 'e_103_g' && D.e_e_103_g.title === 'Lecture 7 rewritten'
    && /<h2>Krebs<\/h2>/.test(D.e_e_103_g.data.html) && D.e_e_103_g.host.promptVersion === 2, JSON.stringify(D.e_e_103_g));
  const gen2 = JSON.parse(await js(`return window._sosBridge.addGeneratedNote({ classId: 'c1', title: 'From a docs drop', body: 'text', meta: { sourceFileId: 'deck8' } }).saved.then(r => JSON.stringify(r));`));
  const genMod = await js(`return (classes.find(c => c.id === 'c1').modules.find(m => m.name === 'Generated') || {}).id || null;`);
  ok('a note for a class with no target goes to a Generated Notes module, as a page there', !!genMod && gen2 && gen2.folder === genMod, JSON.stringify({ genMod, gen2 }));
  await openModule('c1', 'm1');
  const before = await js(`return JSON.parse(localStorage.getItem('studyos_cards_c1') || '[]').length;`);
  await js(`document.getElementById('module-detail-cards-btn').click(); 1`); await sleep(800);
  const after = await js(`return JSON.parse(localStorage.getItem('studyos_cards_c1') || '[]').filter(c => !c.deletedAt).length;`);
  ok('Make flashcards makes cards from the module\'s pages', after > before, before + ' -> ' + after);
  await js(`closeModuleDetail(); 1`);

  console.log('\nA reload moves nothing again');
  const writes = await js(`return __fakeFs.log.length;`);
  await boot();
  await js(`switchView('notes'); 1`);
  await until(`document.querySelector('#sos-notes-host #stn-root')`, 15000); await sleep(2500);
  const imports = await js(`return __fakeFs.log.filter(l => l.path === '${S}' && l.data && l.data._imported).length;`);
  ok('no move runs on the next visit', imports === 0, imports + ' import writes after the reload (of ' + writes + ' before)');
  R = await rows();
  ok('the quick notes are all still there', R.map((r) => r.id).sort().join() === 'sosn_m2_n9,sosq_q1', JSON.stringify(R));

  console.log('\nAnother device, whose cache holds a page that never synced');
  await js(`localStorage.removeItem('studyos_nb_moved'); localStorage.setItem('studyos_notes_k1', JSON.stringify({ entries: [
    { id: 'e_200_b', title: 'KSU page (stale here)', template: 'page', created: 1, updated: 2, tags: [], data: { html: '<p>stale</p>' } },
    { id: 'e_400_d', title: 'Written on the laptop', template: 'page', created: ${T0 - 3000}, updated: ${T0 - 3000}, tags: [], data: { html: '<p>laptop only</p>' } }] })); 1`);
  await boot();
  await js(`switchView('notes'); 1`);
  for (let i = 0; i < 60; i++) { await sleep(250); D = await doc(S); if (D && D.e_e_400_d) break; }
  ok('its device-only page is moved in, to its module', D && D.e_e_400_d && D.e_e_400_d.folder === 'k1' && /laptop only/.test(D.e_e_400_d.data.html), JSON.stringify(D && D.e_e_400_d));
  ok('...and its stale copy of a moved page does not replace the current one', D && D.e_e_200_b && D.e_e_200_b.title === 'KSU page', JSON.stringify(D && D.e_e_200_b));

  console.log('\nOn a phone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await boot();
  await js(`switchView('notes'); 1`);
  await until(`document.querySelector('#sos-notes-host #stn-root')`, 15000); await sleep(1500);
  ok('Quick Notes fill the screen above the bottom nav', await js(`var h=document.getElementById('sos-notes-host').getBoundingClientRect(), n=document.getElementById('sos-bottom-nav').getBoundingClientRect(); return h.bottom <= n.top + 1 && h.height > 500 && h.width > 360;`),
    await js(`return JSON.stringify([document.getElementById('sos-notes-host').getBoundingClientRect(), document.getElementById('sos-bottom-nav').getBoundingClientRect()]);`));
  ok('...with Notebook\'s phone bar inside it', await visible('#stn-bottom-bar'));
  await shot('studyos-notebook-phone-quick');
  await openModule('c1', 'm1');
  ok('a Notes module is full screen, over the bottom nav', await js(`var r=document.getElementById('module-detail-modal').getBoundingClientRect(); return r.top <= 1 && r.height >= 840 && r.width >= 389;`),
    await js(`return JSON.stringify(document.getElementById('module-detail-modal').getBoundingClientRect());`));
  ok('...and its Close button is on top, not under the nav', await js(`var b=document.querySelector('#module-detail-modal .modal-footer .btn').getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2).closest('.modal-footer') !== null;`));
  await shot('studyos-notebook-phone-module');

  ok('no page errors', errs.length === 0, errs.join(' | '));
  c.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
