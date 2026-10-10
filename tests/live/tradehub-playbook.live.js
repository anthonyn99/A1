// Notebook Phase 6: TradeHub's Playbook tab is a Notebook instance (MyJournal as
// key pb, store dashboards/tradehub_playbook). Real tradehub.html, fake Firestore,
// a fake trade-dashboard worker that records /daily-reminder.
//
//   1. the first open migrates the old pages[] doc once (ids kept, trashed kept
//      trashed, Daily Reminder first) and leaves the old doc as it was
//   2. the Daily Reminder is pinned (first, no trash button); only pages offered
//   3. its text reaches the launcher: pushed once on open, again after an edit,
//      as Markdown; another page's edit pushes nothing
//   4. leaving the tab and coming back keeps the editor and its content
//   5. a reload migrates nothing again; the edit is there; phone width fits
//
// Run: node tests/live/tradehub-playbook.live.js
'use strict';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const URL = ORIGIN + '/A1/tradehub.html';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const T0 = Date.now();
const OLD = { savedAt: T0 - 60000, pages: [
  { id: 'daily-reminder', title: 'Daily Reminder', body: '<h2>Before I trade</h2><p>Keep <strong>discipline</strong>.</p>', createdAt: T0 - 9e6, updatedAt: T0 - 8e6 },
  { id: 'pb_rules', title: 'Rules', body: '<ul><li>Cut losers fast</li></ul>', createdAt: T0 - 7e6, updatedAt: T0 - 6e6 },
  { id: 'pb_old', title: 'Old idea', body: '<p>gone</p>', createdAt: T0 - 5e6, updatedAt: T0 - 5e6, trashed: T0 - 86400000 },
] };

const posts = [];
const worker = {
  patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    if (/\/daily-reminder$/.test(req.url) && req.method === 'POST') {
      let b = null; try { b = JSON.parse(req.postData || 'null'); } catch (e) {}
      posts.push({ body: b, appcheck: !!(req.headers && (req.headers['X-Firebase-AppCheck'] || req.headers['x-firebase-appcheck'])) });
      return { json: { ok: true } };
    }
    return { json: { ok: true } };
  },
};

