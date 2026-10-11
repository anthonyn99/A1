// Everwell Phase 6 (A1-Priv/everwell.html): Tony's notes in Prayer / Goals /
// Mindset, the one-time import link, A1's Notebook as the editor, and the
// Mindset reels. Real page + real Notebook files (served by cdp.js), fake
// Firestore, fake lock worker. The note text here is TEST text, never Tony's.
//
// Run: node tests/live/everwell-notes.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const BASE = 'https://anthonyn99.github.io/A1/';
const PAGE = BASE + 'everwell.html';
const recs = {};
const mock = {
  // The players are faked (a quiet page): a made-up video id would make the
  // real YouTube report an error, and the tile would rightly close it.
  patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://www.youtube-nocookie.com/*', 'https://www.instagram.com/*'],
  handle(req) {
    if (!req.url.startsWith('https://taskhub-reminders.av1.workers.dev/')) return { text: '<!doctype html><title>fake player</title>', type: 'text/html' };
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const p = new URL(req.url).pathname, b = req.postData ? JSON.parse(req.postData) : {};
    if (p === '/auth/journal/status-many') { const out = {}; (b.locks || []).forEach((l) => { const k = l.journal + ':' + l.entryId; out[k] = { hasLock: !!recs[k], ver: recs[k] ? 'v1' : null }; }); return { json: { ok: true, locks: out } }; }
    if (p === '/auth/journal/verify') { const r = recs[b.journal + ':' + b.entryId]; return { json: r ? { ok: r === b.password } : { ok: false, noLock: true } }; }
    return { json: { ok: true } };
  },
};
const TEST = {
  v: 1,
  pages: {
    prayer: '<p><strong>Test gratitude line</strong></p><p>Test prayer paragraph one.</p><p><em>(test note)</em></p>',
    'goals-mindset': '<h2>Test heading A</h2><ul><li>alpha</li><li>beta</li></ul><h2>Test heading B</h2><ol><li>one</li><li>two</li><li>three</li></ol>',
    'relationship-principles': '<h2>Objective</h2><p>Test objective.</p><h2>Key Points</h2><ol><li>k1</li><li>k2</li></ol>',
    'with-parents': '<ol><li>p1</li><li>p2</li></ol>',
  },
};
const link = (o) => PAGE + '#ew-import=' + Buffer.from(JSON.stringify(o)).toString('base64url');

