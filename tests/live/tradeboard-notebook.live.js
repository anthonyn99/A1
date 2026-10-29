// TradeBoard's Strats is V's Notebook (V1/TradeBoard/tradeboard.html TB.st,
// 2026-10-29): an instance of Veda's side (key vtb, store
// dashboards/tradeboard_strats) on its own Firebase app on the Index project.
// Real TradeBoard page, real Notebook, fake Firestore.
//
// Seeded with Strats as the old editor kept them (a JSON "strats" field on the
// tradeboard document: a rich page with a table and a Markdown page), it
// checks that they all move in once, as pages, with the old field left as
// the backup and the old open page opened; that TradeBoard's own table styles
// stay out of Notebook's pages; that new pages save to Notebook's store; that
// a reload moves nothing again; and the phone layout.
//
// Run: node tests/live/tradeboard-notebook.live.js
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');
const fs = require('fs');

const URL = 'https://anthonyn99.github.io/A1/V1/TradeBoard/tradeboard.html';
const ORIGIN = 'https://anthonyn99.github.io';
const S = 'dashboards/tradeboard_strats';
const TBDOC = 'tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

const T0 = Date.now();
const PAGES = [
  { id: 'tabc1', title: 'Breakout Playbook', isMarkdown: false, md: '', created: T0 - 900000, updated: T0 - 800000,
    html: '<h1>Breakout Playbook</h1><table><thead><tr><th>Setup</th><th>Stop</th></tr></thead><tbody><tr><td>Range break</td><td>Candle low</td></tr></tbody></table>' },
  { id: 'tabc2', title: 'Daily Rules', isMarkdown: true, html: '', created: T0 - 700000, updated: T0 - 600000,
    md: '# Daily Rules\n\n- [ ] Review news\n\n1. **No trade** without a plan\n\n> cut it' },
];
const SEED = { [TBDOC]: { strats: JSON.stringify(PAGES), stratsActive: JSON.stringify('tabc2'),
  rulesDaily: JSON.stringify({ lastCompleted: null, enabled: false }), _updated: T0 } };

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
  const rows = async () => JSON.parse(await js(`return JSON.stringify([...document.querySelectorAll('#vtb-entries-list .entry-item')].map(r => ({ id: r.dataset.entryId, t: r.querySelector('.entry-item-title').innerText })));`));
  const shot = async (n) => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shotPath(n), Buffer.from(s.result.data, 'base64')); console.log('  shot ' + shotPath(n)); };
  const boot = async () => {
    await c.send('Page.navigate', { url: URL });
    if (!(await until(`typeof TB !== 'undefined' && TB.st && window._tbCloudSeen`, 15000))) throw new Error('TradeBoard did not open');
    await sleep(800);
    await js(`TB.showSection('strats'); 1`);
    if (!(await until(`document.querySelector('#st-host #vtb-root')`, 15000))) throw new Error('Strats did not mount');
    await sleep(1500);
  };

  await c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 860, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: 'https://anthonyn99.github.io/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(SEED))}); 1`);
  await c.send('Page.navigate', { url: URL });
  await until(`typeof TB !== 'undefined' && window._tbCloudSeen`, 15000); await sleep(800);

  console.log('\nThe old editor is gone; Notebook waits until Strats opens');
  ok('no old Strats editor in the page', await js(`return !document.getElementById('st-editor') && !document.getElementById('st-list') && !!document.getElementById('st-host');`));
  ok('Notebook is not mounted before Strats opens', await js(`return !!window.Notebook && !window.Notebook.mounts.vtb;`));
  await js(`TB.showSection('strats'); 1`);
  ok('Strats mounts V\'s Notebook in the section', await until(`document.querySelector('#st-host #vtb-root')`, 15000)
    && await js(`return document.getElementById('vtb-root').getAttribute('data-notebook-side') === 'veda';`));

  console.log('\nThe old pages move in, once');
  let D = null;
  for (let i = 0; i < 60; i++) { await sleep(250); D = await doc(S); if (D && D._imported && D._imported['tb-strats']) break; }
  ok('both pages are in dashboards/tradeboard_strats, the move recorded', D && D.e_st_tabc1 && D.e_st_tabc2 && D._imported && D._imported['tb-strats'] > 0, JSON.stringify(D && Object.keys(D)));
  ok('the rich page keeps its title, dates and HTML', D && D.e_st_tabc1.title === 'Breakout Playbook' && D.e_st_tabc1.created === T0 - 900000
    && D.e_st_tabc1.updated === T0 - 800000 && /<table>/.test(D.e_st_tabc1.data.html), JSON.stringify(D && D.e_st_tabc1));
  const mdHtml = D && D.e_st_tabc2 && D.e_st_tabc2.data.html;
  ok('the Markdown page is its rendered HTML (heading, task, list, bold, quote)', /<h1[^>]*>Daily Rules<\/h1>/.test(mdHtml || '') && /Review news/.test(mdHtml || '')
    && /<ol>[\s\S]*<strong>No trade<\/strong>/.test(mdHtml || '') && /<blockquote>[\s\S]*cut it/.test(mdHtml || ''), mdHtml);
  ok('the old field is untouched (the backup)', (await doc(TBDOC)).strats === SEED[TBDOC].strats);
  let R = await rows();
  ok('the list shows both pages', R.map((r) => r.id).sort().join() === 'st_tabc1,st_tabc2', JSON.stringify(R));
  ok('the page that was open in the old editor is open', await until(`document.getElementById('vtb-entry-title-input').value === 'Daily Rules'`, 5000),
    await js(`return document.getElementById('vtb-entry-title-input').value;`));

  console.log('\nTradeBoard\'s own styles stay out of the pages');
  await js(`document.querySelector('#vtb-entries-list .entry-item[data-entry-id="st_tabc1"] .entry-item-title').click(); 1`);
  await until(`document.querySelector('#vtb-page-editor table th')`, 5000);
  ok('a page table is not styled as a TradeBoard data table', await js(`var th=document.querySelector('#vtb-page-editor table th'), cs=getComputedStyle(th); return cs.position !== 'sticky' && cs.fontSize !== '9.5px';`),
    await js(`var cs=getComputedStyle(document.querySelector('#vtb-page-editor table th')); return cs.position + ' ' + cs.fontSize;`));
  ok('the page fits the section (fit-width or 100%)', await js(`var r=document.getElementById('vtb-page-editor').getBoundingClientRect(), h=document.getElementById('st-host').getBoundingClientRect(); return r.left >= h.left - 1 && r.right <= h.right + 1;`));
  await shot('tradeboard-notebook');

  console.log('\nWriting');
  await js(`document.getElementById('vtb-new-entry-btn').click(); 1`); await sleep(300);
  await js(`document.querySelector('#vtb-root .template-card[data-template="page"]').click(); 1`); await sleep(500);
  await js(`var t=document.getElementById('vtb-entry-title-input'); t.value='Gap fill'; t.dispatchEvent(new Event('input',{bubbles:true})); 1`);
  const newId = await js(`return document.querySelector('#vtb-entries-list .entry-item.active').dataset.entryId;`);
  for (let i = 0; i < 40; i++) { await sleep(250); D = await doc(S); if (D['e_' + newId] && D['e_' + newId].title === 'Gap fill') break; }
  ok('a new page is saved to Notebook\'s store', D['e_' + newId] && D['e_' + newId].title === 'Gap fill');
  ok('...and nothing was written to the old field', (await doc(TBDOC)).strats === SEED[TBDOC].strats);
  const paths = JSON.parse(await js(`return JSON.stringify([...new Set(__fakeFs.log.map(l => l.path))]);`));
  ok('Notebook wrote only its own documents', paths.filter((p) => /^dashboards\//.test(p)).every((p) => p.indexOf(S) === 0), JSON.stringify(paths));

  console.log('\nA reload moves nothing again');
  await boot();
  const imports = await js(`return __fakeFs.log.filter(l => l.path === '${S}' && l.data && l.data._imported).length;`);
  ok('no move runs again', imports === 0, imports);
  R = await rows();
  ok('all three pages are listed', R.length === 3 && R.some((r) => r.id === newId), JSON.stringify(R));

  console.log('\nOn a phone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await boot();
  ok('the notes fill the section under the nav, to the bottom', await js(`var h=document.getElementById('st-host').getBoundingClientRect(); return h.width >= 380 && h.height > 550 && h.bottom <= innerHeight + 1;`),
    await js(`return JSON.stringify(document.getElementById('st-host').getBoundingClientRect());`));
  ok('...with Notebook\'s phone bar at the foot', await js(`var b=document.getElementById('vtb-bottom-bar'); return !!b && b.getClientRects().length > 0 && b.getBoundingClientRect().bottom <= innerHeight + 1;`));
  await shot('tradeboard-notebook-phone');

  ok('no page errors', errs.length === 0, errs.join(' | '));
  c.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
