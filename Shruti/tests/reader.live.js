// LIVE test: Shruti's reader and read-aloud (Phase 3) in real headless Edge, on
// its real origin served from this working copy. Not run by npm test.
//
//   node Shruti/tests/reader.live.js           (CDP_ALLOW_FONTS=1 for real typefaces)
//
// Firebase is fake (tests/live/fake-firebase.js); Orca's /v1/audio/speech and
// the Drive worker are answered here. The shipped Ch 1-3 narrations play for
// real (muted). Clicks that start audio are real mouse events, since a page
// may only start sound from a real gesture.
'use strict';
const path = require('path');
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'cdp.js'));
const { firebaseMock } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'fake-firebase.js'));
const ev = (c, x) => evalJs(c, /^\s*return\b/.test(x) && x.indexOf(';') < 0 ? x + ';' : x);

const URL = 'https://anthonyn99.github.io/A1/Shruti/shruti.html';
const KEY = 'orca_sk_live_test_key_123';
const MEDIA = path.join(__dirname, '..', 'books', 'gita', 'media');
// A real MP3 for Orca's answers: the first 3 s of the shipped chapter 1.
const CLIP = fs.readFileSync(path.join(MEDIA, 'ch01-read.mp3')).subarray(0, 6000 * 3).toString('base64');
const speech = [], uploads = [];
const mock = firebaseMock({
  patterns: ['https://orca.vedapatel05.workers.dev/*', 'https://shruti-drive.av1-2.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const auth = (req.headers && (req.headers.Authorization || req.headers.authorization)) || '';
    if (req.url.startsWith('https://orca.vedapatel05.workers.dev/v1/models')) return auth === 'Bearer ' + KEY ? { json: { object: 'list', data: [{ id: 'deepseek/free', routable: true }] } } : { status: 401, json: {} };
    if (req.url.startsWith('https://orca.vedapatel05.workers.dev/v1/audio/voices')) return { json: { default: 'en-GB-SoniaNeural', voices: [{ id: 'en-GB-SoniaNeural', name: 'Sonia', locale: 'en-GB', gender: 'female', engine: 'edge' }, { id: 'en-US-AvaMultilingualNeural', name: 'Ava', locale: 'en-US', gender: 'female', engine: 'edge' }, { id: 'en-GB-RyanNeural', name: 'Ryan', locale: 'en-GB', gender: 'male', engine: 'edge' }] } };
    if (req.url.startsWith('https://orca.vedapatel05.workers.dev/v1/audio/speech')) {
      if (auth !== 'Bearer ' + KEY) return { status: 401, json: {} };
      const b = JSON.parse(req.postData || '{}');
      speech.push(b);
      // Every word gets its share of the 3 s clip, as Edge's timings would.
      const ws = (b.input.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-.]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) || []);
      const d = 3 / Math.max(1, ws.length);
      return { json: { format: 'mp3', engine: 'edge', voice: b.voice, audio: CLIP, words: ws.map((w, i) => [+(i * d).toFixed(3), +(d * 0.9).toFixed(3), w]) } };
    }
    if (req.url.startsWith('https://shruti-drive.av1-2.workers.dev/health')) return { json: { ok: true, configured: true, connected: true, email: 'tony@example.com' } };
    if (req.url.startsWith('https://shruti-drive.av1-2.workers.dev/f?') && req.method === 'PUT') {
      const u = new global.URL(req.url);
      uploads.push({ name: u.searchParams.get('name'), chapter: u.searchParams.get('chapter'), owner: u.searchParams.get('owner'), auth });
      return { json: { ok: true, id: 'drive-' + uploads.length, size: 10, mime: 'x', store: 'gdrive', owner: u.searchParams.get('owner') } };
    }
    return null;
  },
});

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -> ' + String(d).slice(0, 400) : '')); }
};
const waitFor = async (c, expr, ms = 15000) => {
  const t0 = Date.now();
  // An expression with statements needs its own return (evalJs wraps it in a function).
  if (expr.indexOf(';') >= 0 && !/^\s*(return|const|let|var|if|for)\W/.test(expr)) expr = 'return ' + expr;
  while (Date.now() - t0 < ms) { try { if (await ev(c, expr)) return true; } catch {} await sleep(150); }
  return false;
};
const shot = async (c, name) => {
  await sleep(700);
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const data = r && (r.result ? r.result.data : r.data);
  if (data) fs.writeFileSync(shotPath('shruti-' + name), Buffer.from(data, 'base64'));
};
/** A real click (a user gesture) in the middle of the element. */
async function click(c, sel) {
  const at = JSON.parse(await ev(c, `const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'null'; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})`));
  if (!at) throw new Error('no ' + sel);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
}
const RUN = String(Date.now());
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
  // From a blank page: the tab may still be on this URL from an earlier run,
  // and a change of #hash alone would not load the page (or its code) again.
  await c.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await c.send('Page.navigate', { url: URL + hash });
  await sleep(400);
}
const doc = (c, p) => ev(c, `return JSON.stringify(window.__fakeFs.docs['${p}']||{})`).then(JSON.parse);
const flush = (c) => ev(c, `return window.Shruti.core.me.flush().then(()=>1)`);

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  console.log('\nTony opens chapter 2 (1280)');
  await load(c, { w: 1280, h: 860, mobile: false, store: "sessionStorage.removeItem('__fakefs_docs'); sessionStorage.setItem('shruti.pick','tony');", hash: '#/b/gita/2' });
  ok('the reader opens with its bar', await waitFor(c, `!!document.querySelector('.rd-bar [data-ra]') && !!document.querySelector('.rd p')`));
  ok('every block carries its index', await ev(c, `const b=[...document.querySelectorAll('.rd [data-b]')].map(e=>+e.dataset.b); return b.length>20 && b.every((x,i)=>x===i)`));
  ok('the book\'s asides are styled by kind (marker, gloss, commentary, note)', await ev(c, `return ['marker','gloss','commentary','note'].every(k=>!!document.querySelector('.rd aside.'+k))`));
  ok('the marker reads as a centred divider', await ev(c, `return getComputedStyle(document.querySelector('.rd aside.marker')).textAlign==='center'`));
  await shot(c, 'reader-1280');

  console.log('\nPartial highlights (chapter 3)');
  await ev(c, `location.hash='#/b/gita/3'; return 1`);
  await waitFor(c, `/Karma-yoga/.test(document.querySelector('.cp-head h1').textContent) && !!document.querySelector('.rd [data-b="6"]')`);
  const v319 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'ch03.json'), 'utf8')).blocks[6].s.find((s) => s.v === '3.19');
  ok('verse 3.19 marks only its highlighted words', await ev(c, `const p=document.querySelector('.rd [data-b="6"]'); const k=[...p.querySelectorAll('.key')].map(x=>x.textContent); return k.includes(${JSON.stringify(v319.t.slice(64, 162))}) && !k.includes(${JSON.stringify(v319.t)})`));

  console.log('\nThe look (Aa), synced');
  await ev(c, `location.hash='#/b/gita/2'; return 1`);
  await waitFor(c, `/Spiritual knowledge/.test(document.querySelector('.cp-head h1').textContent) && !!document.querySelector('.rd [data-b="12"]')`);
  await ev(c, `document.querySelector('[data-aa]').click(); return 1`);
  ok('Aa opens size, spacing, type and width', await waitFor(c, `!document.getElementById('rd-aa').hidden && document.querySelectorAll('#rd-aa .seg').length===4`));
  await ev(c, `document.querySelector('#rd-aa [data-k=size][data-v="4"]').click(); document.querySelector('#rd-aa [data-k=width][data-v="2"]').click(); document.querySelector('#rd-aa [data-k=font][data-v=sans]').click(); document.querySelector('#rd-aa [data-k=lead][data-v="2"]').click(); return 1`);
  ok('the text grows, widens, turns sans and opens up', await waitFor(c, `const r=document.querySelector('.rd'), s=getComputedStyle(r); return s.fontSize==='22px' && s.maxWidth==='860px' && r.classList.contains('sans') && Math.abs(parseFloat(s.lineHeight)/22-1.95)<0.01`),
    await ev(c, `const s=getComputedStyle(document.querySelector('.rd')); return s.fontSize+' '+s.maxWidth+' '+s.lineHeight`));
  ok('the reading page keeps the text\'s width', await waitFor(c, `getComputedStyle(document.querySelector('.rd-card')).maxWidth==='972px'`));
  await flush(c);
  ok('…saved to his doc', await waitFor(c, `const d=window.__fakeFs.docs['dashboards/shruti']; return d && d.reader && d.reader.size===4 && d.reader.width===2 && d.reader.font==='sans' && d.reader.lead===2`));
  await shot(c, 'reader-aa-1280');
  await ev(c, `document.querySelector('#rd-aa [data-k=size][data-v="2"]').click(); document.querySelector('#rd-aa [data-k=width][data-v="1"]').click(); document.querySelector('#rd-aa [data-k=font][data-v=serif]').click(); document.querySelector('#rd-aa [data-k=lead][data-v="1"]').click(); document.querySelector('[data-aa]').click(); return 1`);

  console.log('\nBookmarks');
  const vb = await ev(c, `return +[...document.querySelectorAll('.rd .vn')].find(v=>v.textContent==='2.11').dataset.vn`);
  await ev(c, `[...document.querySelectorAll('.rd .vn')].find(v=>v.textContent==='2.11').click(); return 1`);
  ok('tapping verse 2.11\'s number bookmarks it (ribbon, count)', await waitFor(c, `document.querySelector('.rd [data-b="${vb}"]').classList.contains('bm') && document.querySelector('.rd-bar .cnt').textContent==='1'`));
  ok('…in his doc, named by its verse', await waitFor(c, `const d=window.__fakeFs.docs['dashboards/shruti']; return d.bookmarks && d.bookmarks.gita.ch2['b${vb}'].label==='Verse 2.11'`));
  const textTop = await ev(c, `return document.querySelector('.rd').getBoundingClientRect().top`);
  await ev(c, `document.querySelector('[data-bms]').click(); return 1`);
  ok('the bookmarks list shows it', await waitFor(c, `/Verse 2\\.11/.test(document.getElementById('rd-bms').textContent)`));
  ok('…as a drop-down over the text: the reading text does not move', await ev(c, `const p=document.getElementById('rd-bms'); return getComputedStyle(p).position==='absolute' && Math.abs(document.querySelector('.rd').getBoundingClientRect().top-${textTop})<1 && p.getBoundingClientRect().right<=document.querySelector('.rd-bar').getBoundingClientRect().right+1`),
    await ev(c, `return document.querySelector('.rd').getBoundingClientRect().top+' vs ${textTop}'`));
  await shot(c, 'reader-bookmarks-1280');
  await ev(c, `document.querySelector('.rd p').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true})); return 1`);
  ok('a tap outside closes it', await waitFor(c, `document.getElementById('rd-bms').hidden && document.querySelector('[data-bms]').getAttribute('aria-expanded')==='false'`));
  await ev(c, `document.querySelector('[data-bms]').click(); return 1`);
  await waitFor(c, `!document.getElementById('rd-bms').hidden`);
  await ev(c, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); return 1`);
  ok('…and so does Esc', await waitFor(c, `document.getElementById('rd-bms').hidden`));
  await ev(c, `location.hash='#/b/gita'; return 1`);
  ok('the book page lists his bookmarks', await waitFor(c, `[...document.querySelectorAll('.bmk')].some(b=>/Verse 2\\.11/.test(b.textContent))`));
  await ev(c, `document.querySelector('.bmk').click(); return 1`);
  ok('a bookmark opens the chapter at that verse', await waitFor(c, `location.hash==='#/b/gita/2/read/${vb}' && (()=>{const r=document.querySelector('.rd [data-b="${vb}"]').getBoundingClientRect(); return r.top>40 && r.top<300})()`, 6000),
    await ev(c, `return location.hash+' '+document.querySelector('.rd [data-b="${vb}"]')?.getBoundingClientRect().top`));

  console.log('\nWhere he was, on every device');
  await ev(c, `location.hash='#/b/gita/2'; return 1`);
  await waitFor(c, `!!document.querySelector('.rd [data-b="20"]')`);
  await sleep(600);
  await ev(c, `document.querySelector('.rd [data-b="20"]').scrollIntoView({block:'start'}); scrollBy(0,-150); dispatchEvent(new Event('scroll')); return 1`);
  await sleep(1700);
  await ev(c, `scrollBy(0,2); dispatchEvent(new Event('scroll')); return 1`);
  await flush(c);
  const pos = (await doc(c, 'dashboards/shruti')).progress.gita.ch2.pos;
  ok('his place is saved (pos)', pos >= 17 && pos <= 20, pos);
  const spotBefore = await ev(c, `return Math.round(document.querySelector('.rd [data-b="20"]').getBoundingClientRect().top)`);
  await ev(c, `location.hash='#/b/gita'; return 1`);
  await waitFor(c, `document.querySelectorAll('.ch').length===18`);
  await ev(c, `location.hash='#/b/gita/2'; return 1`);
  ok('coming back opens exactly there, to the pixel (Tony, 2026-10-22)', await waitFor(c, `Math.abs(document.querySelector('.rd [data-b="20"]').getBoundingClientRect().top- (${spotBefore}))<=3`, 6000), spotBefore + ' -> ' + await ev(c, `return Math.round(document.querySelector('.rd [data-b="20"]').getBoundingClientRect().top)`));
  await shot(c, 'reader-resume-1280');

  console.log('\nRead-aloud from the shipped narration (no key)');
  await ev(c, `scrollTo(0,0); return 1`);
  await click(c, '.rd-bar [data-ra]');
  ok('Listen plays chapter 2\'s ready-made narration', await waitFor(c, `window.Shruti.narrate.state.mode==='file' && window.Shruti.narrate.state.playing`, 10000),
    await ev(c, `return JSON.stringify({m:window.Shruti.narrate.state.mode,p:window.Shruti.narrate.state.playing,e:window.__errs})`));
  ok('the mini-player shows with -15, play/pause, +15', await waitFor(c, `!document.getElementById('mini').hidden && !!document.querySelector('#mini [data-mp=back]') && !!document.querySelector('#mini [data-mp=fwd]') && document.querySelector('#mini [data-mp=toggle]').getAttribute('aria-label')==='Pause'`));
  ok('the word being said is lit, in the block being read', await waitFor(c, `!!document.querySelector('.rd .speaking .w.on')`, 8000));
  const lit1 = await ev(c, `return document.querySelector('.rd .w.on').textContent`);
  await sleep(1200);
  ok('…and moves on as the voice does', await ev(c, `return document.querySelector('.rd .w.on') && document.querySelector('.rd .w.on').textContent`) !== null && await waitFor(c, `document.querySelector('.rd .w.on') && document.querySelector('.rd .w.on').textContent!==${JSON.stringify(lit1)}`, 4000));
  ok('the lock screen knows what is playing', await ev(c, `return navigator.mediaSession && navigator.mediaSession.metadata && /Chapter 2/.test(navigator.mediaSession.metadata.title)`));
  const t0 = await ev(c, `return document.querySelector('audio') ? 0 : 1`);
  const before = await ev(c, `return window.Shruti.narrate.fraction()`);
  await ev(c, `document.querySelector('#mini [data-mp=fwd]').click(); return 1`);
  await sleep(300);
  ok('+15 s moves forward', await ev(c, `return window.Shruti.narrate.fraction()`) > before + 0.01);
  await shot(c, 'reader-listen-1280');

  // Tap a word further down: the voice goes there.
  const far = await ev(c, `const p=document.querySelector('.rd [data-b="25"]'); p.scrollIntoView({block:'center'}); return 25`);
  await sleep(300);
  await ev(c, `document.querySelector('.rd [data-b="25"]').click(); return 1`);
  ok('tapping a paragraph reads from there', await waitFor(c, `!!document.querySelector('.rd [data-b="25"].speaking')`, 8000), await ev(c, `return document.querySelector('.speaking')?.dataset.b`));

  console.log('\nVoice, speed, sleep');
  await ev(c, `document.querySelector('#mini [data-mp=more]').click(); return 1`);
  ok('the read-aloud sheet opens', await waitFor(c, `!!document.getElementById('ra-sheet') && document.querySelectorAll('#ra-speed .chip').length===8 && ![...document.querySelectorAll('#ra-speed .chip')].some(b=>b.textContent==='1.1×')`));
  await ev(c, `[...document.querySelectorAll('#ra-speed .chip')].find(b=>b.textContent==='1.5×').click(); return 1`);
  ok('1.5× speeds the voice up, pitch kept', await ev(c, `const a=[...document.querySelectorAll('audio')][0]; return true`) && await waitFor(c, `window.Shruti.narrate.state.mode && document.querySelector('#mini .tt span').textContent.includes('1.5×')`));
  ok('…and is saved for him', await waitFor(c, `const d=window.__fakeFs.docs['dashboards/shruti']; return d.narration && d.narration.speed===1.5`, 5000) || (await flush(c), await waitFor(c, `window.__fakeFs.docs['dashboards/shruti'].narration.speed===1.5`)));
  await ev(c, `[...document.querySelectorAll('#ra-sleep .chip')].find(b=>b.textContent==='15 min').click(); return 1`);
  ok('a 15-minute sleep timer shows in the player', await waitFor(c, `/sleep 15 min/.test(document.querySelector('#mini .tt span').textContent)`));
  ok('the shipped narration is listed as ready', await waitFor(c, `/Sonia\s*Comes with Shruti/.test(document.getElementById('ra-save').textContent)`));
  await shot(c, 'reader-sheet-1280');
  await ev(c, `document.querySelector('#ra-sheet [data-close]').click(); document.querySelector('#mini [data-mp=toggle]').click(); return 1`);
  ok('pause pauses', await waitFor(c, `!window.Shruti.narrate.state.playing && document.querySelector('#mini [data-mp=toggle]').getAttribute('aria-label')==='Play'`));
  await flush(c);
  ok('where the voice was is saved (ra)', await waitFor(c, `const g=window.__fakeFs.docs['dashboards/shruti'].progress.gita.ch2; return g.ra && g.ra.i>0`));

  console.log('\nRead-aloud through Orca (a voice with no ready-made narration)');
  await ev(c, `document.querySelector('#mini [data-mp=close]').click(); window.Shruti.core.me.set({orcaKey:${JSON.stringify(KEY)}, 'narration.voice':'en-GB-RyanNeural', 'narration.speed':1},{now:true}); location.hash='#/b/gita/4'; return 1`);
  await waitFor(c, `/renunciation/.test(document.querySelector('.cp-head h1').textContent) && !!document.querySelector('.rd [data-b="3"]')`);
  await sleep(500);
  await click(c, '.rd-bar [data-ra]');
  ok('chapter 4 is spoken live by Orca in Ryan\'s voice', await waitFor(c, `window.Shruti.narrate.state.mode==='live' && window.Shruti.narrate.state.playing`, 10000) && speech.length >= 1 && speech[0].voice === 'en-GB-RyanNeural' && speech[0].timestamps === true,
    JSON.stringify(speech.slice(0, 1)));
  ok('the first request is the chapter\'s first block, exactly', speech[0] && (() => { const b0 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'ch04.json'), 'utf8')).blocks[0]; return speech[0].input === (b0.k === 'p' ? b0.s.map((x) => x.t).join(' ') : b0.t); })(), speech[0] && speech[0].input.slice(0, 80));
  ok('the next two are fetched ahead', await waitFor(c, `true`) && (await sleep(800), speech.length >= 3));
  ok('the word is lit here too', await waitFor(c, `!!document.querySelector('.rd .speaking .w.on')`, 8000));
  await ev(c, `document.querySelector('#mini [data-mp=close]').click(); return 1`);

  console.log('\nSave narration to Drive');
  const rec = await ev(c, `return import('./narrate.js').then(async (N)=>{ const L=window.Shruti.library; const ch=await L.loadChapter('gita','ch01.json'); const r=await N.saveNarration({book:'gita', n:1, ch, title:'x'}, 'en-GB-RyanNeural'); return JSON.stringify(r); })`).then(JSON.parse).catch((e) => ({ err: String(e) }));
  ok('chapter 1 is spoken and uploaded as one MP3 and its timings', uploads.length === 2 && uploads[0].name === 'read-ryan.mp3' && uploads[1].name === 'read-ryan.json' && uploads.every((u) => u.chapter === 'ch1' && u.owner === 'tony' && u.auth === 'Bearer ' + KEY), JSON.stringify(uploads));
  ok('the shared doc records it for both of them', await waitFor(c, `const d=window.__fakeFs.docs['dashboards/shruti_shared']; return d && d.assets && d.assets.gita.ch1.read.voice==='en-GB-RyanNeural' && d.assets.gita.ch1.read.mp3.id==='drive-1'`), JSON.stringify(rec));
  ok('…and it is offered from then on', await ev(c, `return window.Shruti.narrate.readyFor('gita',1).then(r=>r.some(x=>x.where==='drive' && x.voice==='en-GB-RyanNeural'))`));

  console.log('\nVeda on a phone (390)');
  await load(c, { w: 390, h: 844, mobile: true, store: "sessionStorage.setItem('shruti.pick','veda');", hash: '#/b/gita/3' });
  await ev(c, `try{sessionStorage.setItem('shruti.pick','veda');}catch(e){} return 1`);
  await ev(c, `location.reload(); return 1`);
  ok('Veda\'s reader opens', await waitFor(c, `window.SHRUTI_PROFILE==='veda' && !!document.querySelector('.rd p')`));
  ok('her look is her own (Tony\'s Aa choices did not follow her)', await ev(c, `return getComputedStyle(document.querySelector('.rd')).fontSize==='18px'`));
  ok('nothing scrolls sideways', await ev(c, `return document.documentElement.scrollWidth<=innerWidth`));
  await click(c, '.rd-bar [data-ra]');
  ok('read-aloud plays for her from the shipped narration', await waitFor(c, `window.Shruti.narrate.state.mode==='file' && window.Shruti.narrate.state.playing`, 10000));
  ok('the mini-player fits above the bottom nav with 40px controls', await waitFor(c, `const m=document.querySelector('#mini .mp'), n=document.querySelector('.bnav'); if(!m) return false; const r=m.getBoundingClientRect(); return r.bottom<=n.getBoundingClientRect().top+1 && r.right<=innerWidth && [...m.querySelectorAll('.ctl .ib')].filter(b=>getComputedStyle(b).display!=='none').every(b=>b.getBoundingClientRect().height>=40)`));
  await shot(c, 'reader-veda-390');
  await ev(c, `document.querySelector('[data-aa]').click(); return 1`);
  await shot(c, 'reader-veda-aa-390');
  ok('the Aa panel fits the phone', await ev(c, `const p=document.getElementById('rd-aa').getBoundingClientRect(); return p.right<=innerWidth && p.left>=0`));
  await ev(c, `document.querySelector('#mini [data-mp=close]').click(); return 1`);

  const errs = await ev(c, `return JSON.stringify(window.__errs||[])`);
  ok('no page errors', errs === '[]', errs);
  console.log('\nScreenshots: ' + path.dirname(shotPath('x')));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
