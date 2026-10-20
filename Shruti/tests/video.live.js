// LIVE test: Shruti's Watch tab (Phase 5) in real headless Edge, on its real
// origin served from this working copy. Not run by npm test.
//
//   node Shruti/tests/video.live.js          (CDP_ALLOW_FONTS=1 for real typefaces)
//
// The shipped Ch 2 video plays for real (muted). Firebase is fake. Clicks that
// start audio are real mouse events. Frames of the canvas are saved next to
// the screenshots (shruti-frame-*.png) so the pictures can be looked at.
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
    if (req.url.startsWith('https://orca.vedapatel05.workers.dev/v1/models')) return { json: { object: 'list', data: [] } };
    if (req.url.startsWith('https://shruti-drive.av1-2.workers.dev/health')) return { json: { ok: true, configured: true, connected: true } };
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
/** Paused at time t, the canvas at full size, saved as a PNG. */
const frameAt = async (c, name, t) => {
  const url = await ev(c, `return (async()=>{ const V=window.Shruti.video; await V.seek(${t}); const v=V.state.view; v.full=true; v.resize(); const u=v.canvas.toDataURL('image/png'); v.full=false; v.resize(); return u; })()`);
  fs.writeFileSync(shotPath('shruti-frame-' + name), Buffer.from(String(url).split(',')[1], 'base64'));
  return url;
};
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
  await c.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await c.send('Page.navigate', { url: URL + hash });
  await sleep(400);
}

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  console.log('\nThe book: which chapters have a video');
  await load(c, { w: 1280, h: 860, mobile: false, store: "sessionStorage.removeItem('__fakefs_docs'); sessionStorage.setItem('shruti.pick','tony');", hash: '#/b/gita' });
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'media', 'videos.json'), 'utf8'));
  const want = Object.keys(shipped).map(Number);
  ok('Watch is lit on every chapter with a shipped video (' + want.length + ')', await waitFor(c, `document.querySelectorAll('.ch').length===18 && ${JSON.stringify(want)}.every(n=>document.querySelectorAll('.ch')[n-1].querySelectorAll('.bdg')[2].classList.contains('av'))`));

  console.log('\nChapter 2\'s video');
  await ev(c, `location.hash='#/b/gita/2/watch'; return 1`);
  const nScenes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'media', 'ch02-video.json'), 'utf8')).scenes.length;
  ok('the Watch tab shows the stage, the cover and ' + nScenes + ' scenes', await waitFor(c, `!!document.querySelector('.vid-stage canvas') && !document.querySelector('.vid-cover').hidden && document.querySelectorAll('.vsc').length===${nScenes}`, 20000));
  ok('every lesson is covered (12 of 12), each a jump', await ev(c, `return /12 of 12/.test(document.querySelector('.vid .pod-cov h3').textContent) && document.querySelectorAll('.vid .pl:not([disabled])').length===12`));
  ok('the canvas is drawn at the stage\'s size, 16:9', await ev(c, `const cv=document.querySelector('.vid-stage canvas'), r=cv.getBoundingClientRect(); return cv.width>=640 && Math.abs(cv.width/cv.height-16/9)<0.01 && Math.abs(r.width/r.height-16/9)<0.02`));
  ok('the scrubber marks scenes, lessons in gold', await ev(c, `return document.querySelectorAll('.vid-ticks i').length===${nScenes} && document.querySelectorAll('.vid-ticks i.l').length>=12`));
  await shot(c, 'watch-1280');

  await click(c, '.vid-cover');
  ok('the cover plays it', await waitFor(c, `window.Shruti.video.state.playing && window.Shruti.video.now()>0.3`, 10000), await ev(c, `return JSON.stringify(window.__errs)`));
  ok('the cover goes; the first scene card is lit', await waitFor(c, `document.querySelector('.vid-cover').hidden && document.querySelector('.vsc.on')?.dataset.scene==='0'`));
  ok('the mini-player is the video\'s, naming the scene', await waitFor(c, `window.Shruti.player.owner==='video' && /^Video · Spiritual Knowledge/.test(document.querySelector('#mini .tt span').textContent)`));
  ok('the lock screen knows the video', await ev(c, `return /Chapter 2/.test(navigator.mediaSession.metadata.title) && /Video · Brian/.test(navigator.mediaSession.metadata.artist)`));

  // A scene card: the first verse.
  const vi = await ev(c, `return window.Shruti.video.state.meta.scenes.findIndex(s=>s.layout==='verse')`);
  await ev(c, `document.querySelector('[data-scene="${vi}"]').click(); return 1`);
  ok('a scene card goes to that scene, and lights', await waitFor(c, `document.querySelector('.vsc.on')?.dataset.scene==='${vi}' && window.Shruti.video.state.scene===${vi}`, 6000));
  await ev(c, `document.querySelector('[data-next]').click(); return 1`);
  ok('Next goes to the scene after', await waitFor(c, `window.Shruti.video.state.scene===${vi + 1}`, 6000));
  await ev(c, `const b=[...document.querySelectorAll('.vid .pl')].find(b=>b.dataset.lesson==='L7'); b.click(); return 1`);
  ok('a lesson jumps to the first scene that teaches it', await waitFor(c, `(window.Shruti.video.state.meta.scenes[window.Shruti.video.state.scene].L||[]).includes('L7')`, 6000));
  await shot(c, 'watch-playing-1280');

  console.log('\nThe verse lights as it is read');
  const verseLit = await ev(c, `return (async()=>{ const V=window.Shruti.video, s=V.state.meta.scenes[${vi}]; const out=[]; for (const f of [0.2,0.5,0.8]) { const t=s.at+s.words[Math.floor(s.words.length*f)][0]; const k=V.tokenAt(s.cc,s.words,t-s.at); out.push(k); } return JSON.stringify({out, vs:s.vs}); })()`).then(JSON.parse);
  ok('the word being read moves forward through the verse', verseLit.out[0] < verseLit.out[1] && verseLit.out[1] < verseLit.out[2] && verseLit.out[2] >= verseLit.vs[0], JSON.stringify(verseLit));
  await ev(c, `window.Shruti.video.pause(); return 1`);
  const m = await ev(c, `return JSON.stringify(window.Shruti.video.state.meta.scenes.map(s=>({l:s.layout,at:s.at,start:s.start,end:s.end,w:s.words.length?s.words[Math.floor(s.words.length*0.6)][0]:0})))`).then(JSON.parse);
  const pick = (lay) => m.findIndex((s) => s.l === lay);
  for (const lay of ['title', 'verse', 'story', 'lesson', 'compare', 'steps', 'closing']) {
    const i = pick(lay);
    if (i < 0) { ok('a ' + lay + ' scene exists in chapter 2', false); continue; }
    const s = m[i];
    const u = await frameAt(c, lay, s.at + s.w);
    ok('the ' + lay + ' layout draws (frame saved)', String(u).length > 50000, String(u).length);
  }

  console.log('\nSettings');
  await ev(c, `[...document.querySelectorAll('.vid [data-speed]')].find(b=>b.dataset.speed==='1.5').click(); return 1`);
  ok('1.5× is applied and saved for him', await waitFor(c, `document.querySelector('audio')===null && window.Shruti.core.me.get('video.speed')===1.5`) || await ev(c, `return window.Shruti.core.me.get('video.speed')===1.5`));
  await ev(c, `document.querySelector('.vid [data-cc]').click(); return 1`);
  ok('captions toggle off, saved', await ev(c, `return window.Shruti.core.me.get('video.cc')===false && document.querySelector('.vid [data-cc]').getAttribute('aria-pressed')==='false'`));
  await ev(c, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true})); return 1`);
  ok('…and C turns them back on', await waitFor(c, `window.Shruti.core.me.get('video.cc')===true`, 3000));

  console.log('\nOne thing at a time');
  await click(c, '[data-play]');
  ok('Play plays at 1.5×', await waitFor(c, `window.Shruti.video.state.playing`, 6000) && await ev(c, `return /1\\.5×/.test(document.querySelector('#mini .tt span').textContent)`));
  await ev(c, `location.hash='#/b/gita/2/listen'; return 1`);
  ok('the video keeps playing on another tab, in the mini-player', await waitFor(c, `document.querySelectorAll('.turn').length>0 && window.Shruti.video.state.playing && window.Shruti.player.owner==='video'`, 15000));
  await click(c, '[data-play]');
  ok('starting the podcast pauses the video', await waitFor(c, `window.Shruti.podcast.state.playing && !window.Shruti.video.state.playing && window.Shruti.player.owner==='podcast'`, 10000));
  await ev(c, `window.Shruti.podcast.pause(); return 1`);
  await ev(c, `return window.Shruti.core.me.flush().then(()=>1)`);
  ok('pausing saved where he was in the video (vid.t)', await waitFor(c, `const g=window.__fakeFs.docs['dashboards/shruti'].progress.gita.ch2; return g.vid && g.vid.t>5`));
  await ev(c, `location.hash='#/b/gita/2/watch'; return 1`);
  await waitFor(c, `document.querySelectorAll('.vsc').length===${nScenes}`);
  await click(c, '[data-play]');
  ok('back on Watch, Play takes the player back', await waitFor(c, `window.Shruti.video.state.playing && window.Shruti.player.owner==='video'`, 10000));

  console.log('\nFull screen and export');
  await click(c, '[data-fs]');
  ok('full screen fills the screen with the picture', await waitFor(c, `const s=document.querySelector('.vid-stage'); return (s.classList.contains('fs')||s.classList.contains('pfs')) && Math.abs(s.getBoundingClientRect().width-innerWidth)<2`, 5000));
  await shot(c, 'watch-fullscreen-1280');
  await ev(c, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',bubbles:true})); return 1`);
  ok('F leaves full screen', await waitFor(c, `const s=document.querySelector('.vid-stage'); return !s.classList.contains('fs') && !s.classList.contains('pfs')`, 5000));
  ok('this browser can export', await ev(c, `return window.Shruti.video.canExport() && !!window.Shruti.video.pickMime()`), await ev(c, `return window.Shruti.video.pickMime()`));
  await click(c, '[data-export]');
  ok('Export records from the start at 1×, controls locked', await waitFor(c, `const V=window.Shruti.video.state; return V.rec && V.rec.state==='recording' && V.playing && document.querySelector('audio')===null && !document.querySelector('.vid-recb').hidden && document.querySelector('[data-play]').disabled`, 8000));
  ok('…the picture is recorded at 1920×1080', await ev(c, `return document.querySelector('.vid-stage canvas').width===1920`));
  await sleep(1500);
  await ev(c, `document.querySelector('[data-export]').click(); return 1`);
  ok('stopping cancels it cleanly', await waitFor(c, `!window.Shruti.video.state.rec && !window.Shruti.video.state.playing && /cancelled/.test(document.querySelector('.vid-note').textContent) && document.querySelector('.vid-stage canvas').width<1920`, 5000));
  await ev(c, `document.querySelector('#mini [data-mp=close]')?.click(); return 1`);

  console.log('\nVeda on a phone (390)');
  await load(c, { w: 390, h: 844, mobile: true, store: "sessionStorage.setItem('shruti.pick','veda');", hash: '#/b/gita/2/watch' });
  await ev(c, `try{sessionStorage.setItem('shruti.pick','veda');}catch(e){} location.reload(); return 1`);
  ok('her Watch tab opens chapter 2', await waitFor(c, `window.SHRUTI_PROFILE==='veda' && document.querySelectorAll('.vsc').length===${nScenes}`, 20000));
  ok('nothing scrolls sideways', await ev(c, `return document.documentElement.scrollWidth<=innerWidth`));
  ok('the stage spans the page and the scrubber has its own row', await ev(c, `const s=document.querySelector('.vid-stage').getBoundingClientRect(), t=document.querySelector('.vid-track').getBoundingClientRect(), p=document.querySelector('[data-play]').getBoundingClientRect(); return s.width>340 && t.width>300 && t.bottom<=p.top+2`));
  await shot(c, 'watch-veda-390');
  await click(c, '.vid-cover');
  ok('it plays for her, the mini-player above the bottom nav', await waitFor(c, `window.Shruti.video.state.playing && (()=>{const m=document.querySelector('#mini .mp'), n=document.querySelector('.bnav'); return m && m.getBoundingClientRect().bottom<=n.getBoundingClientRect().top+1})()`, 10000));
  ok('her speed is her own (Tony\'s 1.5× did not follow her)', await ev(c, `return /· 1×/.test(document.querySelector('#mini .tt span').textContent)`));
  await frameAt(c, 'veda-lesson', m[pick('lesson')].at + m[pick('lesson')].w);
  await click(c, '[data-fs]');
  ok('full screen on her phone fills the window', await waitFor(c, `const s=document.querySelector('.vid-stage'); return s.classList.contains('fs')||s.classList.contains('pfs')`, 5000));
  await shot(c, 'watch-veda-fullscreen-390');
  await ev(c, `document.querySelector('[data-ov-fs]').click(); return 1`);
  await ev(c, `document.querySelector('#mini [data-mp=close]').click(); return 1`);

  const errs = await ev(c, `return JSON.stringify(window.__errs||[])`);
  ok('no page errors', errs === '[]', errs);
  console.log('\nScreenshots: ' + path.dirname(shotPath('x')));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
