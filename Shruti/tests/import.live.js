// LIVE test: Import and drag to reorder (Phase 8) in real headless Edge, on
// the real origin served from this working copy. Not run by npm test.
//
//   node Shruti/tests/import.live.js          (CDP_ALLOW_FONTS=1 for real typefaces)
//
// Orca is answered here; Firebase is fake. Tony at 1280: a pasted book (AI
// chapters, split, merge, leave out, drag, Alt + arrows, saved to Mine), a
// Word file and an EPUB made in the page with JSZip, a PDF made with jsPDF
// (saved to Shared), reading and Make with AI on an imported chapter, rename,
// delete; then a drag on every list. Veda at 390: the shared book is hers to
// read, Tony's own is not, her orders are her own, a finger holds to drag.
'use strict';
const path = require('path');
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'cdp.js'));
const { firebaseMock } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'fake-firebase.js'));
const ev = (c, x) => evalJs(c, /^\s*return\b/.test(x) && x.indexOf(';') < 0 ? x + ';' : x);

const URL = 'https://anthonyn99.github.io/A1/Shruti/shruti.html';
const KEY = 'orca_sk_live_test_key_123';
const ORCA = 'https://orca.vedapatel05.workers.dev/v1';
const set4 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'study', 'ch04.json'), 'utf8'));

const BOOK = [
  'THE LITTLE BOOK OF DAYS', 'by A. Writer', '',
  'Chapter 1: Morning', 'The sun came up over the hills, and the vil-', 'lage woke slowly. Birds sang in the old fig tree by the well.', '',
  'Chapter 2: Noon', 'At noon the market was loud with voices and the smell of bread.', '',
  'Chapter 3: Night', 'Night fell, and the lamps were lit one by one along the river.',
].join('\n');
// What the fake unit answers: one start wrong by one, one chapter that is not there.
const TOC = JSON.stringify({ title: 'The Little Book of Days', author: 'A. Writer', chapters: [
  { title: 'Morning', start: 2, anchor: 'Chapter 1: Morning' },
  { title: 'Noon', start: 5, anchor: 'Chapter 2: Noon' },
  { title: 'Night', start: 6, anchor: 'Chapter 3: Night' },
  { title: 'Epilogue', start: 9, anchor: 'A part this book does not have' },
] });
const LESSONS = JSON.stringify({ lessons: [{ id: 'L1', title: 'Mornings are slow and kind.', body: 'The village wakes gently.' }], summary: 'A quiet morning.' });

