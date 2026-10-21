// LIVE test: Shruti's Make with AI (Phase 6) in real headless Edge, on its
// real origin served from this working copy. Not run by npm test.
//
//   node Shruti/tests/generate.live.js          (CDP_ALLOW_FONTS=1 for real typefaces)
//
// Orca (models, streamed chat, speech) and the Drive worker are answered here;
// Firebase is fake. The first podcast reply forgets a lesson, so the repair
// runs for real. Drive starts disconnected (the result plays on this device),
// then connects (the result is uploaded and kept as a version).
'use strict';
const path = require('path');
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'cdp.js'));
const { firebaseMock } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'fake-firebase.js'));
const ev = (c, x) => evalJs(c, /^\s*return\b/.test(x) && x.indexOf(';') < 0 ? x + ';' : x);

const URL = 'https://anthonyn99.github.io/A1/Shruti/shruti.html';
const KEY = 'orca_sk_live_test_key_123';
const ORCA = 'https://orca.vedapatel05.workers.dev/v1';
const DRIVE = 'https://shruti-drive.av1-2.workers.dev';
const PAGES_MEDIA = 'https://anthonyn99.github.io/A1/Shruti/books/gita/media/';
const CLIP = fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'media', 'ch01-podcast.mp3')).subarray(0, 6000).toString('base64');
const lessons = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'lessons.json'), 'utf8'));
const ids5 = lessons[5].lessons.map((l) => l.id);

// What the "units" write, per kind.
const podcastFull = { segments: [{ title: 'Welcome', turns: [{ s: 'A', t: 'Welcome to chapter five.' }, { s: 'B', t: 'Today: renunciation.' }] }]
  .concat(ids5.map((id, i) => ({ title: 'Lesson ' + (i + 1) + ' · ' + lessons[5].lessons[i].title.slice(0, 30), turns: [{ s: i % 2 ? 'B' : 'A', t: 'Here is ' + id + ', explained simply.', L: [id] }] })))
  .concat([{ title: 'Wrap-up', turns: [{ s: 'B', t: 'Thanks for listening.' }] }]) };
const podcastFirst = { segments: podcastFull.segments.filter((s) => !s.turns.some((t) => (t.L || []).includes('L13'))) };
const videoFull = { scenes: [{ layout: 'title', headline: 'The Path of Renunciation', visual: ['Made with AI'], say: 'Chapter five, made in the browser.' },
  { layout: 'verse', ref: '5.10', say: 'Verse ten. {verse}' }]
  .concat(ids5.map((id, i) => ({ layout: 'lesson', L: [id], visual: ['Point one', 'Point two'], say: 'Lesson ' + (i + 1) + '. A short explanation.' })))
  .concat([{ layout: 'closing', headline: 'In short', visual: ['One', 'Two', 'Three'], say: 'That is chapter five.' }]) };
const lessonsReply = { lessons: [{ title: 'Act without clinging', body: 'Work, and let go of the fruits.' }, { title: 'See all equally', body: 'The same Self is in all.' }], summary: 'A short summary.' };

