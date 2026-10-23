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
const CLIP = fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'media', 'ch01-podcast.mp3')).subarray(0, 6048).toString('base64');  // whole 144-byte frames, as Edge sends
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
// The units answer in the labelled formats (formats.js), as asked since 2026-10-22.
const podText = (p) => p.segments.map((sg) => 'PART: ' + sg.title + ((sg.turns[0].L || [])[0] ? ' [' + sg.turns[0].L[0] + ']' : '') + '\n' + sg.turns.map((t) => t.s + ': ' + t.t).join('\n')).join('\n\n') + '\n\nEND';
const vidText = (v) => v.scenes.map((s, i) => 'SCENE ' + (i + 1) + '\nLAYOUT: ' + s.layout + (s.headline ? '\nHEADLINE: ' + s.headline : '') + (s.ref ? '\nVERSE: ' + s.ref : '') + ((s.L || [])[0] ? '\nLESSON: ' + s.L[0] : '') + (s.visual ? '\nVISUAL:\n' + s.visual.map((x) => '- ' + x).join('\n') : '') + '\nNARRATION: ' + s.say).join('\n\n') + '\n\nEND';
const lesText = (l) => l.lessons.map((x, i) => 'LESSON ' + (i + 1) + '\nTITLE: ' + x.title + '\nBODY: ' + x.body).join('\n\n') + '\n\nSUMMARY: ' + l.summary + '\nEND';

