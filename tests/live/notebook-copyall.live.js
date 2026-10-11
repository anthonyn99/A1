// Notebook's Copy all button and MyJournal without tags, on the fixture host
// (tests/live/fixtures/notebook-host.html: a MyJournal instance, like TradeHub's
// Playbook). Copy all puts the whole page on the clipboard as Markdown (plain
// text) + the document HTML, says "Copied", and leaves the selection alone;
// MyJournal shows no tags row, tag chips or tag in the sidebar.
//
// Run: node tests/live/notebook-copyall.live.js
'use strict';
const LIVE = './';
const { connect, evalJs, sleep } = require(LIVE + 'cdp.js');
const { firebaseMock } = require(LIVE + 'fake-firebase.js');
const URL = 'https://anthonyn99.github.io/A1/tests/live/fixtures/notebook-host.html';
const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + String(x).slice(0, 500) : '')); } };
const T0 = Date.now();
const HTML = '<h2>Rules</h2><p>Cut <strong>losers</strong> fast and <em>let</em> winners run.</p><ul><li>one</li><li>two</li></ul>';
const SEED = { 'dashboards/nb_test': { _order: ['e_1_alpha'], activeId: 'e_1_alpha', savedAt: T0 - 60000,
  e_e_1_alpha: { id: 'e_1_alpha', title: 'Alpha rules', template: 'page', created: T0 - 86400000, updated: T0 - 60000,
    tags: ['old'], data: { html: HTML, attachments: [] }, rev: 1 } } };

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 8000) / 200; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(200); } return false; };
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(SEED))}); 1`);
  await c.send('Page.navigate', { url: URL });
  if (!(await until('window.__hostReady', 10000))) throw new Error('host did not load');
  await js('window.__mount().then(() => { window.__mounted = true; }, (e) => { window.__mountErr = String(e && e.stack || e); }); 1');
  await until('window.__mounted || window.__mountErr', 15000);
  const err = await js('return window.__mountErr || null;'); if (err) throw new Error(err);
  await until('window.__ready', 8000); await sleep(800);
  await js(`var r=document.querySelector('#nb-entries-list .entry-item[data-entry-id="e_1_alpha"] .entry-item-title'); r && r.click(); 1`); await sleep(1200);

  console.log('\nTags are gone');
  ok('no tags row / add-tag input', await js(`return !document.getElementById('nb-tags-row') && !document.getElementById('nb-add-tag-input');`));
  ok('no tag filter chips', await js(`return !document.querySelector('#nb-root .docx-tagchips');`));
  ok('the sidebar row shows no tag', await js(`return document.querySelector('#nb-entries-list .entry-item[data-entry-id="e_1_alpha"]').innerText.indexOf('old') < 0;`),
    await js(`return document.querySelector('#nb-entries-list .entry-item[data-entry-id="e_1_alpha"]').innerText;`));
  ok('the editor shows the page', await js(`return /losers/.test(document.getElementById('nb-page-editor').innerHTML);`));

  console.log('\nCopy all');
  await js(`window.__cb = {}; var o = DataTransfer.prototype.setData; DataTransfer.prototype.setData = function (t, v) { window.__cb[t] = v; return o.call(this, t, v); }; 1`);
  const btn = JSON.parse(await js(`var b=document.querySelector('#nb-page-toolbar .docx-copyall-btn'); if(!b) return 'null'; var r=b.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,txt:b.innerText});`));
  ok('the page toolbar has a Copy all button', btn && btn.w > 0 && /Copy all/.test(btn.txt), JSON.stringify(btn));
  // A real click (user activation), as a person would press it.
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await sleep(300);
  const cb = JSON.parse(await js('return JSON.stringify(window.__cb);'));
  ok('plain text is the Markdown', cb['text/plain'] === '## Rules\n\nCut **losers** fast and *let* winners run.\n\n- one\n- two', JSON.stringify(cb['text/plain']));
  ok('rich text is the document HTML', /<h2>Rules<\/h2>/.test(cb['text/html'] || '') && /<strong>losers<\/strong>/.test(cb['text/html'] || ''), cb['text/html']);
  ok('the button says "Copied"', await js(`return document.querySelector('#nb-page-toolbar .docx-copyall-lbl').textContent === 'Copied';`));
  await sleep(1900);
  ok('...then goes back to "Copy all"', await js(`return document.querySelector('#nb-page-toolbar .docx-copyall-lbl').textContent === 'Copy all';`));
  ok('the editor selection was not changed into a select-all', await js(`var s=getSelection(); return !s.rangeCount || s.isCollapsed || !document.getElementById('nb-page-editor').contains(s.anchorNode);`));

  console.log('\nPhone width');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(800);
  ok('the button is still shown (icon only)', await js(`var b=document.querySelector('#nb-page-toolbar .docx-copyall-btn'); return getComputedStyle(b).display !== 'none' && getComputedStyle(b.querySelector('.docx-copyall-lbl')).display === 'none';`));

  ok('no page errors', errs.length === 0, errs.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