const S = { drive: false, chats: [], speech: [], uploads: [], dels: [], stored: {}, slow: 0 };
const sse = (obj) => {
  const text = 'Here it is:\n```json\n' + JSON.stringify(obj) + '\n```';
  const parts = text.match(/[\s\S]{1,400}/g);
  return parts.map((p) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
};
const mock = firebaseMock({
  patterns: [ORCA + '/*', DRIVE + '/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = req.url;
    if (u.startsWith(ORCA + '/models')) return { json: { object: 'list', data: [{ id: 'deepseek/free', routable: true }, { id: 'chatgpt/free', routable: true }, { id: 'gemini_web/free', routable: false }, { id: 'perplexity/free', routable: true }, { id: 'claude/free', routable: true }] } };
    if (u.startsWith(ORCA + '/chat/completions')) {
      const b = JSON.parse(req.postData || '{}');
      S.chats.push({ model: b.model, n: b.messages.length });
      const all = JSON.stringify(b.messages);
      const reply = /two-host podcast/.test(all) ? (b.messages.length === 2 ? podcastFirst : podcastFull) : /explainer video/.test(all) ? videoFull : lessonsReply;
      const out = { type: 'text/event-stream', text: sse(reply) };
      return S.slow ? new Promise((r) => setTimeout(() => r(out), S.slow)) : out;
    }
    if (u.startsWith(ORCA + '/audio/speech')) {
      const b = JSON.parse(req.postData || '{}');
      S.speech.push(b.voice);
      const ws = b.input.split(/\s+/);
      return { json: { format: 'mp3', engine: 'edge', voice: b.voice, audio: CLIP, words: ws.map((w, i) => [+(i * 0.9 / ws.length).toFixed(3), 0.05, w.replace(/[^\w']/g, '')]) } };
    }
    if (u.startsWith(DRIVE + '/health')) return { json: { ok: true, configured: true, connected: S.drive } };
    if (u.startsWith(DRIVE + '/f?') && req.method === 'PUT') {
      const name = new global.URL(u).searchParams.get('name'), id = 'drive-' + (S.uploads.length + 1);
      S.uploads.push(name);
      if (/json$/.test(name)) S.stored[id] = req.postData || null;
      return { json: { ok: true, id, size: 1, store: 'gdrive' } };
    }
    if (u.startsWith(DRIVE + '/f/') && req.method === 'DELETE') { S.dels.push(u.split('/').pop()); return { json: { ok: true } }; }
    if (u.startsWith(DRIVE + '/sign')) {
      const ids = JSON.parse(req.postData || '{}').ids || [];
      // The MP3 is a shipped one (any audio plays); the transcript is the one uploaded.
      return { json: { urls: Object.fromEntries(ids.map((id) => [id, S.stored[id] !== undefined ? DRIVE + '/raw/' + id : PAGES_MEDIA + 'ch05-video.mp3'])) } };
    }
    if (u.startsWith(DRIVE + '/raw/')) { const id = u.split('/').pop(); return S.stored[id] ? { text: S.stored[id] } : { status: 404, json: {} }; }
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
  await sleep(600);
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
const sheetKind = (c, k) => ev(c, `document.querySelector('#gen-sheet [data-kind="${k}"]').click(); return 1`);

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  console.log('\nThe sheet');
  await load(c, { w: 1280, h: 860, mobile: false, store: "sessionStorage.removeItem('__fakefs_docs'); sessionStorage.setItem('shruti.pick','tony');", hash: '#/b/gita/5' });
  await waitFor(c, `!!window.Shruti && !!window.Shruti.core.me.loaded`, 15000);
  await ev(c, `return window.Shruti.core.me.set({orcaKey:${JSON.stringify(KEY)}},{now:true}) || 1`);
  ok('the chapter has "Make with AI"', await waitFor(c, `!!document.querySelector('#make-ai')`));
  await click(c, '#make-ai');
  ok('it opens: four kinds, Comes with Shruti ticked for the podcast', await waitFor(c, `document.querySelectorAll('#gen-sheet [data-kind]').length===4 && /Comes with Shruti/.test(document.querySelector('#gen-vers .gv.on')?.textContent||'')`));
  ok('the units come from Orca, in his order, Claude off', await waitFor(c, `const u=[...document.querySelectorAll('#gen-sheet [data-unit]')]; return u.length>=5 && u[0].textContent.includes('DeepSeek') && u.find(b=>/Claude/.test(b.textContent)).getAttribute('aria-checked')==='false' && u.find(b=>/Gemini/.test(b.textContent)).classList.contains('off')`));
  await ev(c, `document.querySelector('#gen-sheet [data-len="concise"]').click(); return 1`);
  await ev(c, `[...document.querySelectorAll('#gen-sheet [data-preset]')].find(b=>/Emma/.test(b.textContent)).click(); return 1`);
  ok('length and hosts are his, synced', await waitFor(c, `const g=window.Shruti.core.me.get('gen'); return g.length==='concise' && g.hosts===1 && document.querySelector('#gen-a').value==='en-US-EmmaMultilingualNeural'`));
  await ev(c, `const t=document.querySelector('#gen-extra'); t.value='Explain the lotus leaf.'; t.dispatchEvent(new Event('change')); return 1`);
  await shot(c, 'make-sheet-1280');

  console.log('\nA podcast, Drive not connected');
  S.slow = 1500;
  await click(c, '#gen-sheet [data-make]');
  ok('Write runs, and other devices can see it (jobs…podcast)', await waitFor(c, `document.querySelector('.gen-steps li.cur')?.textContent.startsWith('Write') && window.__fakeFs.docs['dashboards/shruti_shared']?.jobs?.gita?.ch5?.podcast?.stage==='write'`, 8000));
  S.slow = 0;
  ok('the reply streams in, the unit that answered is named', await waitFor(c, `/"segments"/.test(document.querySelector('.gen-live pre')?.textContent||'') && /DeepSeek/.test(document.querySelector('.gen-model')?.textContent||'')`, 10000));
  ok('a missing lesson is caught and repaired: 13 of 13', await waitFor(c, `/13 of 13/.test(document.querySelector('.gen-cov em')?.textContent||'') && !!document.querySelector('.gen-steps') && [...document.querySelectorAll('.gen-steps li')].some(l=>/^Repair/.test(l.textContent))`, 15000));
  ok('…by asking the same unit again, with its reply', S.chats.length === 2 && S.chats[1].model === S.chats[0].model && S.chats[1].n === 4, JSON.stringify(S.chats));
  ok('it is spoken in Emma and Brian, and ends ready on this device', await waitFor(c, `/plays on this device only/.test(document.querySelector('#gen-run').textContent)`, 20000) && S.speech.length === 2 + ids5.length + 1 && S.speech[0] === 'en-US-EmmaMultilingualNeural' && S.speech[1] === 'en-US-BrianMultilingualNeural', S.speech.slice(0, 3).join());
  ok('…nothing uploaded, no version, the job cleared', !S.uploads.length && await ev(c, `const d=window.__fakeFs.docs['dashboards/shruti_shared']||{}; return !(d.versions&&d.versions.gita&&d.versions.gita.ch5) && !(d.jobs&&d.jobs.gita&&d.jobs.gita.ch5&&d.jobs.gita.ch5.podcast)`));
  await shot(c, 'make-done-1280');
  await click(c, '#gen-run [data-open]');
  ok('"Play it" opens Listen with the new episode: Emma and Brian, every turn', await waitFor(c, `location.hash==='#/b/gita/5/listen' && document.querySelectorAll('.turn').length===${2 + ids5.length + 1} && /Emma and Brian/.test(document.querySelector('.pod-t span').textContent) && /13 of 13/.test(document.querySelector('.pod-cov h3').textContent)`, 10000));
  await click(c, '[data-play]');
  ok('…and it plays', await waitFor(c, `window.Shruti.podcast.state.playing`, 8000));
  await ev(c, `window.Shruti.podcast.pause(); return 1`);

  console.log('\nA video, Drive connected');
  S.drive = true;
  await click(c, '#make-ai');
  await waitFor(c, `!!document.querySelector('#gen-sheet')`);
  await sheetKind(c, 'video');
  ok('Video shows its own versions (Comes with Shruti) and a narrator', await waitFor(c, `document.querySelector('#gen-sheet [data-kind=video]').classList.contains('on') && /Comes with Shruti/.test(document.querySelector('#gen-vers').textContent) && !!document.querySelector('#gen-nar')`));
  await ev(c, `const s=document.querySelector('#gen-nar'); s.value='en-GB-SoniaNeural'; s.dispatchEvent(new Event('change')); return 1`);
  S.speech.length = 0;
  await click(c, '#gen-sheet [data-make]');
  ok('it is written, spoken in Sonia, uploaded and saved', await waitFor(c, `/Saved, and it plays now/.test(document.querySelector('#gen-run').textContent)`, 25000) && S.speech.every((v) => v === 'en-GB-SoniaNeural') && S.uploads.join() === 'video.mp3,video.json', S.uploads.join());
  ok('…as a new version that plays, for both of them', await waitFor(c, `const v=document.querySelectorAll('#gen-vers .gv'); return v.length===2 && v[1].classList.contains('on') && /Sonia/.test(v[1].textContent) && /DeepSeek/.test(v[1].textContent) && /both of you/.test(document.querySelector('#gen-vers').textContent)`), await ev(c, `return document.querySelector('#gen-vers').textContent`));
  ok('the shared doc has the version and plays it', await ev(c, `const d=window.__fakeFs.docs['dashboards/shruti_shared']; const v=d.assets.gita.ch5.video; return v.mp3.id==='drive-1' && v.json.id==='drive-2' && v.model==='deepseek/free' && !!d.versions.gita.ch5.video[v.id]`));
  await shot(c, 'make-video-1280');
  await click(c, '#gen-run [data-open]');
  const madeScenes = videoFull.scenes.length;
  if (S.stored['drive-2']) {
    ok('Watch plays the made video from Drive: its ' + madeScenes + ' scenes, the verse from the book', await waitFor(c, `location.hash==='#/b/gita/5/watch' && document.querySelectorAll('.vsc').length===${madeScenes} && /Verse 5\\.10/.test(document.querySelectorAll('.vsc')[1].textContent)`, 15000), await ev(c, `return document.getElementById('mode-body').textContent.slice(0,200)`));
  } else ok('(the uploaded transcript could not be captured; Drive playback not checked)', true);

  console.log('\nVersions');
  await click(c, '#make-ai');
  await waitFor(c, `!!document.querySelector('#gen-sheet')`);
  await sheetKind(c, 'video');
  await waitFor(c, `document.querySelectorAll('#gen-vers .gv').length===2`);
  await ev(c, `document.querySelector('#gen-vers [data-feature=""]').click(); return 1`);
  ok('ticking "Comes with Shruti" plays the original again', await waitFor(c, `document.querySelector('#gen-vers .gv.on') && /Comes with Shruti/.test(document.querySelector('#gen-vers .gv.on').textContent) && !(window.__fakeFs.docs['dashboards/shruti_shared'].assets.gita.ch5||{}).video`));
  await ev(c, `document.querySelector('#gen-vers [data-del]').click(); return 1`);
  await waitFor(c, `!!document.querySelector('.sheet-dim [data-r="1"]')`);
  await ev(c, `[...document.querySelectorAll('.sheet-dim [data-r="1"]')].pop().click(); return 1`);
  const gone = await waitFor(c, `document.querySelectorAll('#gen-vers .gv').length===1`, 6000);
  for (const t0 = Date.now(); S.dels.length < 2 && Date.now() - t0 < 5000;) await sleep(100);
  ok('Delete removes the version and both its files on Drive', gone && S.dels.sort().join() === 'drive-1,drive-2', S.dels.join());

  console.log('\nLessons');
  await sheetKind(c, 'lessons');
  ok('Lessons: "Your own notes" are what shows now', await waitFor(c, `/Your own notes/.test(document.querySelector('#gen-vers .gv.on')?.textContent||'')`));
  await click(c, '#gen-sheet [data-make]');
  ok('lessons are drawn and kept (no Drive needed)', await waitFor(c, `/Saved, and it plays now/.test(document.querySelector('#gen-run').textContent)`, 15000));
  await click(c, '#gen-run [data-open]');
  ok('the Lessons tab shows them, saying who drew them', await waitFor(c, `location.hash==='#/b/gita/5/lessons' && document.querySelectorAll('.ls-i').length===2 && /drawn by DeepSeek/.test(document.querySelector('.ls-k').textContent)`, 8000));
  await click(c, '#make-ai');
  await waitFor(c, `!!document.querySelector('#gen-sheet [data-kind=lessons].on')`);
  await ev(c, `document.querySelector('#gen-vers [data-feature=""]').click(); return 1`);
  await ev(c, `document.querySelector('#gen-sheet [data-close]').click(); location.hash='#/b/gita/5'; return 1`);
  await sleep(300);
  await ev(c, `location.hash='#/b/gita/5/lessons'; return 1`);
  ok('…and their own notes come back when ticked', await waitFor(c, `document.querySelectorAll('.ls-i').length===13 && /notes/.test(document.querySelector('.ls-k').textContent)`, 8000));

  console.log('\nVeda on a phone (390), while Tony makes something');
  await ev(c, `return window.Shruti.core.shared.flush().then(()=>1)`);
  await load(c, { w: 390, h: 844, mobile: true, store: "sessionStorage.setItem('shruti.pick','veda');", hash: '#/b/gita/5' });
  await ev(c, `try{sessionStorage.setItem('shruti.pick','veda');}catch(e){} location.reload(); return 1`);
  await waitFor(c, `window.SHRUTI_PROFILE==='veda' && !!document.querySelector('#make-ai')`, 20000);
  await ev(c, `window.__fakeFs.remote('dashboards/shruti_shared', {jobs:{gita:{ch5:{podcast:{by:'tony', at:Date.now(), kind:'podcast', stage:'speak', text:'Speaking 12 of 40'}}}}}, {merge:true}); return 1`);
  ok('the chapter page fits her phone', await ev(c, `return document.documentElement.scrollWidth<=innerWidth`));
  await click(c, '#make-ai');
  ok('her sheet shows Tony making a podcast, and waits', await waitFor(c, `/Tony is making this: speaking 12 of 40/.test(document.querySelector('#gen-vers').textContent) && document.querySelector('#gen-sheet [data-make]').disabled`, 8000), await ev(c, `return document.querySelector('#gen-vers')?.textContent`));
  ok('her own settings: the default length and hosts', await ev(c, `return document.querySelector('#gen-sheet [data-len=standard]').classList.contains('on') && document.querySelector('#gen-a').value==='en-US-AvaMultilingualNeural'`));
  await shot(c, 'make-veda-390');
  await ev(c, `window.__fakeFs.remote('dashboards/shruti_shared', {jobs:{gita:{ch5:{podcast:null}}}}, {merge:true}); return 1`);

  const errs = await ev(c, `return JSON.stringify(window.__errs||[])`);
  ok('no page errors', errs === '[]', errs);
  console.log('\nScreenshots: ' + path.dirname(shotPath('x')));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