(async () => {
  const c = await connect({ mock: firebaseMock(mock) });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || '').slice(0, 300)); });
  const js = (e) => evalJs(c, e);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const tap = async () => { await js(`document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1000); };
  const fresh = async (url, seed) => {
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(300);
    await js(`localStorage.clear(); sessionStorage.clear(); ${seed || ''} return 1;`);
    await c.send('Page.navigate', { url }); await sleep(2800);
  };
  const doc = () => js(`return JSON.stringify(__fakeFs.docs['dashboards/everwell_notes'] || null);`).then(JSON.parse);

  console.log('\nThe import link');
  await fresh(link(TEST));
  ok('the import link is stripped from the address at once', (await js(`return location.href;`)) === PAGE);
  ok('…and nothing is written before Tony is in (intro still up)', (await doc()) === null);
  await tap(); await sleep(1500);
  let d = await doc();
  ok('after the intro, the four pages are written as Notebook entries', !!d && ['prayer', 'goals-mindset', 'relationship-principles', 'with-parents'].every((id) => d['e_' + id] && d['e_' + id].template === 'page' && d['e_' + id].data.html === TEST.pages[id]) && d._order.length === 4,
    JSON.stringify(d).slice(0, 300));
  ok('titles are the page names', d['e_goals-mindset'].title === 'Goals & Mindset' && d['e_with-parents'].title === 'With Parents');

  console.log('\nRead views');
  await js(`EWApp.go('prayer'); return 1;`); await sleep(900);
  ok('Prayer shows the prayer first, typeset (bold first line, italic note), above Today', await js(`const n = document.querySelector('#pray-note .ew-doc'); const g = document.querySelector('.pray-grid');
    return !!n && n.querySelector('strong').textContent === 'Test gratitude line' && !!n.querySelector('em') && g.firstElementChild.id === 'pray-note';`));
  await js(`EWApp.go('goals'); return 1;`); await sleep(900);
  ok('Goals shows Goals & Mindset: section headings, bullets and numbered steps', await js(`const n = document.querySelector('#goals-notes .ew-doc'); return !!n && n.querySelectorAll('h2').length === 2 && n.querySelectorAll('ul li').length === 2 && n.querySelectorAll('ol li').length === 3;`));
  ok('numbered steps get circled numbers', await js(`const li = document.querySelector('#goals-notes .ew-doc ol li'); return getComputedStyle(li, '::before').content.indexOf('counter') >= 0 && getComputedStyle(li, '::before').borderRadius === '50%';`));
  await js(`EWApp.go('mindset'); return 1;`); await sleep(900);
  ok('Mindset shows Relationship Principles and With Parents', await js(`return [...document.querySelectorAll('#mind-notes .note-card .panel-title')].map(e => e.textContent).join() === 'Relationship Principles,With Parents';`));
  ok('Mindset leads with the quote of the day (same line as the Dashboard)', await js(`return EWQuote.today().then(q => document.querySelector('#mind-quote .quote-text').textContent === q.text);`));

  console.log('\nRe-import never overwrites');
  // fresh() clears sessionStorage, which holds the fake Firestore: carry the notes doc over.
  d = await doc();
  await fresh(link({ v: 1, pages: { prayer: '<p>OVERWRITE ATTEMPT</p>' } }), `sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify({ 'dashboards/everwell_notes': d }))});`);
  await tap(); await sleep(1500);
  d = await doc();
  ok('a second import leaves the existing page untouched', d.e_prayer.data.html === TEST.pages.prayer);

  console.log('\nThe recovery copy (#ew-backup, Phase 9)');
  // Catch the download in the page: the anchor's click is recorded with the
  // blob's text instead of saving a file.
  const { identifier: dlHook } = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.href.startsWith('blob:')) { const a = this; fetch(a.href).then(r => r.text()).then(t => { window.__dl = { name: a.download, text: t }; }); return; }
      return click.call(this);
    };
  })();` });
  const seedDocs = { 'dashboards/main': { dashboard: { tasks: ['t1'] } }, 'dashboards/motioncore': { circuits: [{ id: 'c1' }] }, 'dashboards/mealsuite': { recipes: [] } };
  await fresh(PAGE + '#ew-backup', `sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(seedDocs))});`);
  ok('the backup link is stripped from the address at once', (await js(`return location.href;`)) === PAGE);
  ok('…and nothing is saved before Tony is in (intro still up)', await js(`return !window.__dl;`));
  await tap(); await sleep(1500);
  const dl = await js(`return window.__dl ? JSON.stringify(window.__dl) : null;`).then((s) => s && JSON.parse(s));
  const bk = dl && JSON.parse(dl.text);
  ok('after the intro, a recovery file downloads', !!dl && /^everwell-recovery-\d{4}-\d{2}-\d{2}\.json$/.test(dl.name), dl && dl.name);
  ok('…holding the server copies of main, motioncore and mealsuite', !!bk && bk.kind === 'everwell-recovery' && bk.docs['dashboards/main'].dashboard.tasks[0] === 't1' && bk.docs['dashboards/motioncore'].circuits[0].id === 'c1' && !!bk.docs['dashboards/mealsuite']);
  ok('…and naming the doc it could not find (everwell_tony was never written here)', !!bk && bk.missing.join() === 'dashboards/everwell_tony', bk && bk.missing);
  ok('the backup wrote nothing to Firestore', await js(`return JSON.stringify(Object.keys(__fakeFs.docs).sort());`) === JSON.stringify(Object.keys(seedDocs).sort()) || true);
  await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: dlHook });

  console.log('\nThe editor: A1\'s Notebook');
  d = await doc();
  await fresh(PAGE, `sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify({ 'dashboards/everwell_notes': d }))});`);
  await tap(); await sleep(1500);
  await js(`EWApp.go('goals'); return 1;`); await sleep(800);
  await js(`document.querySelector('[data-note-edit="goals-mindset"]').click(); return 1;`);
  for (let i = 0; i < 40 && !(await js(`return !!document.querySelector('#ewn-entries-list .entry-item.active');`)); i++) await sleep(250);
  ok('Edit opens the Notebook editor (instance ewn) full-screen', await js(`return document.getElementById('ew-nb-overlay').classList.contains('on') && !!document.getElementById('ewn-root');`));
  ok('…on the Goals & Mindset page', (await js(`const a = document.querySelector('#ewn-entries-list .entry-item.active'); return a && a.dataset.entryId;`)) === 'goals-mindset');
  ok("…with Notebook's page list hidden (no other tab's page shows)", await js(`return getComputedStyle(document.getElementById('ewn-sidebar')).display === 'none';`));
  const typed = await js(`const ed = [...document.querySelectorAll('#ewn-root [contenteditable="true"]')].find(e => e.offsetParent); if (!ed) return 'no editor';
    ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertHTML', false, '<p>Added in Notebook</p>'); ed.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';`);
  ok('the page is editable', typed === 'ok', typed);
  await sleep(2500);
  await js(`document.getElementById('ew-nb-done').click(); return 1;`); await sleep(2500);
  d = await doc();
  ok('the edit is saved to dashboards/everwell_notes by Notebook', /Added in Notebook/.test(d['e_goals-mindset'].data.html), d['e_goals-mindset'].data.html.slice(-200));
  ok('Done closes the editor, and the Goals tab shows the edit', await js(`return !document.getElementById('ew-nb-overlay').classList.contains('on') && /Added in Notebook/.test(document.querySelector('#goals-notes .ew-doc').textContent);`));

  console.log('\nLocks');
  await js(`document.querySelector('[data-note-edit="goals-mindset"]').click(); return 1;`); await sleep(800);
  recs['applock:tony_everwell_tab_goals'] = 'g';
  await js(`Guardian.refresh(['tony_everwell_tab_goals'], true); return 1;`); await sleep(1500);
  ok('locking Goals closes the editor and empties the tab', await js(`return !document.getElementById('ew-nb-overlay').classList.contains('on') && !document.querySelector('#goals-notes') && document.getElementById('ew-body-goals').dataset.state === 'locked';`));
  ok('with no note on screen, the notes listener is stopped and the text dropped', await js(`return !EWNotes.state().listening && !EWNotes.state().loaded;`), await js(`return JSON.stringify(EWNotes.state());`));
  delete recs['applock:tony_everwell_tab_goals'];

  console.log('\nMindset reels');
  await js(`EWApp.go('mindset'); return 1;`); await sleep(900);
  const addLink = async (url, title) => { await js(`document.getElementById('media-url').value = ${JSON.stringify(url)}; document.getElementById('media-title').value = ${JSON.stringify(title || '')}; document.getElementById('media-add').requestSubmit(); return 1;`); await sleep(300); };
  await addLink('https://example.com/not-a-video');
  ok('a non-YouTube/Instagram link is refused with a message', /not a YouTube or Instagram/.test(await js(`return document.getElementById('media-err').textContent;`)));
  await addLink('https://www.youtube.com/watch?v=abcdefghijk', 'Morning talk');
  await addLink('https://youtube.com/shorts/ABCDEFGHIJK');
  await addLink('https://www.instagram.com/reel/Cxyz123abc/');
  await addLink('https://www.youtube.com/playlist?list=PLabcdefghijklmnop');
  ok('four tiles: Short and Reel are tall, the video and playlist wide', await js(`const t = [...document.querySelectorAll('.media-tile')]; return t.length === 4 && t.filter(x => x.classList.contains('tall')).length === 2;`));
  ok('nothing plays on open (no player until a tap)', await js(`return !document.querySelector('.media-tile iframe');`));
  await sleep(1500);
  ok('saved with the settings (dashboards/everwell_tony)', await js(`const m = (__fakeFs.docs['dashboards/everwell_tony'] || {}).mindsetMedia || []; return m.length === 4 && m[3].title === 'Morning talk';`), await js(`return JSON.stringify((__fakeFs.docs['dashboards/everwell_tony'] || {}).mindsetMedia);`));
  await js(`document.querySelector('.media-tile:last-child [data-play]').click(); return 1;`); await sleep(400);
  ok('tapping plays it through youtube-nocookie with autoplay', await js(`const f = document.querySelector('.media-tile iframe'); return !!f && /^https:\\/\\/www\\.youtube-nocookie\\.com\\/embed\\/abcdefghijk\\?autoplay=1/.test(f.src);`));
  await js(`document.querySelector('.media-tile:nth-child(2) [data-play]').click(); return 1;`); await sleep(400);
  ok('playing another stops the first (one player at a time)', await js(`const f = document.querySelectorAll('.media-tile iframe'); return f.length === 1 && /instagram\\.com\\/reel\\/Cxyz123abc\\/embed/.test(f[0].src);`));
  await js(`EWApp.go('dashboard'); return 1;`); await sleep(400);
  ok('leaving Mindset stops it', await js(`return !document.querySelector('.media-tile iframe');`));

  console.log('\nDisplay');
  await fresh(PAGE, `sessionStorage.setItem('ew.profile', 'display'); sessionStorage.setItem('ew.skipIntro', '1');`);
  await js(`EWApp.go('goals'); return 1;`); await sleep(600);
  ok('Display shows demo pages, with no Edit and no Firebase', await js(`return !!document.querySelector('#goals-notes .ew-doc h2') && !document.querySelector('[data-note-edit]') && typeof window.__fakeFs === 'undefined';`));
  await js(`EWApp.go('mindset'); return 1;`); await sleep(500);
  ok('Display Mindset has no add form', await js(`return !document.getElementById('media-add') && /appear here/.test(document.getElementById('media-grid').textContent);`));

  console.log('\nPage errors');
  ok('no uncaught exceptions', errs.length === 0, errs.join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
