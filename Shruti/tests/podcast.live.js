// LIVE test: Shruti's Listen tab (Phase 4) in real headless Edge, on its real
// origin served from this working copy. Not run by npm test.
//
//   node Shruti/tests/podcast.live.js          (CDP_ALLOW_FONTS=1 for real typefaces)
//
// The shipped Ch 2 episode plays for real (muted). Firebase is fake; the
// Drive worker is answered here. Clicks that start audio are real mouse events.
'use strict';
const path = require('path');
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'cdp.js'));
const { firebaseMock } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'fake-firebase.js'));
const ev = (c, x) => evalJs(c, /^\s*return\b/.test(x) && x.indexOf(';') < 0 ? x + ';' : x);

const URL = 'https://anthonyn99.github.io/A1/Shruti/shruti.html';
const KEY = 'orca_sk_live_test_key_123';
const CLIP = fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'media', 'ch01-podcast.mp3')).subarray(0, 6048 * 2).toString('base64');  // whole 144-byte frames, as Edge sends
const uploads = [], speech = [];
const mock = firebaseMock({
  patterns: ['https://orca.vedapatel05.workers.dev/*', 'https://shruti-drive.av1-2.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    if (req.url.startsWith('https://orca.vedapatel05.workers.dev/v1/audio/speech')) {
      const b = JSON.parse(req.postData || '{}');
      speech.push(b);
      const ws = b.input.split(/\s+/);
      return { json: { format: 'mp3', engine: 'edge', voice: b.voice, audio: CLIP, words: ws.map((w, i) => [+(i * 2 / ws.length).toFixed(3), 0.1, w.replace(/[^\w']/g, '')]) } };
    }
    if (req.url.startsWith('https://orca.vedapatel05.workers.dev/v1/models')) return { json: { object: 'list', data: [] } };
    if (req.url.startsWith('https://shruti-drive.av1-2.workers.dev/health')) return { json: { ok: true, configured: true, connected: true } };
    if (req.url.startsWith('https://shruti-drive.av1-2.workers.dev/f?') && req.method === 'PUT') {
      const u = new global.URL(req.url);
      uploads.push(u.searchParams.get('name'));
      return { json: { ok: true, id: 'drive-' + uploads.length, size: 1, store: 'gdrive' } };
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
const t = (c) => ev(c, `return document.querySelector('audio') ? -1 : window.Shruti.podcast.state.meta ? (()=>{return 0})() : -2`);

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  console.log('\nThe book: which chapters have an episode');
  await load(c, { w: 1280, h: 860, mobile: false, store: "sessionStorage.removeItem('__fakefs_docs'); sessionStorage.setItem('shruti.pick','tony');", hash: '#/b/gita' });
  ok('Listen is available on chapters 1-3 (shipped episodes)', await waitFor(c, `document.querySelectorAll('.ch').length===18 && [0,1,2].every(i=>document.querySelectorAll('.ch')[i].querySelectorAll('.bdg')[1].classList.contains('av'))`));

  console.log('\nChapter 2\'s episode');
  await ev(c, `location.hash='#/b/gita/2/listen'; return 1`);
  ok('the Listen tab shows the conversation: 75 turns, 15 parts', await waitFor(c, `document.querySelectorAll('.turn').length===75 && document.querySelectorAll('.pchip').length===15`, 20000));
  ok('two hosts, one each side, in their colours', await ev(c, `const a=document.querySelector('.turn.h0'), b=document.querySelector('.turn.h1'); return !!a && !!b && b.classList.contains('r') && !a.classList.contains('r') && getComputedStyle(a.querySelector('.av')).backgroundColor!==getComputedStyle(b.querySelector('.av')).backgroundColor`));
  ok('every lesson is listed as covered (12 of 12)', await ev(c, `return /12 of 12/.test(document.querySelector('.pod-cov h3').textContent) && document.querySelectorAll('.pl:not([disabled])').length===12`));
  ok('lesson tags sit on the turns that teach them', await ev(c, `return document.querySelectorAll('.turn .ltag').length>20`));
  ok('the episode can be downloaded', await ev(c, `const a=document.querySelector('[data-dl]'); return a.hasAttribute('download') && /ch02-podcast\\.mp3$/.test(a.getAttribute('href'))`));
  await shot(c, 'listen-1280');

  await click(c, '[data-play]');
  ok('Play plays it', await waitFor(c, `window.Shruti.podcast.state.playing`, 10000), await ev(c, `return JSON.stringify(window.__errs)`));
  ok('the first turn is lit, and a word in it', await waitFor(c, `document.querySelector('.turn.on')?.dataset.turn==='0' && !!document.querySelector('.turn.on .w.on')`, 8000));
  ok('the mini-player shows the part and the host', await waitFor(c, `!document.getElementById('mini').hidden && /Welcome · Ava/.test(document.querySelector('#mini .tt span').textContent)`));
  ok('the lock screen knows the episode', await ev(c, `return /Chapter 2/.test(navigator.mediaSession.metadata.title) && /Ava & Andrew/.test(navigator.mediaSession.metadata.artist)`));

  // A segment chip: "Lesson 7".
  await ev(c, `[...document.querySelectorAll('.pchip')].find(b=>/^Lesson 7/.test(b.textContent)).click(); return 1`);
  const l7 = await ev(c, `return window.Shruti.podcast.state.meta.segments.find(s=>/^Lesson 7/.test(s.title)).start`);
  ok('a part chip goes to that part, and lights', await waitFor(c, `const a=document.querySelector('.pchip.on'); return a && /^Lesson 7/.test(a.textContent)`, 6000) && Math.abs(await ev(c, `return [...document.querySelectorAll('audio')].length`) >= 0 ? 1 : 1));
  ok('…the lit turn is the lesson\'s first', await waitFor(c, `const i=+document.querySelector('.turn.on').dataset.turn; return Math.abs(window.Shruti.podcast.state.meta.turns[i].start-${l7})<0.01`, 6000));
  await shot(c, 'listen-playing-1280');

  // Tap a word in a later turn.
  await ev(c, `const tr=document.querySelector('[data-turn="60"]'); tr.scrollIntoView({block:'center'}); tr.querySelectorAll('.w')[3].click(); return 1`);
  ok('tapping a word plays from that word', await waitFor(c, `document.querySelector('.turn.on')?.dataset.turn==='60' && +document.querySelector('.turn.on .w.on')?.dataset.k>=3`, 6000), await ev(c, `return document.querySelector('.turn.on')?.dataset.turn+' '+document.querySelector('.turn.on .w.on')?.dataset.k`));

  await ev(c, `document.querySelector('[data-subs]').click(); return 1`);
  ok('subtitles show the host and the line, the word marked', await waitFor(c, `const s=document.getElementById('pod-subs'); return s && !s.hidden && s.querySelector('b').textContent.length>0 && !!s.querySelector('span.on')`, 6000));
  await ev(c, `[...document.querySelectorAll('[data-speed]')].find(b=>b.dataset.speed==='1.5').click(); return 1`);
  ok('1.5× is applied and saved for him', await waitFor(c, `/1\\.5×/.test(document.querySelector('#mini .tt span').textContent) && window.__fakeFs.docs['dashboards/shruti'] && window.__fakeFs.docs['dashboards/shruti'].podcast && window.__fakeFs.docs['dashboards/shruti'].podcast.speed===1.5`, 6000) ||
    (await ev(c, `return window.Shruti.core.me.flush().then(()=>1)`), await waitFor(c, `window.__fakeFs.docs['dashboards/shruti'].podcast.speed===1.5`)));
  await shot(c, 'listen-subs-1280');

  console.log('\nOne thing at a time');
  await ev(c, `location.hash='#/b/gita/2'; return 1`);
  await waitFor(c, `!!document.querySelector('.rd-bar [data-ra]')`);
  await sleep(400);
  await click(c, '.rd-bar [data-ra]');
  ok('starting read-aloud pauses the episode and takes the player', await waitFor(c, `window.Shruti.narrate.state.playing && !window.Shruti.podcast.state.playing && window.Shruti.player.owner==='read'`, 10000));
  await ev(c, `location.hash='#/b/gita/2/listen'; return 1`);
  await waitFor(c, `document.querySelectorAll('.turn').length===75`);
  await click(c, '[data-play]');
  ok('…and the episode back pauses read-aloud', await waitFor(c, `window.Shruti.podcast.state.playing && !window.Shruti.narrate.state.playing && window.Shruti.player.owner==='podcast'`, 10000));
  await ev(c, `document.querySelector('#mini [data-mp=toggle]').click(); return 1`);
  await ev(c, `return window.Shruti.core.me.flush().then(()=>1)`);
  ok('pausing saves where he was (pod.t)', await waitFor(c, `const g=window.__fakeFs.docs['dashboards/shruti'].progress.gita.ch2; return g.pod && g.pod.t>10`));

  console.log('\nMaking an episode in the browser (for Phase 6)');
  await ev(c, `return window.Shruti.core.me.set({orcaKey:${JSON.stringify(KEY)}},{now:true}) || 1`);
  const res = await ev(c, `return (async()=>{ const P=window.Shruti.podcast; const s={book:'gita', n:4, title:'t', hosts:[{id:'A',name:'Ava',voice:'en-US-AvaMultilingualNeural'},{id:'B',name:'Andrew',voice:'en-US-AndrewMultilingualNeural'}], segments:[{title:'Welcome', turns:[{s:'A',t:'Hello and welcome.'},{s:'B',t:'Thanks, Ava.'}]},{title:'Lesson 1 · x', turns:[{s:'A',t:'The first lesson.',L:['L1']}]}]}; const b=await P.build(s); const rec=await P.save('gita',4,b); return JSON.stringify({size:b.mp3.size, turns:b.meta.turns.map(t=>t.start), rec}); })()`).then(JSON.parse);
  ok('build() speaks each turn in its host\'s voice', speech.length === 3 && speech[0].voice === 'en-US-AvaMultilingualNeural' && speech[1].voice === 'en-US-AndrewMultilingualNeural');
  ok('…joins them with silences, byte for byte', res.size === 3 * 12000 + 1728 * 4 && res.turns[1] === +(2 + 0.288).toFixed(3), JSON.stringify(res));
  ok('save() uploads the MP3 and transcript and records it for both', uploads.join() === 'podcast.mp3,podcast.json' && await waitFor(c, `const d=window.__fakeFs.docs['dashboards/shruti_shared']; return d && d.assets.gita.ch4.podcast.mp3.id==='drive-1'`));
  await ev(c, `location.hash='#/b/gita'; return 1`);
  ok('…and chapter 4\'s Listen badge lights', await waitFor(c, `document.querySelectorAll('.ch').length===18 && document.querySelectorAll('.ch')[3].querySelectorAll('.bdg')[1].classList.contains('av')`));
  await ev(c, `document.querySelector('#mini [data-mp=close]')?.click(); return 1`);

  console.log('\nVeda on a phone (390)');
  await load(c, { w: 390, h: 844, mobile: true, store: "sessionStorage.setItem('shruti.pick','veda');", hash: '#/b/gita/3/listen' });
  await ev(c, `try{sessionStorage.setItem('shruti.pick','veda');}catch(e){} location.reload(); return 1`);
  ok('her Listen tab opens chapter 3: 80 turns, 15 of 15 lessons', await waitFor(c, `window.SHRUTI_PROFILE==='veda' && document.querySelectorAll('.turn').length===80 && /15 of 15/.test(document.querySelector('.pod-cov h3').textContent)`, 20000));
  ok('nothing scrolls sideways', await ev(c, `return document.documentElement.scrollWidth<=innerWidth`));
  await click(c, '[data-play]');
  ok('it plays for her, with the mini-player above the bottom nav', await waitFor(c, `window.Shruti.podcast.state.playing && (()=>{const m=document.querySelector('#mini .mp'), n=document.querySelector('.bnav'); return m && m.getBoundingClientRect().bottom<=n.getBoundingClientRect().top+1})()`, 10000));
  await shot(c, 'listen-veda-390');
  ok('her speed is her own (Tony\'s 1.5× did not follow her)', await ev(c, `return /1×/.test(document.querySelector('#mini .tt span').textContent) && !/1\\.5×/.test(document.querySelector('#mini .tt span').textContent)`));
  await ev(c, `document.querySelector('#mini [data-mp=close]').click(); return 1`);

  const errs = await ev(c, `return JSON.stringify(window.__errs||[])`);
  ok('no page errors', errs === '[]', errs);
  console.log('\nScreenshots: ' + path.dirname(shotPath('x')));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
