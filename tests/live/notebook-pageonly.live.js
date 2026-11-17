// Page only (Tony, 2026-11-17): Notebook has one template, Page, on both sides
// and in OurJournal (Tony's Journal Entries stays until he retires it), and
// Veda's tags are gone. Every entry made with another template becomes a page
// (Notebook/core/convert.js). Real browser, fake Firestore, and the real drawing
// engines (cdn.jsdelivr.net, proxied from here) so boards are really drawn.
//
// For each side:
//   - every old entry in the person's own journal becomes a page on load: Notes
//     and Cornell keep their words as sections, an old canvas mind map becomes a
//     picture plus its outline, an old whiteboard a picture; attachments land on
//     the page; each is a new revision;
//   - BEFORE it changes, the entry as it was is in dashboards/<store>_legacy_<id>,
//     and no board document is written;
//   - the template picker offers Page (and Tony's Journal Entries) only; on
//     Veda's side + makes a page straight away; her tags are gone;
//   - an OurJournal board becomes a page when opened (index + content written).
//
// Run: node tests/live/notebook-pageonly.live.js [tony|veda]   (CDP_PORT=93xx)
'use strict';
const https = require('https');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');
const fs = require('fs');

const ORIGIN = 'https://anthonyn99.github.io', BASE = ORIGIN + '/A1/';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const T0 = Date.now();
// A small red square, as an old whiteboard's flat PNG and an attachment.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGElEQVR42mP8z8DwnwEJMDHgAaMaRg0YAQB9fwH/rM7WeAAAAABJRU5ErkJggg==';
const entry = (id, title, template, data, extra) => Object.assign({ id, title, template, created: T0 - 86400000, updated: T0 - 3600000,
  tags: [], data, rev: 3 }, extra || {});
const SEEDS = {
  veda: [
    entry('e_1_notes', 'Study notes', 'notes', { main: 'Main idea line one.\n\nSecond paragraph https://example.com', links: 'Link section text', questions: 'Why is the sky blue?', attachments: [{ id: 'a1', name: 'pic.png', mime: 'image/png', data: PNG }, { id: 'a2', name: 'notes.txt', mime: 'text/plain', data: 'data:text/plain;base64,aGVsbG8=' }] }, { tags: ['school'] }),
    entry('e_2_corn', 'Cornell one', 'cornell', { topic: 'Photosynthesis', cues: 'Chlorophyll?', notes: 'Light becomes sugar.', summary: 'Plants eat light.', attachments: [] }),
    entry('e_3_mmap', 'Old map', 'mindmap', { nodes: [{ id: 1, x: 300, y: 200, label: 'Central topic', root: true }, { id: 2, x: 100, y: 100, label: 'Branch alpha' }, { id: 3, x: 500, y: 100, label: 'Branch beta' }], edges: [{ from: 1, to: 2 }, { from: 1, to: 3 }], attachments: [] }),
    entry('e_4_wb', 'Old board', 'whiteboard', { canvas: PNG, attachments: [] }),
    entry('e_5_page', 'A page', 'page', { html: '<p>Untouched page.</p>', attachments: [] }),
  ],
  tony: [
    entry('e_3_mmap', 'Old map', 'mindmap', { nodes: [{ id: 1, x: 300, y: 200, label: 'Central topic', root: true }, { id: 2, x: 100, y: 100, label: 'Branch alpha' }], edges: [{ from: 1, to: 2 }], attachments: [] }),
    entry('e_4_wb', 'Old board', 'whiteboard', { canvas: PNG, attachments: [] }),
    entry('e_5_page', 'A page', 'page', { html: '<p>Untouched page.</p>', attachments: [] }),
    entry('e_6_je', 'Diary', 'journal-entries', { dates: { '2026-11-01': { html: '<p>Dear diary</p>' } }, activeDateKey: '2026-11-01', dateOrder: ['2026-11-01'] }),
  ],
};
const SIDES = {
  tony: { K: 'tj', doc: 'dashboards/tony_journal', pre: 'tony_journal', open: "window._tonyNav('brainstormjournal')" },
  veda: { K: 'bj', doc: 'dashboards/journal', pre: 'journal', open: "window._vedaNav('journal')" },
};
function seedDoc(list) { const d = { _order: list.map((e) => e.id), activeId: 'e_5_page', savedAt: T0 - 3600000 }; for (const e of list) d['e_' + e.id] = e; return d; }
const OJ_SEED = { 'dashboards/ourjournal': { m_e_9_ojwb: { id: 'e_9_ojwb', title: 'Shared board', template: 'whiteboard', created: T0 - 86400000, updated: T0 - 3600000, creator: 'veda', ord: 0 } } };