const S = { chats: [] };
const sse = (text) => text.match(/[\s\S]{1,90}/g).map((p) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
const mock = firebaseMock({
  patterns: [ORCA + '/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = req.url;
    if (u.startsWith(ORCA + '/models')) return { json: { object: 'list', data: [{ id: 'deepseek/free', routable: true }, { id: 'chatgpt/free', routable: true }] } };
    if (u.startsWith(ORCA + '/chat/completions')) {
      const b = JSON.parse(req.postData || '{}'), body = JSON.stringify(b.messages);
      S.chats.push({ model: b.model, body });
      if (/find the chapters of a book/.test(body)) return { type: 'text/event-stream', text: sse(TOC) };
      if (/repair text that was extracted/.test(body)) {
        // Fix the one broken word, and try to reword another (it must be refused).
        const lines = (/<source>\\n([\s\S]*?)\\n<\/source>/.exec(body) || [])[1] || '';
        const ps = lines.split('\\n').map((l) => l.replace(/^\d+ \| /, '').replace('loud with voices', 'noisy with voices'));
        return { type: 'text/event-stream', text: sse(JSON.stringify({ paragraphs: ps })) };
      }
      return { type: 'text/event-stream', text: sse(LESSONS) };
    }
    return null;
  },
});

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -> ' + String(d).slice(0, 400) : '')); }
};
const waitFor = async (c, expr, ms = 12000) => {
  const t0 = Date.now();
  if (expr.indexOf(';') >= 0 && !/^\s*(return|const|let|var|if|for)\W/.test(expr)) expr = 'return ' + expr;
  while (Date.now() - t0 < ms) { try { if (await ev(c, expr)) return true; } catch {} await sleep(150); }
  return false;
};
const shot = async (c, name) => {
  await sleep(600);
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const data = r && (r.result ? r.result.data : r.data);
  if (data) fs.writeFileSync(shotPath('shruti-' + name), Buffer.from(data, 'base64'));
};
const at = async (c, sel, i = 0) => JSON.parse(await ev(c, `const e=document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if(!e) return 'null'; e.scrollIntoView({block:'center', behavior:'instant'}); const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height})`));
async function click(c, sel, i = 0) {
  const p = await at(c, sel, i);
  if (!p) throw new Error('no ' + sel);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
/** Mouse: press on row `from` (at its edge, off its controls), move onto row `to`, release. */
async function mouseDrag(c, sel, from, to, { dx = 0, edge = 0.12 } = {}) {
  const a = await at(c, sel, from);
  const b = JSON.parse(await ev(c, `const e=document.querySelectorAll(${JSON.stringify(sel)})[${to}]; const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height})`));
  const x0 = a.x - a.w / 2 + Math.max(6, a.w * edge) + dx, y0 = a.y;
  const x1 = b.x - b.w / 2 + Math.max(6, b.w * edge) + dx + (b.x > a.x + 4 ? 6 : b.x < a.x - 4 ? -6 : 0), y1 = b.y + (b.y > a.y + 4 ? 6 : b.y < a.y - 4 ? -6 : 0);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 16; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / 16, y: y0 + (y1 - y0) * i / 16, button: 'left', buttons: 1 }); await sleep(16); }
  await sleep(60);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
  await sleep(420);
}
/** A finger: hold 450 ms (the 300 ms hold), then move and lift. */
async function touchDrag(c, sel, from, to, { edge = 0.5 } = {}) {
  const a = await at(c, sel, from);
  const b = JSON.parse(await ev(c, `const e=document.querySelectorAll(${JSON.stringify(sel)})[${to}]; const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+Math.max(6, r.width*${edge}),y:r.top+r.height/2})`));
  const x0 = a.x - a.w / 2 + Math.max(6, a.w * edge), y0 = a.y, x1 = b.x + (b.x > a.x + 4 ? 6 : b.x < a.x - 4 ? -6 : 0), y1 = b.y + (b.y > a.y + 4 ? 6 : b.y < a.y - 4 ? -6 : 0);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  await sleep(450);
  for (let i = 1; i <= 16; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 16, y: y0 + (y1 - y0) * i / 16 }] }); await sleep(16); }
  await sleep(60);
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(420);
}
async function altKey(c, sel, i, k) {
  await ev(c, `const r=document.querySelectorAll(${JSON.stringify(sel)})[${i}]; (r.matches('button,[tabindex]') ? r : r.querySelector('button,[tabindex]')).focus(); return 1`);
  const code = { ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37 }[k];
  for (const type of ['rawKeyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code, modifiers: 1 });
  await sleep(300);
}
const keysOf = (c, sel) => ev(c, `return [...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.dataset.dkey).join('|')`);
const texts = (c, sel, sub) => ev(c, `return [...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>(${sub ? `e.querySelector(${JSON.stringify(sub)})` : 'e'})?.${sub === '.imp-t' ? 'value' : 'textContent'}.trim()).join('|')`);
const errs = (c) => ev(c, `return (window.__errs||[]).join(' | ')`);

let RUN = String(Date.now());
const BOOT = (store) => `(()=>{ if(window.top!==window) return;
  try{ if(sessionStorage.getItem('__run')!=='${RUN}'){ localStorage.clear(); sessionStorage.clear(); ${store || ''} sessionStorage.setItem('__run','${RUN}'); } }catch(e){}
  window.__errs=[]; addEventListener('error', e=>window.__errs.push(String(e.message)));
  addEventListener('unhandledrejection', e=>window.__errs.push('rejection: '+String(e.reason && e.reason.message || e.reason)));
})();`;
let inj = null;
async function load(c, { w, h, mobile, store, hash = '' }) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  if (inj) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });
  inj = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT(store) });
  await c.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await c.send('Page.navigate', { url: URL + hash });
  await sleep(400);
}
const imp = (x) => `const IMP = await import(new URL('import.js', location.href).href); ${x}`;

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  console.log('\nTony at 1280: the library');
  await load(c, { w: 1280, h: 900, mobile: false, store: "sessionStorage.removeItem('__fakefs_docs'); sessionStorage.setItem('shruti.pick','tony');", hash: '#/' });
  await waitFor(c, `!!window.Shruti && window.Shruti.core.me.loaded && window.Shruti.core.shared.loaded`, 15000);
  await ev(c, `return window.Shruti.core.me.set({orcaKey:${JSON.stringify(KEY)}},{now:true}) || 1`);
  ok('Mine is empty and offers Import', await waitFor(c, `/Import a book/.test(document.querySelector('#shelf-mine .shelf-add')?.textContent||'')`));
  await shot(c, 'import-library-tony-1280');
  await click(c, '#shelf-mine .shelf-add');
  ok('the Import sheet opens on a file or paste', await waitFor(c, `!!document.querySelector('#imp-sheet .imp-drop input[type=file]') && !!document.querySelector('#imp-paste')`));
  await shot(c, 'import-source-tony-1280');

  console.log('\nA pasted book');
  await ev(c, `const t=document.querySelector('#imp-paste'); t.value=${JSON.stringify(BOOK)}; return 1`);
  await click(c, '#imp-use');
  ok('the review lists its parts from its headings', await waitFor(c, `document.querySelectorAll('.imp-ch').length===4`), await texts(c, '.imp-ch', '.imp-t'));
  ok('…the broken word is whole again', /the village woke slowly/.test(await ev(c, `return document.querySelectorAll('.imp-ch')[1].textContent`)) || /village/.test(await ev(c, `return JSON.stringify([...document.querySelectorAll('.imp-m')].map(e=>e.textContent))`)));
  await click(c, '[data-ai]');
  ok('Find chapters with AI asks Orca, streaming', await waitFor(c, `/found/.test(document.querySelector('.imp-run')?.textContent||'')`, 15000), await ev(c, `return document.querySelector('.imp-run')?.textContent`));
  ok('…3 found, 1 moved to its real first words, 1 left out', /3 found, 1 moved .* 1 left out/.test(await ev(c, `return document.querySelector('.imp-run .stat').textContent`)), await ev(c, `return document.querySelector('.imp-run .stat').textContent`));
  ok('…the ask was the numbered paragraphs', S.chats.length === 1 && /2 \[H2\] \| Chapter 1: Morning/.test(S.chats[0].body) && /\\"anchor\\"/.test(S.chats[0].body), S.chats.length + ' ' + (S.chats[0] && S.chats[0].body.slice(0, 900)));
  ok('the parts: the opening pages, then the AI\'s three, titles and author from it', (await texts(c, '.imp-ch', '.imp-t')) === 'Opening pages|Morning|Noon|Night' && (await ev(c, `return document.querySelector('#imp-title').value+'/'+document.querySelector('#imp-author').value`)) === 'The Little Book of Days/A. Writer', await texts(c, '.imp-ch', '.imp-t'));
  await click(c, '[data-split]', 1);
  ok('Split lists where a new part can start', await waitFor(c, `document.querySelectorAll('.imp-split [data-at]').length===1`));
  await click(c, '.imp-split [data-at]');
  ok('…and splits there', await waitFor(c, `document.querySelectorAll('.imp-ch').length===5`) && (await texts(c, '.imp-ch', '.imp-t')) === 'Opening pages|Morning|Untitled part|Noon|Night', await texts(c, '.imp-ch', '.imp-t'));
  await click(c, '[data-merge]', 1);
  ok('Merge puts it back together', await waitFor(c, `document.querySelectorAll('.imp-ch').length===4`) && (await texts(c, '.imp-ch', '.imp-t')) === 'Opening pages|Morning|Noon|Night');
  await mouseDrag(c, '.imp-ch', 3, 2, { edge: 0.02 });
  ok('a mouse drags Night above Noon', (await texts(c, '.imp-ch', '.imp-t')) === 'Opening pages|Morning|Night|Noon', await texts(c, '.imp-ch', '.imp-t'));
  await altKey(c, '.imp-ch', 2, 'ArrowDown');
  ok('Alt + ↓ on a focused part moves it down, and it keeps the focus', (await texts(c, '.imp-ch', '.imp-t')) === 'Opening pages|Morning|Noon|Night' && (await ev(c, `return document.activeElement?.closest('.imp-ch')?.querySelector('.imp-t').value`)) === 'Night', await texts(c, '.imp-ch', '.imp-t'));
  await click(c, '[data-skip]', 0);
  ok('Leave out: the opening pages are struck through and not counted', await waitFor(c, `document.querySelectorAll('.imp-ch.skip').length===1 && /Save 3 chapters/.test(document.querySelector('[data-save]').textContent)`));
  await click(c, '[data-tidy]');
  ok('Tidy with AI: the reworded paragraph is refused', await waitFor(c, `[...document.querySelectorAll('.imp-run')].some(e=>/1 change refused/.test(e.textContent))`, 15000), await ev(c, `return [...document.querySelectorAll('.imp-run')].map(e=>e.textContent).join(' / ')`));
  ok('…and the text still says "loud"', /loud with voices/.test(await ev(c, `return [...document.querySelectorAll('.imp-m')].map(e=>e.textContent).join(' ')`)));
  await ev(c, `const i=document.querySelectorAll('.imp-t')[1]; i.value='The Morning'; i.dispatchEvent(new Event('input')); return 1`);
  await shot(c, 'import-review-tony-1280');
  await click(c, '[data-save]');
  ok('Save to Mine: the book opens', await waitFor(c, `/#\\/b\\/u[a-z0-9]+$/.test(location.hash) && document.querySelectorAll('.chs .ch').length===3`, 15000), await ev(c, `return location.hash+' '+document.querySelector('#imp-body')?.textContent.slice(0,200)`));
  const mineId = await ev(c, `return location.hash.split('/')[2]`);
  ok('…its parts, renamed and in the dragged order', (await texts(c, '.chs .ch .t')) === 'The Morning|Noon|Night', await texts(c, '.chs .ch .t'));
  ok('…in Tony\'s doc, each chapter\'s text beside it', await waitFor(c, `const d=JSON.parse(sessionStorage.getItem('__fakefs_docs')||'{}'); return !!(d['dashboards/shruti']?.books?.['${mineId}']) && !!d['dashboards/shruti/texts/${mineId}_ch01'] && !d['dashboards/shruti_shared']?.books?.['${mineId}']`));
  ok('the book page says where it came from, with Rename and Delete', /Only yours · imported from pasted text/.test(await ev(c, `return document.querySelector('.bk-src')?.textContent`)) && !!(await ev(c, `return !!document.querySelector('[data-rename]') && !!document.querySelector('[data-delete]')`)));
  await shot(c, 'import-book-tony-1280');
  await ev(c, `location.hash='#/b/${mineId}/1'; return 1`);
  ok('Read shows the chapter\'s exact text', await waitFor(c, `/The sun came up over the hills, and the village woke slowly\\. Birds sang in the old fig tree by the well\\./.test(document.querySelector('article.rd')?.textContent||'')`));
  ok('…titled as saved, with its word count', /The Morning/.test(await ev(c, `return document.querySelector('.cp-head h1').textContent`)) && /words/.test(await ev(c, `return document.querySelector('.cp-head .m').textContent`)));
  await ev(c, `location.hash='#/b/${mineId}/1/lessons'; return 1`);
  await waitFor(c, `location.hash.endsWith('/lessons') && !!document.querySelector('#make-ai')`);
  await sleep(500);
  await click(c, '#make-ai');
  await waitFor(c, `/Draw the lessons/.test(document.querySelector('#gen-sheet h2')?.textContent||'') && !!document.querySelector('#gen-run [data-make]')`);
  await ev(c, `document.querySelector('#gen-run [data-make]').click(); return 1`);
  ok('Make with AI works on it: lessons drawn, kept in Tony\'s own doc', await waitFor(c, `!!window.Shruti.core.me.get('assets.${mineId}.ch1.lessons',null) && !window.Shruti.core.shared.get('assets.${mineId}',null)`, 15000), await ev(c, `return document.querySelector('#gen-run')?.textContent.slice(0,300)`));
  ok('…the ask carried the chapter\'s own text and its title', /The sun came up over the hills/.test(S.chats[S.chats.length - 1].body) && /The Little Book of Days/.test(S.chats[S.chats.length - 1].body));
  await ev(c, `document.querySelector('#gen-sheet [data-close]').click(); return 1`);

  console.log('\nA Word file, an EPUB and a PDF, made in the page');
  await ev(c, `location.hash='#/'; return 1`);
  await waitFor(c, `!!document.querySelector('#shelf-mine')`);
  const docx = await ev(c, imp(`await new Promise((r,j)=>{ if(window.JSZip) return r(); const s=document.createElement('script'); s.src=IMP.JSZIP_URL; s.onload=r; s.onerror=j; document.head.appendChild(s); });
    const z=new JSZip();
    z.file('word/document.xml','<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Field Notes</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Spring</w:t></w:r></w:p><w:p><w:r><w:t>Buds on every branch.</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Summer</w:t></w:r></w:p><w:p><w:r><w:t>Long light &amp; warm stone.</w:t></w:r></w:p></w:body></w:document>');
    z.file('docProps/core.xml','<cp:coreProperties><dc:title>Field Notes</dc:title><dc:creator>Veda</dc:creator></cp:coreProperties>');
    const blob=await z.generateAsync({type:'blob'});
    const r=await IMP.readFile(new File([blob],'field-notes.docx'));
    return JSON.stringify({title:r.title, author:r.author, paras:r.paras.map(p=>[p.h,p.t])});`));
  ok('a Word file reads: title, author, its headings and text', docx === JSON.stringify({ title: 'Field Notes', author: 'Veda', paras: [[1, 'Field Notes'], [1, 'Spring'], [0, 'Buds on every branch.'], [1, 'Summer'], [0, 'Long light & warm stone.']] }), docx);
  const epub = await ev(c, imp(`const z=new JSZip();
    const x=(b)=>'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title></head><body>'+b+'</body></html>';
    z.file('mimetype','application/epub+zip');
    z.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>');
    z.file('OPS/book.opf','<package><metadata><dc:title>River Tales</dc:title><dc:creator>A. Teller</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>');
    z.file('OPS/nav.xhtml', x('<nav epub:type="toc"><ol><li><a href="a.xhtml">The Source</a></li><li><a href="b.xhtml">The Sea</a></li></ol></nav>'));
    z.file('OPS/a.xhtml', x('<h1>The Source</h1><p>A spring in the mountains.</p>'));
    z.file('OPS/b.xhtml', x('<h1>The Sea</h1><p>Where every river ends.</p>'));
    const blob=await z.generateAsync({type:'blob'});
    const h=IMP.open({go:window.Shruti.go}); await h.take(new File([blob],'river.epub',{type:'application/epub+zip'}));
    return JSON.stringify({title:h.state.title, chs:h.state.chs.map(c=>c.title), how:h.state.how});`));
  ok('an EPUB opens in the review with its own contents', epub === JSON.stringify({ title: 'River Tales', chs: ['The Source', 'The Sea'], how: 'the file’s own contents' }), epub);
  ok('…drawn in the sheet', await waitFor(c, `(()=>{const t=[...document.querySelectorAll('.imp-ch .imp-t')].map(i=>i.value).join('|'); return t==='The Source|The Sea' && /2 chapters/.test(document.querySelector('#imp-body .card:nth-of-type(2) h3').textContent);})()`), await texts(c, '.imp-ch', '.imp-t'));
  await ev(c, `document.querySelector('#imp-sheet').remove(); return 1`);
  const pdfRes = await ev(c, imp(`await new Promise((r,j)=>{ if(window.jspdf) return r(); const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'; s.onload=r; s.onerror=j; document.head.appendChild(s); });
    const d=new jspdf.jsPDF({unit:'pt', format:'letter'});
    const page=(n, head, lines)=>{ if(n>1) d.addPage(); d.setFontSize(8); d.text('RIVER BOOK', 250, 40); if(head){ d.setFontSize(22); d.text(head, 72, 100); } d.setFontSize(11); lines.forEach((l,i)=>d.text(l, 72, 150+i*15)); d.setFontSize(8); d.text(String(n), 300, 760); };
    page(1, 'Chapter One', ['The river starts high in the hills where the snow', 'melts in spring and runs down through the pines.', '', 'It carries stones and leaves and the songs of the']);
    page(2, null, ['birds, and it does not stop for anyone.']);
    page(3, 'Chapter Two', ['At the sea the river slows, spreads, and is gone.']);
    page(4, null, ['That is the whole of it.']);
    const blob=d.output('blob');
    const h=IMP.open({go:window.Shruti.go}); await h.take(new File([blob],'river-book.pdf',{type:'application/pdf'}));
    return JSON.stringify({chs:h.state.chs.map(c=>c.title), words:h.state.paras.map(p=>p.t).join(' '), heads:h.state.paras.filter(p=>p.h).map(p=>p.t)});`));
  const pr = JSON.parse(pdfRes || '{}');
  ok('a PDF reads through A1\'s pdf.js: two chapters at its big headings', JSON.stringify(pr.chs) === JSON.stringify(['Chapter One', 'Chapter Two']) && JSON.stringify(pr.heads) === JSON.stringify(['Chapter One', 'Chapter Two']), pdfRes);
  ok('…running heads and page numbers left out, a sentence carried over the page', pr.words && !/RIVER BOOK/.test(pr.words) && !/ 2 | 3 /.test(' ' + pr.words.replace(/[^\d ]/g, '') + ' ') && /the songs of the birds, and it does not stop for anyone\./.test(pr.words), pdfRes);
  await ev(c, `document.querySelector('[data-where=shared]').click(); return 1`);
  await sleep(200);
  await click(c, '[data-save]');
  ok('Saved to Shared: in the shared doc, for both', await waitFor(c, `/#\\/b\\/u/.test(location.hash) && Object.values(window.Shruti.core.shared.get('books',{})).some(b=>b.title==='river-book' || b.title==='River book')`, 15000), await ev(c, `return JSON.stringify(Object.values(window.Shruti.core.shared.get('books',{})).map(b=>b.title))`));
  const sharedId = await ev(c, `return location.hash.split('/')[2]`);
  ok('…its book page says Shared with Veda', /Shared with Veda · imported from river-book\.pdf/.test(await ev(c, `return document.querySelector('.bk-src')?.textContent`)));
  await click(c, '[data-rename]');
  await waitFor(c, `!!document.querySelector('#rn-title')`);   // Import's code loads on first use
  await ev(c, `const t=document.querySelector('#rn-title'); t.value='The River Book'; return 1`);
  await click(c, '#imp-rename [data-r="1"]');
  ok('Rename', await waitFor(c, `document.querySelector('.bk-head h1').textContent==='The River Book' && window.Shruti.core.shared.get('books.${sharedId}.title')==='The River Book'`));
  await ev(c, `location.hash='#/b/${sharedId}/1'; return 1`);
  ok('a PDF chapter reads with the source\'s paragraphs', await waitFor(c, `/The river starts high in the hills where the snow melts in spring and runs down through the pines\\./.test(document.querySelector('article.rd')?.textContent||'')`));

  console.log('\nThe shelves');
  // A second book of Tony's own, so Mine has two to drag.
  const secondId = await ev(c, imp(`const B = await import(new URL('books.js', location.href).href); const X = await import(new URL('extract.js', location.href).href);
    const id=X.newBookId(); await B.save('mine', {id, title:'Second Book', author:'', unit:'Chapter', chapters:[{n:1,title:'Only',file:'ch01',words:2}], words:2, src:{name:'x.txt',kind:'text'}}, [X.toChapter(1,'Only',[{t:'Just this.',h:0}])]); return id;`));
  await ev(c, `location.hash='#/'; return 1`);
  ok('the library: the Gita and the River Book on Shared, Tony\'s two on Mine', await waitFor(c, `document.querySelectorAll('#shelf-shared .book').length===2 && document.querySelectorAll('#shelf-mine .book').length===2`), await keysOf(c, '#shelf-mine .book'));
  const mine0 = await keysOf(c, '#shelf-mine .book');
  await mouseDrag(c, '#shelf-mine .book', 1, 0, { edge: 0.5 });
  const mine1 = await keysOf(c, '#shelf-mine .book');
  ok('Mine drags, and the order is Tony\'s (shelf.mine)', mine1 === mine0.split('|').reverse().join('|') && (await ev(c, `return (window.Shruti.core.me.get('shelf.mine',[])||[]).join('|')`)) === mine1, mine0 + ' -> ' + mine1);
  await mouseDrag(c, '#shelf-shared .book', 1, 0, { edge: 0.5 });
  ok('Shared drags too (shelf.order)', (await keysOf(c, '#shelf-shared .book')).startsWith(sharedId) && (await ev(c, `return (window.Shruti.core.me.get('shelf.order',[])||[])[0]`)) === sharedId);
  await altKey(c, '#shelf-shared .book', 0, 'ArrowRight');
  ok('Alt + → on a book moves it back', (await keysOf(c, '#shelf-shared .book')).startsWith('gita'));
  ok('a drop is not a click: still on the library', await ev(c, `return location.hash==='#/' || location.hash===''`));
  await shot(c, 'import-shelves-tony-1280');

  console.log('\nBookmarks');
  await ev(c, `window.Shruti.core.me.set({'bookmarks.gita.ch2.b3':{label:'Verse 2.11',at:1},'bookmarks.gita.ch4.b5':{label:'Verse 4.7',at:2},'bookmarks.gita.ch6.b2':{label:'Verse 6.5',at:3}},{now:true}); location.hash='#/b/gita'; return 1`);
  ok('three bookmarks in book order', await waitFor(c, `[...document.querySelectorAll('.bmk b')].map(b=>b.textContent).join('|')==='Verse 2.11|Verse 4.7|Verse 6.5'`));
  await mouseDrag(c, '.bmk', 2, 0, { edge: 0.5 });
  ok('a bookmark drags to the front, Tony\'s own order', (await ev(c, `return [...document.querySelectorAll('.bmk b')].map(b=>b.textContent).join('|')`)) === 'Verse 6.5|Verse 2.11|Verse 4.7' && (await ev(c, `return (window.Shruti.core.me.get('order.bmk.gita',[])||[]).join()`)) === 'ch6.b2,ch2.b3,ch4.b5', await ev(c, `return [...document.querySelectorAll('.bmk b')].map(b=>b.textContent).join('|')`));
  ok('…and the drop did not open it', await ev(c, `return location.hash==='#/b/gita'`));

  console.log('\nThe Study tab: sets in a row, the chosen set\'s kinds as tabs');
  await ev(c, `window.Shruti.core.shared.set({'sets.gita.sAI1':{id:'sAI1', kinds:{quiz:[{text:'Q one?',options:{A:'a',B:'b',C:'c',D:'d'},correct:'A',why:'w'}]}, scope:{t:'chapter',ch:[4],label:'chapter 4 by AI'}, model:'deepseek/free', by:'tony', at:Date.now()}},{now:true}); location.hash='#/b/gita/4/study'; return 1`);
  ok('two sets: the ready-made first', await waitFor(c, `document.querySelectorAll('.sh-set').length===2`) && (await keysOf(c, '.sh-set')) === 'ch4|sAI1');
  await mouseDrag(c, '.sh-set', 1, 0, { edge: 0.5 });
  ok('a set drags above the other (order.sets.gita)', (await keysOf(c, '.sh-set')) === 'sAI1|ch4' && (await ev(c, `return (window.Shruti.core.me.get('order.sets.gita',[])||[]).join()`)) === 'sAI1,ch4', await keysOf(c, '.sh-set'));
  await ev(c, `document.querySelector('.sh-set[data-dkey=ch4]').click(); return 1`);
  ok('picking a set shows its kinds as tabs', await waitFor(c, `document.querySelector('.sh-set.on')?.dataset.dkey==='ch4' && document.querySelectorAll('.sh-kinds[data-dkey=ch4] .sh-kind').length===4`));
  const kinds0 = await ev(c, `return [...document.querySelectorAll('.sh-kinds[data-dkey=ch4] .sh-kind')].map(e=>e.dataset.kind).join()`);
  await mouseDrag(c, '.sh-kinds[data-dkey=ch4] .sh-kind', 3, 0, { edge: 0.5 });
  ok('the kinds in a set drag too (order.kinds.gita.ch4)', (await ev(c, `return [...document.querySelectorAll('.sh-kinds[data-dkey=ch4] .sh-kind')].map(e=>e.dataset.kind).join()`)) === 'slides,flashcards,quiz,mindmap' && (await ev(c, `return (window.Shruti.core.me.get('order.kinds.gita.ch4',[])||[]).join()`)) === 'slides,flashcards,quiz,mindmap', kinds0 + ' -> ' + await ev(c, `return [...document.querySelectorAll('.sh-kinds[data-dkey=ch4] .sh-kind')].map(e=>e.dataset.kind).join()`));
  await ev(c, `window.Shruti.core.shared.set({'sets.gita.sAI1': window.Shruti.core.DELETE},{now:true}); return 1`);

  console.log('\nFlashcards');
  await ev(c, `location.hash='#/b/gita/4'; return 1`);
  await sleep(300);
  await ev(c, `location.hash='#/b/gita/4/study'; return 1`);
  await waitFor(c, `!!document.querySelector('.sh-kind[data-set=ch4][data-kind=flashcards]')`);
  await ev(c, `document.querySelector('.sh-kind[data-set=ch4][data-kind=flashcards]').click(); return 1`);
  await waitFor(c, `!!document.querySelector('.fc-stage')`);
  await ev(c, `[...document.querySelectorAll('.st-actions .btn')].find(b=>/All cards/.test(b.title)).click(); return 1`);
  await waitFor(c, `document.querySelectorAll('.fc-grid .fc-card').length===${set4.flashcards.length}`);
  await mouseDrag(c, '.fc-grid .fc-card', 2, 0, { edge: 0.5 });
  ok('a card drags to the front of the grid', /^/.test('') && (await ev(c, `return document.querySelector('.fc-grid .fc-card .fc-front .fc-text').textContent`)) === set4.flashcards[2].front, await ev(c, `return document.querySelector('.fc-grid .fc-card .fc-front .fc-text').textContent`));
  ok('…the order is Tony\'s (order.items.gita.ch4.flashcards)', (await ev(c, `return (window.Shruti.core.me.get('order.items.gita.ch4.flashcards',[])||[]).length`)) === set4.flashcards.length);
  await ev(c, `[...document.querySelectorAll('.st-actions .btn')].find(b=>/One card/.test(b.title)).click(); return 1`);
  ok('…and the deck now starts with it', await waitFor(c, `document.querySelector('.fc-stage .fc-front .fc-text').textContent===${JSON.stringify(set4.flashcards[2].front)}`));

  console.log('\nQuiz');
  await ev(c, `document.querySelector('.sh-kind[data-set=ch4][data-kind=quiz]').click(); return 1`);
  await waitFor(c, `!!document.querySelector('.qz-opt')`);
  await ev(c, `document.querySelector('.qz-opt').click(); return 1`);   // answer question 1
  const q0pick = await ev(c, `return JSON.stringify(window.Shruti.core.me.get('study.gita.ch4.quiz.picked',{}))`);
  await ev(c, `[...document.querySelectorAll('.st-actions .btn')].find(b=>/All questions/.test(b.title)).click(); return 1`);
  ok('All questions lists every one', await waitFor(c, `document.querySelectorAll('.qz-li').length===${set4.quiz.length}`));
  await mouseDrag(c, '.qz-li', 0, 2, { edge: 0.5 });
  ok('a question drags down the list', (await ev(c, `return document.querySelectorAll('.qz-li .qz-li-q')[2].textContent`)) === set4.quiz[0].text.replace(/\*\*/g, ''), await ev(c, `return [...document.querySelectorAll('.qz-li .qz-li-q')].slice(0,3).map(e=>e.textContent).join(' | ')`));
  ok('…its answer moved with it (kept by its place in the set)', (await ev(c, `return JSON.stringify(window.Shruti.core.me.get('study.gita.ch4.quiz.picked',{}))`)) === q0pick && (await ev(c, `return document.querySelectorAll('.qz-li')[2].classList.contains('ok')||document.querySelectorAll('.qz-li')[2].classList.contains('bad')`)));
  await altKey(c, '.qz-li', 2, 'ArrowUp');
  ok('Alt + ↑ moves it back up one', (await ev(c, `return document.querySelectorAll('.qz-li .qz-li-q')[1].textContent`)) === set4.quiz[0].text.replace(/\*\*/g, ''));
  await shot(c, 'import-quiz-list-tony-1280');
  await click(c, '.qz-li', 1);
  ok('tapping one opens it: question 2 is the moved one, answered', await waitFor(c, `/Question 2 of/.test(document.querySelector('.qz-kicker')?.textContent||'') && document.querySelectorAll('.qz-opt[disabled]').length===4`));

  console.log('\nSlides');
  await ev(c, `document.querySelector('.sh-kind[data-set=ch4][data-kind=slides]').click(); return 1`);
  await waitFor(c, `document.querySelectorAll('.sd-strip .sd-thumb').length===${set4.slides.length}`);
  await mouseDrag(c, '.sd-strip .sd-thumb', 1, 3, { edge: 0.5 });
  ok('the filmstrip drags sideways', (await ev(c, `return document.querySelectorAll('.sd-strip .sd-thumb')[3].querySelector('.sd-title').textContent`)) === set4.slides[1].title.replace(/\*\*/g, ''), await ev(c, `return [...document.querySelectorAll('.sd-strip .sd-title')].slice(0,4).map(e=>e.textContent).join(' | ')`));
  await ev(c, `[...document.querySelectorAll('.st-actions .btn')].find(b=>/All slides/.test(b.title)).click(); return 1`);
  await waitFor(c, `document.querySelectorAll('.sd-grid .sd-thumb').length===${set4.slides.length}`);
  await mouseDrag(c, '.sd-grid .sd-thumb', 3, 0, { edge: 0.5 });
  ok('the grid drags too; the order is Tony\'s', (await ev(c, `return document.querySelector('.sd-grid .sd-thumb .sd-title').textContent`)) === set4.slides[1].title.replace(/\*\*/g, '') && (await ev(c, `return (window.Shruti.core.me.get('order.items.gita.ch4.slides',[])||[]).length`)) === set4.slides.length);

  console.log('\nMind map');
  await ev(c, `document.querySelector('.sh-kind[data-set=ch4][data-kind=mindmap]').click(); return 1`);
  await waitFor(c, `!!document.querySelector('.mm-branch')`);
  await ev(c, `[...document.querySelectorAll('.st-actions .btn')].find(b=>/Arrange/.test(b.title)).click(); return 1`);
  ok('Arrange shows the map as an outline', await waitFor(c, `document.querySelectorAll('.mm-ob').length===${set4.mindmap.branches.length}`));
  await mouseDrag(c, '.mm-ob-h', 2, 0, { edge: 0.5 });
  ok('a branch drags to the top', (await ev(c, `return document.querySelector('.mm-ob .mm-ob-h span').textContent`)) === set4.mindmap.branches[2].text, await ev(c, `return [...document.querySelectorAll('.mm-ob-h span')].map(e=>e.textContent).join(' | ')`));
  const kidsSel = '.mm-ob:first-child .mm-oc';
  const k0 = await ev(c, `return [...document.querySelectorAll('${kidsSel}')].map(e=>e.textContent).join('|')`);
  await mouseDrag(c, kidsSel, 1, 0, { edge: 0.5 });
  const k1 = await ev(c, `return [...document.querySelectorAll('${kidsSel}')].map(e=>e.textContent).join('|')`);
  ok('a point drags within its branch', k1.split('|')[0] === k0.split('|')[1] && k1.split('|').length === k0.split('|').length, k0 + ' -> ' + k1);
  await ev(c, `[...document.querySelectorAll('.st-actions .btn')].find(b=>/Done/.test(b.textContent)).click(); return 1`);
  ok('Done: the map follows the new order', await waitFor(c, `document.querySelector('.mm-col[data-bi="0"] .mm-branch span')?.textContent===${JSON.stringify(set4.mindmap.branches[2].text)} && document.querySelector('.mm-col[data-bi="0"] .mm-leaf')?.textContent===${JSON.stringify(k0.split('|')[1])}`));
  await ev(c, `document.querySelectorAll('.mm-branch')[0].click(); return 1`);
  ok('a fold is kept by its branch, not its place', await waitFor(c, `(window.Shruti.core.me.get('study.gita.ch4.mindmap.closedK',[])||[]).length===1 && document.querySelectorAll('.mm-col')[0].classList.contains('closed')`));
  await shot(c, 'import-mindmap-tony-1280');

  console.log('\nVersions in Make with AI');
  await ev(c, `const S=window.Shruti.core.shared; S.set({'versions.gita.ch4.lessons.v1':{id:'v1',model:'deepseek/free',lessons:[{id:'L1',title:'a'}],at:1000,by:'tony'},'versions.gita.ch4.lessons.v2':{id:'v2',model:'chatgpt/free',lessons:[{id:'L1',title:'b'}],at:2000,by:'tony'}},{now:true}); location.hash='#/b/gita/4/lessons'; return 1`);
  await waitFor(c, `!!document.querySelector('#make-ai')`);
  await click(c, '#make-ai');
  ok('three versions: your notes, then newest first', await waitFor(c, `[...document.querySelectorAll('.gv')].map(e=>e.dataset.dkey).join()==='orig,v2,v1'`), await keysOf(c, '.gv'));
  await mouseDrag(c, '.gv', 2, 0, { edge: 0.5 });
  ok('a version drags to the top (order.ver.gita.ch4.lessons)', (await keysOf(c, '.gv')) === 'v1|orig|v2' && (await ev(c, `return (window.Shruti.core.me.get('order.ver.gita.ch4.lessons',[])||[]).join()`)) === 'v1,orig,v2', await keysOf(c, '.gv'));
  ok('…and the drop did not feature it', await ev(c, `return !window.Shruti.core.shared.get('assets.gita.ch4.lessons',null)`));
  await ev(c, `document.querySelector('.gv[data-dkey=v2] .gv-pick').click(); return 1`);
  ok('a click still features one', await waitFor(c, `window.Shruti.core.shared.get('assets.gita.ch4.lessons',null)?.id==='v2'`));
  await ev(c, `document.querySelector('#gen-sheet [data-close]').click(); return 1`);

  console.log('\nDelete');
  await ev(c, `location.hash='#/b/${secondId}'; return 1`);
  await waitFor(c, `!!document.querySelector('[data-delete]')`);
  await click(c, '[data-delete]');
  await waitFor(c, `!!document.querySelector('.sheet-dim [data-r="1"]')`);
  await ev(c, `document.querySelector('.sheet-dim [data-r="1"]').click(); return 1`);
  ok('Delete: gone from the doc and its texts, back to the library', await waitFor(c, `!window.Shruti.core.me.get('books.${secondId}',null) && (location.hash==='#/'||location.hash==='') && !JSON.parse(sessionStorage.getItem('__fakefs_docs')||'{}')['dashboards/shruti/texts/${secondId}_ch01']`, 10000));
  ok('no page errors for Tony', !(await errs(c)), await errs(c));

  console.log('\nVeda at 390');
  await sleep(1500);
  RUN = String(Date.now());
  const docs = await ev(c, `return sessionStorage.getItem('__fakefs_docs')`);
  await load(c, { w: 390, h: 844, mobile: true, store: "sessionStorage.setItem('__fakefs_docs'," + JSON.stringify(docs) + "); sessionStorage.setItem('shruti.pick','veda');", hash: '#/' });
  await waitFor(c, `!!window.Shruti && window.Shruti.core.me.loaded && window.Shruti.core.shared.loaded`, 15000);
  ok('it is Veda\'s side', await waitFor(c, `document.body.dataset.profile==='veda'`));
  ok('she sees the shared River Book, in her own order (the Gita first)', await waitFor(c, `[...document.querySelectorAll('#shelf-shared .book')].map(b=>b.dataset.dkey).join('|')==='gita|${sharedId}'`), await keysOf(c, '#shelf-shared .book'));
  ok('Tony\'s own book is not on her shelves', !(await ev(c, `return !!document.querySelector('[data-dkey="${mineId}"]')`)) && /Import a book/.test(await ev(c, `return document.querySelector('#shelf-mine .shelf-add')?.textContent||''`)));
  ok('nothing wider than the phone', await waitFor(c, `document.documentElement.scrollWidth<=innerWidth`));
  await shot(c, 'import-library-veda-390');
  await touchDrag(c, '#shelf-shared .book', 1, 0);
  ok('a held finger drags a book (her shelf.order, not Tony\'s)', (await keysOf(c, '#shelf-shared .book')) === sharedId + '|gita' && (await ev(c, `return (window.Shruti.core.me.get('shelf.order',[])||[]).join('|')`)) === sharedId + '|gita', await keysOf(c, '#shelf-shared .book'));
  ok('…and did not open it', await ev(c, `return location.hash==='#/' || location.hash===''`));
  await ev(c, `location.hash='#/b/${sharedId}'; return 1`);
  ok('she can read it: the book page says Shared with Tony', await waitFor(c, `/Shared with Tony/.test(document.querySelector('.bk-src')?.textContent||'') && document.querySelectorAll('.chs .ch').length===2`));
  await shot(c, 'import-book-veda-390');
  await ev(c, `location.hash='#/b/${sharedId}/2'; return 1`);
  ok('…and its chapters', await waitFor(c, `/At the sea the river slows, spreads, and is gone\\./.test(document.querySelector('article.rd')?.textContent||'')`));
  await ev(c, `location.hash='#/b/gita/4/study'; return 1`);
  await waitFor(c, `!!document.querySelector('.sh-kind[data-set=ch4]')`);
  ok('her kinds are in the set\'s own order (Tony\'s order is his)', (await ev(c, `return [...document.querySelectorAll('.sh-kinds[data-dkey=ch4] .sh-kind')].map(e=>e.dataset.kind).join()`)) === 'flashcards,quiz,mindmap,slides');
  await ev(c, `document.querySelector('.sh-kind[data-set=ch4][data-kind=quiz]').click(); return 1`);
  await waitFor(c, `!!document.querySelector('.qz-opt')`);
  await ev(c, `[...document.querySelectorAll('.st-actions .btn')].find(b=>/All questions/.test(b.title)).click(); return 1`);
  ok('her questions are in the set\'s order', await waitFor(c, `document.querySelector('.qz-li .qz-li-q')?.textContent===${JSON.stringify(set4.quiz[0].text.replace(/\*\*/g, ''))}`));
  await touchDrag(c, '.qz-li', 0, 1);
  ok('a held finger drags a question', (await ev(c, `return document.querySelectorAll('.qz-li .qz-li-q')[1].textContent`)) === set4.quiz[0].text.replace(/\*\*/g, ''), await ev(c, `return [...document.querySelectorAll('.qz-li .qz-li-q')].slice(0,2).map(e=>e.textContent).join(' | ')`));
  await shot(c, 'import-quiz-list-veda-390');
  await ev(c, `location.hash='#/'; return 1`);
  await waitFor(c, `!!document.querySelector('#shelf-mine .shelf-add')`);
  await click(c, '#shelf-mine .shelf-add');
  await waitFor(c, `!!document.querySelector('#imp-paste')`);
  await ev(c, `const t=document.querySelector('#imp-paste'); t.value=${JSON.stringify(BOOK)}; return 1`);
  await click(c, '#imp-use');
  await waitFor(c, `document.querySelectorAll('.imp-ch').length===4`);
  ok('the review fits the phone', await waitFor(c, `document.documentElement.scrollWidth<=innerWidth && document.querySelector('#imp-sheet .sheet').getBoundingClientRect().right<=innerWidth+1`));
  await touchDrag(c, '.imp-ch', 3, 2, { edge: 0.03 });
  ok('a held finger drags a part on the review screen', (await texts(c, '.imp-ch', '.imp-t')).split('|')[2] === 'Chapter 3: Night', await texts(c, '.imp-ch', '.imp-t'));
  await shot(c, 'import-review-veda-390');
  ok('no page errors for Veda', !(await errs(c)), await errs(c));

  console.log('\nTony at 390 and Veda at 1280');
  RUN = String(Date.now());
  const docs2 = await ev(c, `return sessionStorage.getItem('__fakefs_docs')`);
  await load(c, { w: 390, h: 844, mobile: true, store: "sessionStorage.setItem('__fakefs_docs'," + JSON.stringify(docs2) + "); sessionStorage.setItem('shruti.pick','tony');", hash: '#/' });
  await waitFor(c, `!!window.Shruti && window.Shruti.core.me.loaded && !!document.querySelector('#shelf-mine')`, 15000);
  ok('Tony\'s shelves on his phone: his order followed him', (await keysOf(c, '#shelf-shared .book')) === 'gita|' + sharedId && (await ev(c, `return document.documentElement.scrollWidth<=innerWidth`)));
  await shot(c, 'import-library-tony-390');
  RUN = String(Date.now());
  await load(c, { w: 1280, h: 900, mobile: false, store: "sessionStorage.setItem('__fakefs_docs'," + JSON.stringify(docs2) + "); sessionStorage.setItem('shruti.pick','veda');", hash: '#/b/' + sharedId });
  await waitFor(c, `!!window.Shruti && window.Shruti.core.me.loaded && !!document.querySelector('.bk-head')`, 15000);
  await shot(c, 'import-book-veda-1280');
  ok('no page errors', !(await errs(c)), await errs(c));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
