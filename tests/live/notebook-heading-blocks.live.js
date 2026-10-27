// Blocks nested inside a heading (docx.js _docxUnnestHeadings). Old pastes left
// lists inside <h1> (TradeHub Playbook's Strategy page, 2026-10-27): every
// bullet took the heading's size, so its marker came out heading-sized. A page
// like that must open with each list, paragraph and quote out of its heading,
// the heading text kept as a heading, in the same order, with list markers at
// the size of the page's own text. Both sides of Notebook, as instances in the
// test host (tests/live/fixtures/notebook-host.html), plus the paste cleaner.
//
// Run: node tests/live/notebook-heading-blocks.live.js
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');
const fs = require('fs');

const URL = 'https://anthonyn99.github.io/A1/tests/live/fixtures/notebook-host.html';
const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};

// The broken shape, as the old paste stored it.
const BROKEN = '<h1>Plan</h1><h1><blockquote><p><strong><span style="font-size:20px;">"A quote."</span></strong></p></blockquote></h1>'
  + '<h1>Rules</h1><h1><ul><li><span style="font-size:14px;">First rule.</span></li><li><span style="font-size:14px;">Second rule.</span></li></ul></h1>'
  + '<h1>Before</h1><h1><p>Ask:</p><ul><li><span style="font-size:14px;">A question?</span></li></ul><p><strong>If no, stop.</strong></p></h1>'
  + '<h2>Mixed <ul><li>inner</li></ul> tail</h2>'
  + '<h1>Plain heading</h1><ul><li>Normal list.</li></ul>';
const T0 = Date.now();
const SIDES = { tony: { K: 'nb', S: 'nb_test', mount: {} }, veda: { K: 'vn', S: 'vn_test', mount: { profile: 'veda', key: 'vn', store: 'vn_test', title: 'Veda Notes' } } };

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 8000) / 200; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(200); } return false; };

  for (const [name, { K, S, mount }] of Object.entries(SIDES)) {
    console.log(`\n[${name}] A page with blocks inside its headings`);
    const seed = { ['dashboards/' + S]: { _order: ['e_bad'], activeId: 'e_bad', savedAt: T0 - 60000,
      e_e_bad: { id: 'e_bad', title: 'Strategy', template: 'page', created: T0 - 86400000, updated: T0 - 60000, tags: [], data: { html: BROKEN, attachments: [] }, rev: 1 } } };
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: 'https://anthonyn99.github.io/A1/tni.js' }); await sleep(400);
    await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(seed))}); 1`);
    await c.send('Page.navigate', { url: URL });
    await until('window.__hostReady', 10000);
    await js(`window.__mount(${JSON.stringify(Object.assign({ pinned: [] }, mount))}).then(() => { window.__mounted = true; }); 1`);
    await until(`window.__mounted && document.querySelector('#${K}-entries-list .entry-item')`, 15000);
    await js(`document.querySelector('#${K}-entries-list .entry-item[data-entry-id="e_bad"] .entry-item-title').click(); 1`);
    await sleep(900);
    const ed = `document.getElementById('${K}-page-editor')`;
    ok('no heading holds a block any more', await js(`return !${ed}.querySelector(':is(h1,h2,h3,h4,h5,h6) :is(ul,ol,p,blockquote,div,table,pre)');`),
      await js(`return ${ed}.innerHTML;`));
    const outline = JSON.parse(await js(`return JSON.stringify([...${ed}.children].map(e => e.tagName + ':' + e.textContent.trim().slice(0, 14)));`));
    ok('the content is all there, in order, headings kept as headings', JSON.stringify(outline) === JSON.stringify([
      'H1:Plan', 'BLOCKQUOTE:"A quote."', 'H1:Rules', 'UL:First rule.Sec', 'H1:Before', 'P:Ask:', 'UL:A question?', 'P:If no, stop.',
      'H2:Mixed', 'UL:inner', 'H2:tail', 'H1:Plain heading', 'UL:Normal list.']), JSON.stringify(outline));
    const sizes = JSON.parse(await js(`var lis = [...${ed}.querySelectorAll('li')]; return JSON.stringify(lis.map(l => [getComputedStyle(l).fontSize, getComputedStyle(l).fontWeight]));`));
    const base = await js(`return getComputedStyle(${ed}).fontSize;`);
    ok('every bullet is the page\'s own text size and weight (its marker with it)', sizes.every(([s, w]) => s === base && Number(w) < 600), base + ' ' + JSON.stringify(sizes));
    ok('the words keep their own formatting (the 14px spans)', await js(`return [...${ed}.querySelectorAll('li span')].every(s => getComputedStyle(s).fontSize === '14px');`));

    // An edit saves the healed shape.
    await js(`if (${ed}.getAttribute('contenteditable') !== 'true') document.getElementById('${K}-btn-edit').click(); 1`); await sleep(300);
    await js(`var e=${ed}; e.focus(); var r=document.createRange(); r.selectNodeContents(e.lastElementChild); r.collapse(false); var s=getSelection(); s.removeAllRanges(); s.addRange(r); 1`);
    await c.send('Input.insertText', { text: ' Edited.' });
    let saved = '';
    for (let i = 0; i < 40; i++) { await sleep(250); saved = await js(`var d=__fakeFs.docs['dashboards/${S}']; return (d && d.e_e_bad && d.e_e_bad.data.html) || '';`); if (/Edited\./.test(saved)) break; }
    ok('the next save stores it healed', /Edited\./.test(saved) && !/<h[1-6][^>]*>(?:(?!<\/h[1-6]>)[\s\S])*<(ul|ol|p|blockquote)[\s>]/i.test(saved), saved.slice(0, 300));
    const shot = shotPath('notebook-heading-blocks-' + name);
    const s = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(s.result.data, 'base64'));
    console.log('  shot ' + shot);
  }

  console.log('\nPasting');
  const cleaned = await js(`return window._docxCleanHTML('<h1><ul><li>pasted</li></ul></h1><h3>ok</h3>');`);
  ok('the paste cleaner takes the list out of the heading', cleaned === '<ul><li>pasted</li></ul><h3>ok</h3>', cleaned);
  ok('no page errors', errs.length === 0, errs.join(' | '));

  c.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