// The drawing engines, fetched for real (the harness refuses every other site).
const cdnCache = new Map();
function fetchText(url) {
  if (cdnCache.has(url)) return cdnCache.get(url);
  const p = new Promise((res) => {
    const go = (u, n) => https.get(u, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && n < 5) { r.resume(); return go(new URL(r.headers.location, u).href, n + 1); }
      const chunks = []; r.on('data', (c) => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode, buf: Buffer.concat(chunks), type: r.headers['content-type'] || 'application/javascript' }));
    }).on('error', () => res(null));
    go(url, 0);
  });
  cdnCache.set(url, p);
  return p;
}
function withCdn(mock) {
  return {
    patterns: (mock.patterns || []).concat(['https://cdn.jsdelivr.net/*']),
    handle(req) {
      if (req.url.startsWith('https://cdn.jsdelivr.net/')) {
        if (req.method === 'OPTIONS') return { status: 204, text: '' };
        // Text only (the harness sends a body as UTF-8): scripts and styles. A font
        // or image is refused; the engines fall back without it.
        return fetchText(req.url).then((r) => (r && /javascript|css|json|text/.test(r.type)) ? { status: r.status, text: r.buf.toString('utf8'), type: r.type } : { status: 404, text: '' });
      }
      return mock.handle(req);
    },
  };
}

