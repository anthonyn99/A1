// LIVE test: Shruti's Refinements 2 (Tony, 2026-10-22) in real headless Edge,
// for both profiles at 1280 and 390. Not run by npm test.
//
//   node Shruti/tests/refine2.live.js
//
// 1 the Lessons popup (open, arrows, keys, swipe, the verse and its link);
// 2 voice previews (a pair, a narrator, any two voices, Build everything);
// 3 a flashcard mark taken back; 4 no hover filter on mind map nodes;
// 5 Watch's lessons fold; 6 the small Import tile; 7 the lighter picker title;
// 8 text dropped on the library imports to the nearer shelf; 9 Listen and
// Watch tools (the speed pill, skip, the bar); 10 Study's rows and Focus.
'use strict';
const path = require('path');
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'cdp.js'));
const { firebaseMock } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'fake-firebase.js'));
const ev = (c, x) => evalJs(c, /^\s*return\b/.test(x) && x.indexOf(';') < 0 ? x + ';' : x);

const URL = 'https://anthonyn99.github.io/A1/Shruti/shruti.html';
const mock = firebaseMock({
  patterns: ['https://orca.vedapatel05.workers.dev/*', 'https://shruti-drive.av1-2.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    if (req.url.includes('/v1/models')) return { json: { object: 'list', data: [] } };
    if (req.url.includes('/health')) return { json: { ok: true, configured: true, connected: true } };
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
  await sleep(500);
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const data = r && (r.result ? r.result.data : r.data);
  if (data) fs.writeFileSync(shotPath('shruti-r2-' + name), Buffer.from(data, 'base64'));
};
async function pt(c, sel) {
  const at = JSON.parse(await ev(c, `const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'null'; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});`));
  if (!at) throw new Error('no ' + sel);
  return at;
}
async function click(c, sel) {
  const at = await pt(c, sel);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await sleep(250);
}
async function key(c, k, code) {
  for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code });
  await sleep(250);
}
let RUN = String(Date.now()), inj = null;
async function load(c, { w, h, who, hash = '' }) {
  const mobile = w < 700;
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h || 860, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  if (inj) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });
  inj = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{ if(window.top!==window) return;
    try{ if(sessionStorage.getItem('__run')!=='${RUN}'){ localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__run','${RUN}'); } sessionStorage.setItem('shruti.pick','${who}'); }catch(e){}
    window.__errs=[]; addEventListener('error', e=>window.__errs.push(String(e.message)));
    addEventListener('unhandledrejection', e=>window.__errs.push('rejection: '+String(e.reason && e.reason.message || e.reason))); })();` });
  await c.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await c.send('Page.navigate', { url: URL + hash });
  await waitFor(c, `!!window.Shruti && window.Shruti.core.me.loaded && !!document.querySelector('#view > *')`, 15000);
  await sleep(500);
}
const go = async (c, hash, cond) => { await ev(c, `location.hash=${JSON.stringify(hash)}; return 1`); return waitFor(c, cond); };
const noOverflow = (c) => ev(c, `return document.documentElement.scrollWidth<=innerWidth`);

async function pass1(c, who, w) {
  const tag = who + ' ' + w;
  const phone = w < 700;
  console.log('\n── ' + tag);
  RUN = String(Date.now());
  await load(c, { w, h: phone ? 844 : 860, who, hash: '#/' });

  // 7 + 6: the library.
  ok(tag + ': the picker title is lighter (500)', await ev(c, `return getComputedStyle(document.querySelector('#picker h1')).fontWeight`) === '500');
  ok(tag + ': the Import tile is much smaller than a book', await waitFor(c, `const a=document.querySelector('#shelf-shared .sa-cover').getBoundingClientRect(), b=document.querySelector('#shelf-shared .book .cover').getBoundingClientRect(); return a.height < b.height*0.55 && a.width < b.width*0.8`),
    await ev(c, `const a=document.querySelector('#shelf-shared .sa-cover').getBoundingClientRect(), b=document.querySelector('#shelf-shared .book .cover').getBoundingClientRect(); return a.width+'x'+a.height+' vs '+b.width+'x'+b.height`));
  ok(tag + ': an empty Mine shelf has its tile at the top', await ev(c, `const s=document.querySelector('#shelf-mine'), t=s.querySelector('.sa-cover'); return !s.querySelector('.book') ? t.getBoundingClientRect().top - s.getBoundingClientRect().top < 4 : true`));

  // 8: drop text on the library.
  const drop = async (shelf) => ev(c, `const dt=new DataTransfer(); dt.setData('text/plain','# The ${shelf} Book\\n\\nChapter 1\\n\\nThe first page of a short book that was dropped here.\\n\\nChapter 2\\n\\nThe second page, and the end.');
    const r=document.querySelector('#shelf-${shelf}').getBoundingClientRect(), y=r.top+Math.min(40, r.height/2), x=r.left+20;
    dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,clientX:x,clientY:y,bubbles:true,cancelable:true}));
    const lit=document.querySelector('.lib-sec.drop-on')?.dataset.shelf;
    document.querySelector('#view').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,clientX:x,clientY:y,bubbles:true,cancelable:true}));
    return lit;`);
  ok(tag + ': text dragged over Shared lights Shared', await drop('shared') === 'shared');
  ok(tag + ': …and dropped, the import opens at the review, set to Shared', await waitFor(c, `!!document.querySelector('#imp-sheet [data-where="shared"].on') && document.querySelectorAll('#imp-sheet .imp-ch').length>=2`, 8000),
    await ev(c, `return document.querySelector('#imp-body')?.textContent.slice(0,200)`));
  await ev(c, `document.querySelector('#imp-sheet').remove(); return 1`);
  ok(tag + ': text dropped on Mine imports to Mine', await drop('mine') === 'mine' && await waitFor(c, `!!document.querySelector('#imp-sheet [data-where="mine"].on')`, 8000));
  await ev(c, `document.querySelector('#imp-sheet').remove(); return 1`);
  ok(tag + ': the library is no wider than the screen', await noOverflow(c));
  if (who === 'tony' && !phone) await shot(c, 'library-' + w);

  // 1: the Lessons popup.
  ok(tag + ': Lessons lists 12 lessons, each opens', await go(c, '#/b/gita/2/lessons', `document.querySelectorAll('.ls-i[data-li]').length===12`));
  await click(c, '.ls-i[data-li="1"]');
  ok(tag + ': the popup shows lesson 2 of 12 with its meaning, example, try and verse', await waitFor(c, `const x=document.querySelector('#lx'); return x && /Lesson 2 of 12/.test(x.querySelector('.lx-k').textContent) && x.querySelectorAll('.lx-sec.m,.lx-sec.e,.lx-sec.p,.lx-sec.v').length===4 && /verse 2\\.47/i.test(x.querySelector('.lx-sec.v h3').textContent)`),
    await ev(c, `return (document.querySelector('#lx')?.textContent.slice(0,200)||'no popup')+' | '+location.hash+' | '+document.elementFromPoint(innerWidth/2, innerHeight/2)?.className`));
  ok(tag + ': the verse is the book\'s own words', await ev(c, `return /no control or claim over the results/.test(document.querySelector('.lx-sec.v blockquote').textContent)`));
  ok(tag + ': the popup fits the screen', await ev(c, `const r=document.querySelector('.lx').getBoundingClientRect(), n=document.querySelector('.lx-nav').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && n.bottom<=innerHeight+1`));
  if (phone) {
    ok(tag + ': on a phone it is a full sheet', await ev(c, `const r=document.querySelector('.lx').getBoundingClientRect(); return r.width===innerWidth && r.bottom>=innerHeight-1`));
    const box = await pt(c, '.lx-body');
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 120, y: box.y }] });
    for (let i = 1; i <= 8; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 120 - i * 25, y: box.y + 2 }] }); await sleep(16); }
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    ok(tag + ': a swipe left goes to the next lesson', await waitFor(c, `/Lesson 3 of 12/.test(document.querySelector('.lx-k').textContent)`, 3000));
  } else {
    await key(c, 'ArrowRight', 39);
    ok(tag + ': → goes to the next lesson', await waitFor(c, `/Lesson 3 of 12/.test(document.querySelector('.lx-k').textContent)`, 3000));
  }
  await click(c, '.lx-arrow.prev');
  ok(tag + ': the Previous arrow goes back', await waitFor(c, `/Lesson 2 of 12/.test(document.querySelector('.lx-k').textContent)`, 3000));
  await click(c, '.lx-arrow.next');
  ok(tag + ': the Next arrow names and opens the next one', await waitFor(c, `/Lesson 3 of 12/.test(document.querySelector('.lx-k').textContent) && /Duty/.test(document.querySelector('#lx-t').textContent)`, 3000));
  await ev(c, `document.querySelectorAll('.lx-dots i')[11].click(); return 1`);
  ok(tag + ': on the last lesson Next is off', await waitFor(c, `/Lesson 12 of 12/.test(document.querySelector('.lx-k').textContent) && document.querySelector('.lx-arrow.next').disabled && !document.querySelector('.lx-arrow.prev').disabled`, 3000));
  if (who === 'veda' || !phone) await shot(c, 'lesson-' + who + '-' + w);
  await key(c, 'Escape', 27);
  ok(tag + ': Esc closes it', await waitFor(c, `!document.getElementById('lx') && !document.body.classList.contains('lx-open')`, 3000));
  await click(c, '.ls-i[data-li="1"]');
  await waitFor(c, `!!document.querySelector('.lx-read')`);
  await click(c, '.lx-read');
  ok(tag + ': "Read it in the chapter" opens Read at that verse', await waitFor(c, `/^#\\/b\\/gita\\/2\\/read\\/\\d+$/.test(location.hash) && !document.getElementById('lx') && !!document.querySelector('article.rd')`, 8000), await ev(c, `return location.hash`));

  // 9: Listen.
  ok(tag + ': Listen opens with the speeds hidden', await go(c, '#/b/gita/2/listen', `!!document.querySelector('.pcard') && document.querySelector('.tl-speeds').hidden && document.querySelector('[data-speed-pill]').getAttribute('aria-expanded')==='false'`));
  await click(c, '[data-speed-pill]');
  ok(tag + ': the speed pill opens them', await waitFor(c, `!document.querySelector('.tl-speeds').hidden && document.querySelectorAll('.tl-speeds [data-speed]').length===6`, 3000));
  await click(c, '.tl-speeds [data-speed="1.25"]');
  ok(tag + ': a speed picked closes them and shows on the pill', await waitFor(c, `document.querySelector('.tl-speeds').hidden && document.querySelector('[data-speed-pill] span').textContent==='1.25×' && window.Shruti.podcast.prefs().speed===1.25`, 3000));
  await ev(c, `window.Shruti.podcast.setPref('speed',1); return 1`);
  ok(tag + ': Listen\'s lessons fold, closed', await ev(c, `const f=document.querySelector('[data-fold=podLessons]'); return f && f.querySelector('.fold-b').hidden`));
  ok(tag + ': Listen\'s tools are grouped; nothing wider than the screen', await ev(c, `return document.querySelectorAll('.pcard .tl-group .tl-b').length===2 && !!document.querySelector('[data-back]') && !!document.querySelector('[data-fwd]')`) && await noOverflow(c));
  await click(c, '.pod-play');
  ok(tag + ': Play plays from the card', await waitFor(c, `window.Shruti.podcast.state.playing`, 8000));
  await click(c, '[data-fwd]');
  ok(tag + ': +15 moves on 15 seconds, the bar and clock follow', await waitFor(c, `const a=window.Shruti.podcast.state; return document.querySelector('[data-pt]').textContent!=='0:00' && parseFloat(document.querySelector('.pod-track .vid-fill').style.width)>0`, 5000));
  await click(c, '.pod-play');
  await waitFor(c, `!window.Shruti.podcast.state.playing`, 3000);
  if (!phone || who === 'veda') await shot(c, 'listen-' + who + '-' + w);

  // 5 + 9: Watch.
  ok(tag + ': Watch has the speed pill and its lessons folded', await go(c, '#/b/gita/2/watch', `!!document.querySelector('.vid [data-speed-pill]') && document.querySelector('.vid .tl-speeds').hidden && document.querySelector('[data-fold=vidLessons] .fold-b').hidden`));
  await click(c, '[data-fold=vidLessons] .fold-h');
  ok(tag + ': the lessons open, and stay open', await waitFor(c, `!document.querySelector('[data-fold=vidLessons] .fold-b').hidden && document.querySelectorAll('[data-fold=vidLessons] .pl').length===12`, 3000));
  await go(c, '#/b/gita/2', `!!document.querySelector('article.rd')`);
  ok(tag + ': …after leaving and coming back', await go(c, '#/b/gita/2/watch', `document.querySelector('[data-fold=vidLessons]') && !document.querySelector('[data-fold=vidLessons] .fold-b').hidden`));
  await click(c, '[data-fold=vidLessons] .fold-h');
  ok(tag + ': Watch\'s tools: music, captions, export, full screen in one group', await ev(c, `return document.querySelectorAll('.vid-tools .tl-group .tl-b').length===4`) && await noOverflow(c));
  if (!phone || who === 'veda') await shot(c, 'watch-' + who + '-' + w);

  // 10 + 3 + 4: Study.
  ok(tag + ': Study has the sets in a row and the kinds as tabs', await go(c, '#/b/gita/2/study', `document.querySelectorAll('.sh-sets .sh-set').length>=1 && document.querySelectorAll('.sh-kinds .sh-kind').length===4 && getComputedStyle(document.querySelector('.sh-kinds')).flexDirection==='row'`));
  await ev(c, `document.querySelector('.sh-kind[data-kind=flashcards]').click(); return 1`);
  await waitFor(c, `!!document.querySelector('.fc-know')`);
  await click(c, '.fc-know');
  await key(c, 'ArrowLeft', 37);
  ok(tag + ': back on a card marked Got it, the button shows it', await waitFor(c, `document.querySelector('.fc-know').classList.contains('on') && document.querySelector('.fc-know').getAttribute('aria-pressed')==='true'`, 3000));
  const k = await ev(c, `return Object.keys((window.Shruti.core.me.get('study.gita.ch2.flashcards',{})||{}).b||{})[0]||''`);
  await click(c, '.fc-know');
  ok(tag + ': pressed again, the mark is taken back (the card is new again)', await waitFor(c, `!document.querySelector('.fc-know').classList.contains('on') && !((window.Shruti.core.me.get('study.gita.ch2.flashcards',{})||{}).b||{})['${k}']`, 3000), k);
  await click(c, '.fc-learn');
  await key(c, 'ArrowLeft', 37);
  ok(tag + ': Still learning lights the same way', await waitFor(c, `document.querySelector('.fc-learn').classList.contains('on')`, 3000));
  await click(c, '.fc-learn');
  ok(tag + ': …and clears the same way', await waitFor(c, `!document.querySelector('.fc-learn').classList.contains('on')`, 3000));
  await click(c, '[data-focus]');
  ok(tag + ': Focus hides every header', await waitFor(c, `document.body.classList.contains('sh-focusing') && getComputedStyle(document.querySelector('#top')).display==='none' && getComputedStyle(document.querySelector('.cp-head')).display==='none' && getComputedStyle(document.querySelector('.modes')).display==='none' && getComputedStyle(document.querySelector('.sh-kinds')).display==='none'`, 3000));
  ok(tag + ': …the button to come back stays in view', await ev(c, `const r=document.querySelector('[data-focus]').getBoundingClientRect(); return r.top>=0 && r.right<=innerWidth && r.width>=36`));
  if (!phone || who === 'veda') await shot(c, 'focus-' + who + '-' + w);
  await key(c, 'Escape', 27);
  ok(tag + ': Esc brings them back', await waitFor(c, `!document.body.classList.contains('sh-focusing') && getComputedStyle(document.querySelector('#top')).display!=='none'`, 3000));
  await click(c, '[data-focus]');
  await go(c, '#/b/gita/2', `!!document.querySelector('article.rd')`);
  ok(tag + ': leaving Study ends Focus', !(await ev(c, `return document.body.classList.contains('sh-focusing')`)));
  await go(c, '#/b/gita/2/study', `!!document.querySelector('.sh-kinds')`);
  await ev(c, `document.querySelector('.sh-kind[data-kind=mindmap]').click(); return 1`);
  await waitFor(c, `!!document.querySelector('.mm-branch')`);
  if (!phone) {
    const b = await pt(c, '.mm-branch');
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
    await sleep(300);
    ok(tag + ': hovering a mind map node puts no filter on it (no flash)', await ev(c, `const e=document.querySelector('.mm-branch'); return e.matches(':hover') && (getComputedStyle(e).filter==='none') && !e.style.filter`), await ev(c, `return getComputedStyle(document.querySelector('.mm-branch')).filter`));
  }
  ok(tag + ': Study is no wider than the screen', await noOverflow(c));

  // 2 + 11: voice previews.
  await go(c, '#/b/gita/2/listen', `!!document.querySelector('.pcard')`);
  await click(c, '#make-ai');
  ok(tag + ': Make a podcast offers 8 pairs, each with a play button', await waitFor(c, `document.querySelectorAll('#gen-sheet .mk-pair').length===8 && document.querySelectorAll('#gen-sheet .mk-pair [data-try]').length===8 && [...document.querySelectorAll('#gen-sheet .mk-pair')].some(p=>/Sonia/.test(p.textContent))`));
  await click(c, '#gen-sheet .mk-pair[data-preset="sonia-ryan"] [data-try]');
  ok(tag + ': hearing a pair plays its clip, with no key', await waitFor(c, `document.querySelector('#gen-sheet .mk-pair[data-preset="sonia-ryan"] [data-try]').classList.contains('playing')`, 4000));
  ok(tag + ': …and does not pick the pair', await ev(c, `return document.querySelector('#gen-sheet .mk-pair[data-preset="sonia-ryan"]').getAttribute('aria-checked')==='false'`));
  await click(c, '#gen-sheet .mk-pair[data-preset="sonia-ryan"] [data-try]');
  ok(tag + ': pressed again, it stops', await waitFor(c, `!document.querySelector('#gen-sheet .mk-pair[data-preset="sonia-ryan"] [data-try]').classList.contains('playing')`, 3000));
  await click(c, '#gen-sheet .mk-pair[data-preset="sonia-ryan"]');
  ok(tag + ': tapping the pair picks it (kept by id)', await waitFor(c, `window.Shruti.core.me.get('gen.hosts')==='sonia-ryan' && document.querySelector('#gen-sheet .mk-pair[data-preset="sonia-ryan"]').getAttribute('aria-checked')==='true'`, 3000));
  ok(tag + ': any two voices can be heard too', await ev(c, `return document.querySelectorAll('#gen-sheet [data-try-sel]').length===2`));
  ok(tag + ': the sheet is no wider than the screen', await noOverflow(c));
  if (!phone || who === 'veda') await shot(c, 'voices-' + who + '-' + w);
  await click(c, '#gen-sheet [data-close]');
  ok(tag + ': closing the sheet stops a preview', await waitFor(c, `!document.querySelector('#gen-sheet')`, 3000));

  ok(tag + ': no page errors', !(await ev(c, `return (window.__errs||[]).join(' | ')`)), await ev(c, `return (window.__errs||[]).join(' | ')`));
}

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  for (const [who, w] of [['tony', 1280], ['veda', 390], ['tony', 390], ['veda', 1280]]) {
    try { await pass1(c, who, w); } catch (e) { fail++; console.log('  FAIL ' + who + ' ' + w + ' threw: ' + e.message); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