(async () => {
  const c = await connect({ mock: firebaseMock(worker) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };
  const size = (w, h) => c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const boot = async (seed) => {
    if (seed) {
      await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
      await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
      await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
        sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/tradeboard_playbook': ${JSON.stringify(OLD)} })); 1`);
    }
    await c.send('Page.navigate', { url: URL });
    if (!(await until("document.querySelector('.tb-navtab')", 15000))) throw new Error('TradeHub did not render');
    await sleep(2500);
  };
  const openPlaybook = async () => {
    await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="playbook"]')].find(b=>b.offsetParent); if(t) t.click(); 1`);
    return until(`(function(){ var r=document.getElementById('pb-root'), h=document.querySelector('#tradeboard-root .tb-pb-host'); return r && h && h.contains(r) && document.querySelectorAll('#pb-entries-list .entry-item').length > 0; })()`, 20000);
  };
  const rows = () => js(`return JSON.stringify([...document.querySelectorAll('#pb-entries-list .entry-item')].map(r=>({ id: r.dataset.entryId, t: r.querySelector('.entry-item-title').innerText, del: getComputedStyle(r.querySelector('.entry-delete')).display !== 'none' })));`).then(JSON.parse);
  const docs = () => js(`return JSON.stringify({ n: __fakeFs.docs['dashboards/tradehub_playbook'] || null, o: __fakeFs.docs['dashboards/tradeboard_playbook'] || null });`).then(JSON.parse);
  const typeInto = async (id) => {
    await js(`document.querySelector('#pb-entries-list .entry-item[data-entry-id="${id}"] .entry-item-title').click(); 1`); await sleep(600);
    if (!(await js(`return document.getElementById('pb-page-editor').getAttribute('contenteditable')==='true';`))) await js(`document.getElementById('pb-btn-edit').click(); 1`);
    await sleep(300);
    await js(`var e=document.getElementById('pb-page-editor'); e.focus(); var r=document.createRange(); r.selectNodeContents(e); r.collapse(false); var s=getSelection(); s.removeAllRanges(); s.addRange(r); 1`);
  };

  await size(1440, 900);
  await boot(true);
  console.log('\nFirst open: the old Playbook moves to Notebook, once');
  ok('the Playbook tab opens a Notebook instance inside its box', await openPlaybook());
  let D = await docs();
  ok('the pages are in dashboards/tradehub_playbook, ids kept',
    D.n && D.n['e_daily-reminder'] && D.n.e_pb_rules && D.n.e_pb_old && JSON.stringify(D.n._order) === JSON.stringify(['daily-reminder', 'pb_rules', 'pb_old']), JSON.stringify(D.n && D.n._order));
  ok('...marked as migrated from the old document', D.n && D.n._migratedFrom === 'dashboards/tradeboard_playbook');
  ok('...as pages with their HTML', D.n && D.n.e_pb_rules.template === 'page' && /Cut losers fast/.test(D.n.e_pb_rules.data.html));
  ok('a trashed page stays in the trash', D.n && D.n.e_pb_old.trashed === OLD.pages[2].trashed);
  ok('the old document is untouched (the backup)', JSON.stringify(D.o) === JSON.stringify(OLD));
  let R = await rows();
  ok('the list: Daily Reminder first, then Rules; the trashed page is not listed',
    R.length === 2 && R[0].id === 'daily-reminder' && R[0].t === 'Daily Reminder' && R[1].id === 'pb_rules', JSON.stringify(R));
  ok('the Daily Reminder has no trash button; Rules does', R[0].del === false && R[1].del === true);
  await js(`document.querySelector('#pb-entries-list .entry-item[data-entry-id="daily-reminder"] .entry-item-title').click(); 1`); await sleep(600);
  ok('its content is the old page', /discipline/.test(await js(`return (document.getElementById('pb-page-editor')||{}).innerHTML || '';`)));
  await js(`document.getElementById('pb-new-entry-btn').click(); 1`); await sleep(400);
  ok('New Entry offers only a page', await js(`return [...document.querySelectorAll('#pb-root .template-card')].filter(c => getComputedStyle(c).display !== 'none').map(c => c.dataset.template).join() === 'page';`));
  await js(`var x=document.querySelector('#pb-template-modal .modal-close, #pb-close-modal'); if(x) x.click(); 1`); await sleep(300);

  console.log('\nThe launcher gets the Daily Reminder');
  await until('true', 2500); await sleep(2000);
  ok('it was pushed on open, as Markdown', posts.length >= 1 && /## Before I trade/.test(posts[0].body.markdown) && /\*\*discipline\*\*/.test(posts[0].body.markdown) && posts[0].body.title === 'Daily Reminder',
    JSON.stringify(posts));
  const n0 = posts.length;
  await typeInto('daily-reminder');
  await c.send('Input.insertText', { text: ' Size small.' });
  await sleep(6000);
  ok('an edit is pushed again, after the cloud confirmed it', posts.length === n0 + 1 && /Size small\./.test(posts[n0].body.markdown), JSON.stringify(posts.slice(n0)));
  D = await docs();
  ok('...and saved in the store', /Size small\./.test(D.n['e_daily-reminder'].data.html));
  const n1 = posts.length;
  await typeInto('pb_rules');
  await c.send('Input.insertText', { text: ' Always.' });
  await sleep(5000);
  ok('editing another page pushes nothing', posts.length === n1, JSON.stringify(posts.slice(n1)));

  console.log('\nLeaving the tab and coming back');
  await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="journal"]')].find(b=>b.offsetParent); if(t) t.click(); 1`); await sleep(1200);
  ok('away: the editor is parked, not destroyed', await js(`var r=document.getElementById('pb-root'); return !!r && !!document.getElementById('tb-pb-park') && document.getElementById('tb-pb-park').contains(r);`));
  ok('back: the same editor returns with its pages', await openPlaybook() && (await rows()).length === 2);

  console.log('\nA reload');
  const writesBefore = (await docs()).n;
  await boot(false);
  ok('the Playbook opens again', await openPlaybook());
  await sleep(1500);
  D = await docs();
  ok('no second migration (the marker and pages are as they were)', D.n._migratedFrom === writesBefore._migratedFrom && JSON.stringify(D.n._order) === JSON.stringify(writesBefore._order));
  ok('the edits are there', /Size small\./.test(D.n['e_daily-reminder'].data.html) && /Always\./.test(D.n.e_pb_rules.data.html));
  ok('the old document is still untouched', JSON.stringify(D.o) === JSON.stringify(OLD));

  console.log('\nPhone width');
  await size(390, 844); await sleep(1200);
  ok('nothing scrolls sideways', await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`), await js(`return document.documentElement.scrollWidth;`));
  ok('the Playbook is on screen', await js(`var r=document.getElementById('pb-root').getBoundingClientRect(); return r.width > 300 && r.height > 300;`));
  ok('the closed page drawer does not peek in at the edge', await js(`var e=document.elementFromPoint(5, 300); return !(e && e.closest && e.closest('#pb-sidebar'));`),
    await js(`var e=document.elementFromPoint(5, 300); return e ? e.tagName + '#' + e.id : 'none';`));
  ok('no lock button (locks are off for the Playbook)', await js(`var b=document.getElementById('pb-mobile-lock-btn'); return !b || getComputedStyle(b).display === 'none';`));
  await js(`document.querySelector('#pb-entries-list .entry-item[data-entry-id="pb_rules"] .entry-item-title').click(); 1`); await sleep(800);
  ok('the phone header names the open page', await js(`var a=document.querySelector('#pb-entries-list .entry-item.active .entry-item-title'); return !!a && a.innerText === 'Rules' && document.getElementById('pb-mobile-title').value === 'Rules';`),
    await js(`return JSON.stringify([document.getElementById('pb-mobile-title').value, (document.querySelector('#pb-entries-list .entry-item.active .entry-item-title')||{}).innerText]);`));
  ok('the bottom bar sits inside the Playbook, not on the page', await js(`var b=document.getElementById('pb-bottom-bar'), r=document.getElementById('pb-root').getBoundingClientRect(), q=b.getBoundingClientRect(); return getComputedStyle(b).display === 'none' || (q.bottom <= r.bottom + 1 && q.top >= r.top);`));
  const s1 = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath('tradehub-playbook-phone'), Buffer.from(s1.result.data, 'base64'));
  await size(1440, 900); await sleep(800);
  const s2 = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath('tradehub-playbook'), Buffer.from(s2.result.data, 'base64'));
  console.log('  shots ' + shotPath('tradehub-playbook') + ', ' + shotPath('tradehub-playbook-phone'));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  c.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