(async () => {
  const fake = firebaseMock();
  const c = await connect({ mock: withCdn(fake) });
  const js = (e) => evalJs(c, e);
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const doc = (path) => js(`return JSON.stringify(window.__fakeFs && __fakeFs.docs[${JSON.stringify(path)}] || null);`).then(JSON.parse);

  for (const who of ['veda', 'tony']) {
    if (process.argv[2] && process.argv[2] !== who) continue;
    const { K, doc: D, pre, open } = SIDES[who];
    const R = '#' + K + '-root';
    console.log(`\n${who === 'tony' ? "T's" : "V's"} Notebook`);
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(400);
    const seeds = Object.assign({ [D]: seedDoc(SEEDS[who]) }, OJ_SEED);
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','${who}'); localStorage.setItem('a1b_disabled','1');
      var d=new Date(); localStorage.setItem('a1_sweep_day:index', d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2));
      sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(seeds))}); 1`);
    await c.send('Page.navigate', { url: BASE + 'index.html' }); await sleep(2500);
    for (let i = 0; i < 120; i++) { if (await js(`var l=document.getElementById('th-boot-loader'); return !!window._profileGoTony && (!l || l.classList.contains('th-boot-hide'));`)) break; await sleep(250); }
    await sleep(800); await js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); ${open}; 1`);

    // Every old entry becomes a page (boards are drawn, which takes a moment).
    const old = SEEDS[who].filter((e) => e.template !== 'page' && e.template !== 'journal-entries');
    let J = null;
    for (let i = 0; i < 160; i++) {
      await sleep(500);
      J = await doc(D);
      if (J && old.every((e) => J['e_' + e.id] && J['e_' + e.id].template === 'page')) break;
    }
    for (const e of old) {
      const now = J && J['e_' + e.id];
      ok(`${e.template} "${e.title}" is now a page, saved as a new revision`, !!now && now.template === 'page' && now.rev === e.rev + 1 && typeof now.data.html === 'string', now && JSON.stringify({ t: now.template, rev: now.rev }));
      const bk = await doc(`dashboards/${pre}_legacy_${e.id}`);
      ok(`…and the entry as it was is backed up first (${pre}_legacy_${e.id})`, !!bk && bk.template === e.template && bk.entry && JSON.stringify(bk.entry.data) === JSON.stringify(e.data), bk && JSON.stringify(bk).slice(0, 200));
    }
    const html = (id) => ((J && J['e_' + id] && J['e_' + id].data.html) || '');
    if (who === 'veda') {
      const n = html('e_1_notes');
      ok('Notes: its three sections carry their words, links linked', /<h2>Main notes<\/h2>/.test(n) && /Main idea line one\./.test(n) && /<a href="https:\/\/example\.com">/.test(n) && /Link section text/.test(n) && /Why is the sky blue\?/.test(n), n.slice(0, 400));
      ok('Notes: its attachments are on the page (image and file)', /<img[^>]*(bj-fbimg:\/\/|data:image)/.test(n) && /bj-file-chip/.test(n) && /notes\.txt/.test(n), n.slice(-400));
      const cn = html('e_2_corn');
      ok('Cornell: topic, cues, notes and summary', /Photosynthesis/.test(cn) && /Chlorophyll\?/.test(cn) && /Light becomes sugar\./.test(cn) && /Plants eat light\./.test(cn), cn.slice(0, 300));
      ok('a line says what it was (and that the original is kept)', /Converted from a Cornell notes/.test(cn) && /kept as a backup/.test(cn));
    }
    const mm = html('e_3_mmap');
    ok('old canvas mind map: a picture of the map and its outline', /<img/.test(mm) && /Central topic/.test(mm) && /Branch alpha/.test(mm) && /<ul>/.test(mm), mm.slice(0, 300));
    const wb = html('e_4_wb');
    ok('old whiteboard: a picture of the board', /<img/.test(wb) && /Converted from a Whiteboard/.test(wb), wb.slice(0, 300));
    ok('a page and Journal Entries are left exactly as they were', html('e_5_page') === '<p>Untouched page.</p>' && J['e_e_5_page'].rev === 3 && (who !== 'tony' || (J['e_e_6_je'].template === 'journal-entries' && J['e_e_6_je'].rev === 3)));
    const vizWrites = await js(`return __fakeFs.log.filter(l => /_viz_|_vizf_|_canvas_/.test(l.path)).map(l => l.path);`);
    ok('no board document was written (they stay as they were)', vizWrites.length === 0, JSON.stringify(vizWrites));
    const imgs = await js(`return __fakeFs.log.filter(l => /_img_/.test(l.path)).map(l => JSON.stringify(l.data||{}).length);`);
    ok('board pictures were moved out to their own image documents, each under 1 MB', imgs.length >= 2 && imgs.every((b) => b < 1000000), JSON.stringify(imgs));

    // Opening a converted entry shows it as a page.
    await js(`document.querySelector('#${K}-entries-list .entry-item[data-entry-id="e_3_mmap"]').click(); 1`); await sleep(1200);
    ok('a converted entry opens as a page', await js(`return document.getElementById('${K}-page-area').style.display === 'flex' && /Central topic/.test(document.getElementById('${K}-page-editor').innerHTML);`));
    await c.send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(shotPath('nbpo-' + who + '-map'), Buffer.from(r.result.data, 'base64')));

    // The picker.
    const before = await js(`return document.querySelectorAll('#${K}-entries-list .entry-item').length;`);
    await js(`document.getElementById('${K}-new-entry-btn').click(); 1`); await sleep(700);
    if (who === 'veda') {
      ok('+ makes a page straight away (one template: no picker)', await js(`return !document.getElementById('bj-template-modal').classList.contains('open') && document.querySelectorAll('#bj-entries-list .entry-item').length === ${before + 1};`) && await js(`var a=document.querySelector('#bj-entries-list .entry-item.active'); return !!a && /PAGE/.test(a.textContent);`));
      ok('her tags are gone (no tag row, no tag filter, no tag in a row)', await js(`return !document.getElementById('bj-tags-row') && !document.getElementById('bj-add-tag-input') && !document.querySelector('.docx-tagchips, #bj-tagfilter-row') && !/school/.test(document.getElementById('bj-entries-list').textContent);`));
      ok('no Templates button', await js(`return !document.getElementById('bj-btn-template') && !document.getElementById('bj-bb-template');`));
    } else {
      const cards = await js(`return [...document.querySelectorAll('#tj-template-modal .template-card')].filter(c => getComputedStyle(c).display !== 'none').map(c => c.dataset.template);`);
      ok('the picker offers Page and Journal Entries only', JSON.stringify(cards) === '["page","journal-entries"]', JSON.stringify(cards));
      await js(`document.getElementById('tj-close-modal').click(); 1`); await sleep(300);
    }

    // OurJournal: a shared board becomes a page when it is opened.
    await js(`var t=document.querySelector('${R} .oj-tab[data-oj="1"], ${R} .mjd-rail-btn.oj-tab'); if(t) t.click(); 1`); await sleep(1500);
    await js(`var it=document.querySelector('#${K}-entries-list .entry-item[data-entry-id="e_9_ojwb"]'); if(it) it.click(); 1`);
    let O = null, OC = null;
    for (let i = 0; i < 40; i++) { await sleep(500); O = await doc('dashboards/ourjournal'); if (O && O.m_e_9_ojwb && O.m_e_9_ojwb.template === 'page') break; }
    for (let i = 0; i < 20; i++) { OC = await doc('dashboards/ourjournal_c_e_9_ojwb'); if (OC && OC.d && /Converted from a Whiteboard/.test(OC.d.html || '')) break; await sleep(500); }
    ok('OurJournal: the shared board is a page once opened (index says page)', !!O && O.m_e_9_ojwb.template === 'page', O && JSON.stringify(O.m_e_9_ojwb));
    ok('…its content document holds the page', !!OC && !!OC.d && /Converted from a Whiteboard/.test(OC.d.html || ''), OC && JSON.stringify(OC).slice(0, 300));
    ok('…backed up first (ourjournal_legacy_e_9_ojwb)', !!(await doc('dashboards/ourjournal_legacy_e_9_ojwb')));
    ok('…and it is on screen as a page', await js(`return document.getElementById('${K}-page-area').style.display === 'flex';`));
    await js(`document.getElementById('${K}-new-entry-btn').click(); 1`); await sleep(700);
    ok('OurJournal: + makes a page straight away', await js(`return !document.getElementById('${K}-template-modal').classList.contains('open');`));
  }

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