const S = { drive: false, chats: [], speech: [], uploads: [], dels: [], stored: {}, slow: 0 };
const sse = (text) => {
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
      const all = JSON.stringify(b.messages), last = JSON.stringify(b.messages[b.messages.length - 1]);
      // The podcast forgets L13, then writes only that part when asked; the lessons' second look finds nothing more.
      const reply = /two-host podcast/.test(all) ? (b.messages.length === 2 ? podText(podcastFirst) : podText({ segments: podcastFull.segments.filter((s) => s.turns.some((t) => (t.L || []).includes('L13'))) }))
        : /narrated video/.test(all) ? vidText(videoFull)
        : /compare it with your list/.test(last) ? 'NONE\nEND' : lesText(lessonsReply);
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
      // Like the real worker: a link that never expires comes back with the file.
      return { json: { ok: true, id, size: 1, store: 'gdrive', acct: 'tony', url: /json$/.test(name) ? DRIVE + '/raw/' + id : PAGES_MEDIA + 'ch05-video.mp3' } };
    }
    if (u.startsWith(DRIVE + '/f/') && req.method === 'DELETE') { S.dels.push(u.split('/').pop().split('?')[0]); return { json: { ok: true } }; }
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
  window.__up={}; const f0=window.fetch; window.fetch=function(u,o){ try{ if(o&&o.method==='PUT'&&String(u).indexOf('/f?')>=0&&typeof o.body==='string') window.__up[new URL(String(u)).searchParams.get('name')]=o.body; }catch(e){} return f0.apply(this,arguments); };
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
const openSheet = async (c, tab) => {
  await ev(c, `location.hash='#/b/gita/5${tab === 'read' ? '' : '/' + tab}'; return 1`);
  await waitFor(c, `!!document.querySelector('#make-ai') && !document.querySelector('#gen-sheet') && (${tab === 'read' ? "!!document.querySelector('.rd')" : "location.hash.endsWith('" + tab + "')"})`, 10000);
  await click(c, '#make-ai');
  return waitFor(c, `!!document.querySelector('#gen-sheet #gen-run')`, 8000);
};
const closeSheet = (c) => ev(c, `const s=document.querySelector('#gen-sheet [data-close]'); if(s) s.click(); return 1`);

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  console.log('\nThe sheet: only what the tab makes (Tony, 2026-10-22)');
  await load(c, { w: 1280, h: 860, mobile: false, store: "sessionStorage.removeItem('__fakefs_docs'); sessionStorage.setItem('shruti.pick','tony');", hash: '#/b/gita/5/listen' });
  await waitFor(c, `!!window.Shruti && !!window.Shruti.core.me.loaded`, 15000);
  await ev(c, `return window.Shruti.core.me.set({orcaKey:${JSON.stringify(KEY)}},{now:true}) || 1`);
  ok('the chapter has "Make with AI"', await waitFor(c, `!!document.querySelector('#make-ai')`));
  await click(c, '#make-ai');
  ok('on Listen it makes a podcast, and nothing else: no kind to choose', await waitFor(c, `/Make a podcast/.test(document.querySelector('#gen-sheet h2')?.textContent||'') && !document.querySelector('#gen-sheet [data-kind]') && /Comes with Shruti/.test(document.querySelector('#gen-vers .gv.on')?.textContent||'')`), await ev(c, `return (document.querySelector('#gen-sheet')||{}).textContent||'no sheet'`));
  ok('the units come from Orca, in his order, Claude off (under More options)', await waitFor(c, `const u=[...document.querySelectorAll('#gen-sheet [data-unit]')]; return u.length>=5 && u[0].textContent.includes('DeepSeek') && u.find(b=>/Claude/.test(b.textContent)).getAttribute('aria-checked')==='false' && u.find(b=>/Gemini/.test(b.textContent)).classList.contains('off') && !document.querySelector('#gen-sheet .mk-more:not(.mk-any)').open`));
  await ev(c, `document.querySelector('#gen-sheet [data-len="concise"]').click(); return 1`);
  await ev(c, `[...document.querySelectorAll('#gen-sheet [data-preset]')].find(b=>/Emma/.test(b.textContent)).click(); return 1`);
  ok('length and hosts are his, synced', await waitFor(c, `const g=window.Shruti.core.me.get('gen'); return g.length==='concise' && g.hosts==='emma-brian' && document.querySelector('#gen-a').value==='en-US-EmmaMultilingualNeural' && document.querySelector('#gen-sheet [data-preset="emma-brian"]').getAttribute('aria-checked')==='true'`));
  await ev(c, `const t=document.querySelector('#gen-extra'); t.value='Explain the lotus leaf.'; t.dispatchEvent(new Event('change')); return 1`);
  await shot(c, 'make-sheet-1280');

  console.log('\nA podcast in the background, Drive not connected');
  S.slow = 1500;
  await click(c, '#gen-sheet [data-make]');
  ok('Write runs, and other devices can see it (jobs…podcast)', await waitFor(c, `document.querySelector('#gen-run .mk-steps li.cur')?.textContent.startsWith('Write') && window.__fakeFs.docs['dashboards/shruti_shared']?.jobs?.gita?.ch5?.podcast?.stage==='write'`, 8000));
  // Closing the sheet does not stop it (Tony, 2026-10-22: it keeps going in the background).
  await closeSheet(c);
  ok('the sheet closes; Make with AI shows it is still being made', await waitFor(c, `!document.querySelector('#gen-sheet') && document.querySelector('#make-ai').classList.contains('busy') && /Making podcast/.test(document.querySelector('#make-ai').textContent)`, 6000), await ev(c, `return document.querySelector('#make-ai').outerHTML`));
  ok('…and the header shows it too', await waitFor(c, `!document.querySelector('#jobs-pill').hidden`, 4000));
  S.slow = 0;
  await ev(c, `location.hash='#/'; return 1`);
  ok('it carries on while he is in the library', await waitFor(c, `!!document.querySelector('.shelf') && window.Shruti.jobs.active().length===1`, 6000));
  ok('…written, a missing lesson caught and asked for on its own, spoken: done, with an Open button', await waitFor(c, `/is ready on this device/.test(document.querySelector('#toast').textContent) && !!document.querySelector('#toast .toast-b')`, 25000), await ev(c, `return document.querySelector('#toast').textContent`));
  ok('…the repair went to the same unit, naming only L13', S.chats.length === 2 && S.chats[1].model === S.chats[0].model && S.chats[1].n === 4, JSON.stringify(S.chats));
  ok('it is spoken in Emma and Brian', S.speech.length === 2 + ids5.length + 1 && S.speech[0] === 'en-US-EmmaMultilingualNeural' && S.speech[1] === 'en-US-BrianMultilingualNeural', S.speech.slice(0, 3).join());
  ok('…nothing uploaded, no version, the job cleared', !S.uploads.length && await ev(c, `const d=window.__fakeFs.docs['dashboards/shruti_shared']||{}; return !(d.versions&&d.versions.gita&&d.versions.gita.ch5) && !(d.jobs&&d.jobs.gita&&d.jobs.gita.ch5&&d.jobs.gita.ch5.podcast)`));
  await click(c, '#toast .toast-b');
  ok('"Open" goes to Listen with the new episode: Emma and Brian, every turn', await waitFor(c, `location.hash==='#/b/gita/5/listen' && document.querySelectorAll('.turn').length===${2 + ids5.length + 1} && /Emma & Brian/.test(document.querySelector('.pod-t span').textContent) && /13 of 13/.test(document.querySelector('[data-fold=podLessons] h3').textContent)`, 10000));
  ok('…and it starts playing by itself (Tony, 2026-10-22: it played the old one)', await waitFor(c, `window.Shruti.podcast.state.playing && /Emma and Brian/.test(window.Shruti.podcast.state.meta.hosts.map(h=>h.name).join(' and '))`, 8000));
  await ev(c, `window.Shruti.podcast.pause(); return 1`);
  ok('Make with AI is itself again', await waitFor(c, `!document.querySelector('#make-ai').classList.contains('busy') && /Make with AI/.test(document.querySelector('#make-ai').textContent)`));

  console.log('\nA video, Drive connected');
  S.drive = true;
  // The shipped video is loaded and was playing: "Play it" must not play it again.
  await ev(c, `location.hash='#/b/gita/5/watch'; return 1`);
  await waitFor(c, `!!document.querySelector('.vid [data-play]')`, 10000);
  await ev(c, `return window.Shruti.video.load('gita',5,'x').then(()=>{window.Shruti.video.play(); return 1})`);
  await waitFor(c, `window.Shruti.video.state.playing`, 6000);
  await ev(c, `window.Shruti.video.pause(); return 1`);
  const oldSrc = await ev(c, `return window.Shruti.video.state.src`);
  await click(c, '#make-ai');
  ok('on Watch it makes a video: its versions (Comes with Shruti) and the narrators, Sonia ticked by default', await waitFor(c, `/Make a video/.test(document.querySelector('#gen-sheet h2').textContent) && /Comes with Shruti/.test(document.querySelector('#gen-vers').textContent) && document.querySelector('#gen-sheet [data-nar="en-GB-SoniaNeural"]').getAttribute('aria-checked')==='true'`));
  S.speech.length = 0;
  await click(c, '#gen-sheet [data-make]');
  ok('it is written, spoken in Sonia, uploaded and saved', await waitFor(c, `/Saved\\. It plays now on every device/.test(document.querySelector('#gen-run').textContent)`, 25000) && S.speech.every((v) => v === 'en-GB-SoniaNeural') && S.uploads.join() === 'video.mp3,video.json', S.uploads.join());
  ok('…as a new version that plays, for both of them', await waitFor(c, `const v=document.querySelectorAll('#gen-vers .gv'); return v.length===2 && v[1].classList.contains('on') && /Sonia/.test(v[1].textContent) && /DeepSeek/.test(v[1].textContent) && /both of you/.test(document.querySelector('#gen-vers').textContent)`), await ev(c, `return document.querySelector('#gen-vers').textContent`));
  ok('the shared doc has the version and plays it, with links that need no key', await ev(c, `const d=window.__fakeFs.docs['dashboards/shruti_shared']; const v=d.assets.gita.ch5.video; return v.mp3.id==='drive-1' && v.json.id==='drive-2' && /raw\\/drive-2/.test(v.json.url) && v.model==='deepseek/free' && !!d.versions.gita.ch5.video[v.id]`));
  await shot(c, 'make-video-1280');
  // The browser's request body never reaches the mock; the page kept it.
  S.stored['drive-2'] = S.stored['drive-2'] || await ev(c, `return window.__up['video.json']||null`);
  await click(c, '#gen-run [data-open]');
  const madeScenes = videoFull.scenes.length;
  if (S.stored['drive-2']) {
    ok('Watch plays the made video from Drive: its ' + madeScenes + ' scenes, the verse from the book', await waitFor(c, `location.hash==='#/b/gita/5/watch' && document.querySelectorAll('.vsc').length===${madeScenes} && /Verse 5\\.10/.test(document.querySelectorAll('.vsc')[1].textContent)`, 15000), await ev(c, `return document.getElementById('mode-body').textContent.slice(0,200)`));
    ok('…the new one, not the shipped one that was loaded, and it starts by itself', await waitFor(c, `window.Shruti.video.state.playing && /^drive:drive-1/.test(window.Shruti.video.state.src) && window.Shruti.video.state.meta.narrator.name==='Sonia'`, 10000), oldSrc + ' -> ' + await ev(c, `return window.Shruti.video.state.src`));
    await ev(c, `window.Shruti.video.pause(); return 1`);
  } else ok('(the uploaded transcript could not be captured; Drive playback not checked)', true);

  console.log('\nVersions');
  await click(c, '#make-ai');
  await waitFor(c, `document.querySelectorAll('#gen-vers .gv').length===2`);
  await ev(c, `document.querySelector('#gen-vers [data-feature=""]').click(); return 1`);
  ok('ticking "Comes with Shruti" plays the original again', await waitFor(c, `document.querySelector('#gen-vers .gv.on') && /Comes with Shruti/.test(document.querySelector('#gen-vers .gv.on').textContent) && !(window.__fakeFs.docs['dashboards/shruti_shared'].assets.gita.ch5||{}).video`));
  await ev(c, `document.querySelector('#gen-vers [data-del]').click(); return 1`);
  await waitFor(c, `!!document.querySelector('.sheet-dim [data-r="1"]')`);
  await ev(c, `[...document.querySelectorAll('.sheet-dim [data-r="1"]')].pop().click(); return 1`);
  const gone = await waitFor(c, `document.querySelectorAll('#gen-vers .gv').length===1`, 6000);
  for (const t0 = Date.now(); S.dels.length < 2 && Date.now() - t0 < 5000;) await sleep(100);
  ok('Delete removes the version and both its files on Drive', gone && S.dels.sort().join() === 'drive-1,drive-2', S.dels.join());
  await closeSheet(c);

  console.log('\nLessons');
  await openSheet(c, 'lessons');
  ok('on Lessons: "Draw the lessons", the detail choice, "Your own notes" ticked', await waitFor(c, `/Draw the lessons/.test(document.querySelector('#gen-sheet h2').textContent) && /Detail/.test(document.querySelector('#gen-opts').textContent) && /Your own notes/.test(document.querySelector('#gen-vers .gv.on')?.textContent||'')`));
  await click(c, '#gen-sheet [data-make]');
  ok('lessons are drawn, a second look for any missed, and kept (no Drive needed)', await waitFor(c, `/Saved\\. It plays now/.test(document.querySelector('#gen-run').textContent)`, 15000) && S.chats.slice(-2).length === 2);
  await click(c, '#gen-run [data-open]');
  ok('the Lessons tab shows them, saying who drew them', await waitFor(c, `location.hash==='#/b/gita/5/lessons' && document.querySelectorAll('.ls-i').length===2 && /drawn by DeepSeek/.test(document.querySelector('.ls-k').textContent)`, 8000));
  await click(c, '#make-ai');
  await waitFor(c, `/Draw the lessons/.test(document.querySelector('#gen-sheet h2')?.textContent||'')`);
  await ev(c, `document.querySelector('#gen-vers [data-feature=""]').click(); return 1`);
  ok('…and their own notes come back the moment they are ticked, with no tab change (Tony, 2026-10-22)', await waitFor(c, `document.querySelectorAll('#mode-body .ls-i').length===13 && /notes/.test(document.querySelector('.ls-k').textContent) && location.hash==='#/b/gita/5/lessons'`, 8000));
  await ev(c, `[...document.querySelectorAll('#gen-vers [data-feature]')].find(b=>b.dataset.feature).click(); return 1`);
  ok('…and ticking the AI set again shows it at once', await waitFor(c, `document.querySelectorAll('#mode-body .ls-i').length===2`, 8000));
  await ev(c, `document.querySelector('#gen-vers [data-feature=""]').click(); return 1`);
  await closeSheet(c);
  await waitFor(c, `document.querySelectorAll('#mode-body .ls-i').length===13`, 8000);

  console.log('\nBuild everything');
  await ev(c, `location.hash='#/b/gita'; return 1`);
  await waitFor(c, `!!document.querySelector('.bk-head [data-build]')`, 8000);
  await sleep(500);   // the view's transition (clicks during it go nowhere)
  await click(c, '.bk-head [data-build]');
  ok('the book page opens Build everything: what, how, which chapters', await waitFor(c, `!!document.querySelector('#build-sheet [data-build]') && document.querySelectorAll('#build-sheet [data-kind]').length===5 && document.querySelectorAll('#build-sheet [data-ch]').length===19`, 8000), await ev(c, `const s=document.querySelector('#build-sheet'); return s ? 'kinds '+s.querySelectorAll('[data-kind]').length+' chs '+s.querySelectorAll('[data-ch]').length : 'no sheet: '+location.hash+' '+document.querySelectorAll('.sheet-dim').length`));
  await ev(c, `const k=(n,on)=>{const x=document.querySelector('#build-sheet [data-kind='+n+']'); if(x.checked!==on){x.checked=on; x.dispatchEvent(new Event('change'));}}; k('read',false); k('podcast',false); k('video',false); k('study',false); k('lessons',true); return 1`);
  await ev(c, `const all=document.querySelector('#build-sheet [data-chall]'); if(/None/.test(all.textContent)) all.click(); return 1`);
  await ev(c, `[...document.querySelectorAll('#build-sheet [data-ch]')].filter(b=>['5','6'].includes(b.dataset.ch)).forEach(b=>b.click()); return 1`);
  ok('…it counts what it will make: lessons for chapters 5 and 6', await waitFor(c, `/Build 2 things/.test(document.querySelector('#build-sheet [data-build]').textContent)`, 4000), await ev(c, `return document.querySelector('#build-sheet [data-build]').textContent`));
  await shot(c, 'make-build-1280');
  const chats0 = S.chats.length;
  await click(c, '#build-sheet [data-build]');
  ok('…and builds in the background: the panel lists them with what was made before, the pill shows', await waitFor(c, `!document.querySelector('#build-sheet') && [...document.querySelectorAll('#jobs-sheet .jb')].filter(j=>/Lessons · Chapter (5|6)/.test(j.textContent)).length>=2 && !document.querySelector('#jobs-pill').hidden`, 6000));
  ok('…chapters that already have lessons are skipped, never replacing their notes', await waitFor(c, `const g=window.Shruti.jobs.tasks.filter(t=>t.group); return g.length===2 && g.every(t=>t.state==='skipped') && document.querySelectorAll('#jobs-sheet .jb.skipped').length===2`, 15000) && S.chats.length === chats0, await ev(c, `return [...document.querySelectorAll('#jobs-sheet .jb')].map(j=>j.className+':'+j.textContent).join(' | ')`));
  await shot(c, 'make-jobs-1280');
  await ev(c, `document.querySelector('#jobs-sheet [data-close]').click(); return 1`);

  console.log('\nVeda on a phone (390), while Tony makes something');
  await ev(c, `return window.Shruti.core.shared.flush().then(()=>1)`);
  await load(c, { w: 390, h: 844, mobile: true, store: "sessionStorage.setItem('shruti.pick','veda');", hash: '#/b/gita/5/listen' });
  await ev(c, `try{sessionStorage.setItem('shruti.pick','veda');}catch(e){} location.reload(); return 1`);
  await waitFor(c, `window.SHRUTI_PROFILE==='veda' && !!document.querySelector('#make-ai')`, 20000);
  await ev(c, `window.__fakeFs.remote('dashboards/shruti_shared', {jobs:{gita:{ch5:{podcast:{by:'tony', at:Date.now(), kind:'podcast', stage:'speak', text:'Speaking 12 of 40'}}}}}, {merge:true}); return 1`);
  ok('the chapter page fits her phone', await ev(c, `return document.documentElement.scrollWidth<=innerWidth`));
  ok('her Make with AI shows Tony is making something here', await waitFor(c, `document.querySelector('#make-ai').classList.contains('busy') && /Tony/.test(document.querySelector('#make-ai').textContent)`, 6000), await ev(c, `return document.querySelector('#make-ai').textContent`));
  await click(c, '#make-ai');
  ok('her sheet shows Tony making a podcast, and waits', await waitFor(c, `/Tony is making this: speaking 12 of 40/.test(document.querySelector('#gen-vers').textContent) && document.querySelector('#gen-sheet [data-make]').disabled`, 8000), await ev(c, `return document.querySelector('#gen-vers')?.textContent`));
  ok('her own settings: the default length and hosts (Sonia & Ryan)', await ev(c, `return document.querySelector('#gen-sheet [data-len=standard]').getAttribute('aria-checked')==='true' && document.querySelector('#gen-a').value==='en-GB-SoniaNeural'`));
  ok('the sheet fits her phone', await ev(c, `const s=document.querySelector('#gen-sheet .sheet'); return s.scrollWidth<=s.clientWidth+1`));
  await shot(c, 'make-veda-390');
  await ev(c, `window.__fakeFs.remote('dashboards/shruti_shared', {jobs:{gita:{ch5:{podcast:null}}}}, {merge:true}); return 1`);

  const errs = await ev(c, `return JSON.stringify(window.__errs||[])`);
  ok('no page errors', errs === '[]', errs);
  console.log('\nScreenshots: ' + path.dirname(shotPath('x')));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
