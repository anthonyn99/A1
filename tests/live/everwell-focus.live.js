// Everwell Phase 7 (A1-Priv/everwell.html): the Focus tab, and the shared
// EWMedia board under it and Mindset. Real page, fake Firestore, fake lock
// worker, and a FAKE YouTube player: the embed URL is answered with a page that
// speaks the widget postMessage protocol, so a removed or embed-blocked video
// reports its error exactly the way the real one does.
//
// Run: node tests/live/everwell-focus.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const BASE = 'https://anthonyn99.github.io/A1/';
const PAGE = BASE + 'everwell.html';
const recs = {};
const media = [];   // every request to a media host
// The fake player: answers "listening" with onError <code>, or with
// infoDelivery for a good video.
const CODES = { blockedvid1: 150, removedvid1: 100 };
// A good one also obeys Everwell's controls (play / pause / seek) and reports
// back like the real player (infoDelivery). A LIVE one (livestream1) reports
// what a real live did (2026-10-20, Al Jazeera's): videoData.isLive, a clock
// and duration of the stream's whole age (~82 days of seconds), and the 12-hour
// window YouTube keeps in progressState, whose end moves with the wall clock.
const player = (code, live) => `<!doctype html><title>fake player</title><script>
var LIVE = ${live ? 'true' : 'false'}, T0 = 7143229.9;
var st = LIVE ? { playerState: 1, currentTime: T0, duration: T0 + 3600, muted: false, videoData: { video_id: 'livestream1', title: 'Live', isLive: true },
  progressState: { seekableStart: T0 - 43189, seekableEnd: T0, isAtLiveHead: true, allowSeeking: true } }
  : { playerState: 1, currentTime: 0, duration: 120, muted: false }, heard = false, ad = false;
// Like the real player, it reports its clock several times a second while playing.
setInterval(function(){
  if (LIVE && heard) st.progressState.seekableEnd += 0.25;
  if (!heard || st.playerState !== 1 || ad) return; st.currentTime = Math.min(st.duration, st.currentTime + 0.25);
  parent.postMessage(JSON.stringify({ event: 'infoDelivery', info: LIVE ? { currentTime: st.currentTime, progressState: st.progressState } : { currentTime: st.currentTime } }), '*'); }, 250);
addEventListener('message', function(e){ var d; try { d = JSON.parse(e.data); } catch (x) { return; }
  if (d.event === 'command') {
    if (d.func === 'pauseVideo') st.playerState = 2; if (d.func === 'playVideo') st.playerState = 1;
    if (d.func === 'seekTo') st.currentTime = d.args[0]; if (d.func === 'mute') st.muted = true; if (d.func === 'unMute') st.muted = false;
    if (d.func === 'testAd') ad = !!d.args[0];   // the test: an ad runs (the video's clock stands still)
    parent.postMessage(JSON.stringify({ event: 'infoDelivery', info: st }), '*'); return;
  }
  if (d.event !== 'listening') return;
  heard = true;
  parent.postMessage(JSON.stringify(${code ? `{ event: 'onError', info: ${code} }` : `{ event: 'infoDelivery', info: st }`}), '*'); });
</script>`;
// A short silent WAV whose every byte is ASCII (the mock sends text as UTF-8):
// 16-bit mono at 4112 Hz, 4096 data bytes of zeros.
const le = (n, w) => { let s = ''; for (let i = 0; i < w; i++) s += String.fromCharCode((n >> (8 * i)) & 255); return s; };
const WAV = 'RIFF' + le(36 + 4096, 4) + 'WAVEfmt ' + le(16, 4) + le(1, 2) + le(1, 2) + le(4112, 4) + le(8224, 4) + le(2, 2) + le(16, 2) + 'data' + le(4096, 4) + '\0'.repeat(4096);
const lists = [];   // playlists asked of personal-ai /yt/playlist
const freshAsks = [];   // ...of them, past its cache (&fresh=1: the Refresh button)
const PLAYLISTS = { PLgoodlist01: [{ id: 'listvideo01', title: 'One' }, { id: 'listvideo02', title: 'Two' }, { id: 'blockedvid1', title: 'Three' }] };
const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://www.youtube-nocookie.com/*', 'https://i.ytimg.com/*', 'https://audio.test/*', 'https://example.com/*', 'https://www.instagram.com/*', 'https://personal-ai.av1.workers.dev/*'],
  handle(req) {
    const u = new URL(req.url);
    if (u.hostname === 'personal-ai.av1.workers.dev') {
      if (u.pathname !== '/yt/playlist') return { json: { ok: false, error: 'unavailable' } };   // the quote: use the local line
      const id = u.searchParams.get('list'); lists.push(id); if (u.searchParams.get('fresh') === '1') freshAsks.push(id);
      return { json: PLAYLISTS[id] ? { ok: true, list: id, title: 'x', videos: PLAYLISTS[id], more: false } : { ok: false, error: 'unavailable' } };
    }
    if (u.hostname !== 'taskhub-reminders.av1.workers.dev') {
      if (/^(www\.youtube-nocookie\.com|i\.ytimg\.com|audio\.test|example\.com|www\.instagram\.com)$/.test(u.hostname)) media.push(req.url);
      if (u.hostname === 'www.youtube-nocookie.com') { const id = u.pathname.split('/').pop(); return { text: player(CODES[id], id === 'livestream1'), type: 'text/html' }; }
      if (u.pathname === '/rain.wav') return { text: WAV, type: 'audio/wav' };
      if (u.hostname === 'audio.test') return { status: 404, text: 'not found', type: 'text/plain' };
      return null;   // thumbnails and the rest: refused, as if offline
    }
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const p = u.pathname, b = req.postData ? JSON.parse(req.postData) : {};
    if (p === '/auth/journal/status-many') { const out = {}; (b.locks || []).forEach((l) => { const k = l.journal + ':' + l.entryId; out[k] = { hasLock: !!recs[k], ver: recs[k] ? 'v1' : null }; }); return { json: { ok: true, locks: out } }; }
    if (p === '/auth/journal/verify') { const r = recs[b.journal + ':' + b.entryId]; return { json: r ? { ok: r === b.password } : { ok: false, noLock: true } }; }
    return { json: { ok: true } };
  },
};

(async () => {
  const c = await connect({ mock: firebaseMock(mock) });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || '').slice(0, 300)); });
  const js = (e) => evalJs(c, e);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const fresh = async (seed) => {
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(300);
    await js(`localStorage.clear(); sessionStorage.clear(); ${seed || ''} return 1;`);
    await c.send('Page.navigate', { url: PAGE }); await sleep(2800);
  };
  const tile = (n) => `document.querySelector('#focus-grid .media-tile:nth-child(${n})')`;
  const msg = (n) => js(`const m = ${tile(n)}.querySelector('.media-msg'); return m ? m.dataset.msg + '|' + m.textContent : '';`);
  const net = (offline) => c.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  console.log('\nFocus, empty');
  await fresh(`sessionStorage.setItem('ew.skipIntro', '1');`);
  await js(`document.getElementById('ew-intro-overlay') && document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1200);
  await js(`EWApp.go('focus'); return 1;`); await sleep(900);
  ok('Focus renders its board (no "coming soon" card)', await js(`return !!document.getElementById('focus-add') && !!document.getElementById('focus-grid') && !document.querySelector('#ew-body-focus .ew-soon');`));
  ok('the empty board says what it takes', /audio file or stream link/.test(await js(`return document.getElementById('focus-grid').textContent;`)));

  console.log('\nAdding');
  const add = async (url, title) => { await js(`document.getElementById('focus-url').value = ${JSON.stringify(url)}; document.getElementById('focus-title').value = ${JSON.stringify(title || '')}; document.getElementById('focus-add').requestSubmit(); return 1;`); await sleep(300); };
  await add('https://example.com/page.html');
  ok('a link that is not video, reel or audio is refused', /not a YouTube, Instagram or audio/.test(await js(`return document.getElementById('focus-err').textContent;`)));
  await add('https://audio.test/rain.wav', 'Rain');
  await add('https://audio.test/missing.mp3', 'Broken stream');
  await add('https://www.youtube.com/watch?v=removedvid1', 'Removed');
  await add('https://www.youtube.com/watch?v=blockedvid1', 'Blocked');
  await add('https://www.youtube.com/watch?v=goodvideo01', 'Good');
  await add('https://www.youtube.com/watch?v=goodvideo01');
  ok('a duplicate is refused', /already here/.test(await js(`return document.getElementById('focus-err').textContent;`)));
  await add('', '');
  ok('Enter on empty boxes does nothing: no error, nothing added (Tony, 2026-10-15)', await js(`return document.getElementById('focus-err').textContent === '' && document.querySelectorAll('#focus-grid .media-tile').length === 5;`),
    await js(`return document.getElementById('focus-err').textContent;`));
  await add('   ', 'Only a title');
  ok('…a blank link with a title typed is ignored the same way', await js(`return document.getElementById('focus-err').textContent === '' && document.querySelectorAll('#focus-grid .media-tile').length === 5;`));
  await js(`document.getElementById('focus-title').value = ''; return 1;`);
  ok('the link and title boxes each get a clear x once they hold text (typed or pasted)', await js(`const u = document.getElementById('focus-url'), t = document.getElementById('focus-title'); u.value = 'https://pasted.example/x'; u.dispatchEvent(new Event('input', { bubbles: true })); return !!u.closest('.ew-clr') && !!t.closest('.ew-clr') && u.closest('.ew-clr').classList.contains('has');`));
  await js(`document.getElementById('focus-url').closest('.ew-clr').querySelector('.ew-clr-x').click(); return 1;`); await sleep(200);
  ok('…and the x clears it', await js(`return document.getElementById('focus-url').value === '' && !document.getElementById('focus-url').closest('.ew-clr').classList.contains('has');`));
  ok('five tiles, newest first; the two audio tiles are short audio tiles', await js(`const t = [...document.querySelectorAll('#focus-grid .media-tile')]; return t.length === 5 && t[0].querySelector('.t').textContent === 'Good' && t.filter(x => x.dataset.kind === 'audio' && x.querySelector('.media-frame.audio')).length === 2;`));
  ok('nothing plays on open', await js(`return !document.querySelector('#focus-grid iframe, #focus-grid audio');`));
  ok('every tile has an "open on the site" link (new tab, no opener)', await js(`return [...document.querySelectorAll('#focus-grid .media-meta a')].length === 5 && [...document.querySelectorAll('#focus-grid .media-meta a')].every(a => a.target === '_blank' && /noopener/.test(a.rel));`));
  await sleep(1500);
  ok('saved as its own field, focusMedia (Mindset\'s list untouched)', await js(`const d = __fakeFs.docs['dashboards/everwell_tony'] || {}; return (d.focusMedia || []).length === 5 && !d.mindsetMedia;`), await js(`return JSON.stringify(__fakeFs.docs['dashboards/everwell_tony']);`));

  console.log('\nRenaming (Tony, 2026-10-15)');
  const rnTile = (name) => `[...document.querySelectorAll('#focus-grid .media-tile')].find(t => t.querySelector('.t').textContent === ${JSON.stringify(name)})`;
  ok('every tile has a Rename button beside Remove', await js(`return [...document.querySelectorAll('#focus-grid .media-tile')].every(t => !!t.querySelector('[data-rename]') && t.querySelector('[data-rename]').nextElementSibling.matches('.rm'));`));
  await js(`${rnTile('Rain')}.querySelector('[data-rename]').click(); return 1;`); await sleep(400);
  ok('Rename asks in the in-page dialog, filled with the current name, no field focused', await js(`const i = document.querySelector('#uim-fields input'); return !!i && i.value === 'Rain' && document.activeElement !== i;`));
  await js(`document.querySelector('#uim-fields input').value = '  Rain at night  '; document.getElementById('uim-ok').click(); return 1;`); await sleep(1500);
  ok('the tile takes the new name (trimmed), and it is saved', await js(`const t = ${rnTile('Rain at night')}; const d = (__fakeFs.docs['dashboards/everwell_tony'] || {}).focusMedia || [];
    return !!t && t.dataset.named === '1' && d.some(x => x.title === 'Rain at night' && x.url === 'https://audio.test/rain.wav') && document.querySelectorAll('#focus-grid .media-tile').length === 5;`),
    await js(`return JSON.stringify(((__fakeFs.docs['dashboards/everwell_tony'] || {}).focusMedia || []).map(x => x.title));`));
  await js(`${rnTile('Rain at night')}.querySelector('[data-rename]').click(); return 1;`); await sleep(400);
  await js(`document.querySelector('#uim-fields input').value = ''; document.getElementById('uim-ok').click(); return 1;`); await sleep(1500);
  ok('an empty name goes back to the link\'s own label', await js(`const d = (__fakeFs.docs['dashboards/everwell_tony'] || {}).focusMedia || []; const it = d.find(x => x.url === 'https://audio.test/rain.wav');
    const t = [...document.querySelectorAll('#focus-grid .media-tile')].find(t => t.dataset.id === it.id); return it.title === '' && !!t && t.querySelector('.t').textContent === t.querySelector('.k').textContent && !t.dataset.named;`));
  await js(`${rnTile('Good')}.querySelector('[data-rename]').click(); return 1;`); await sleep(400);
  await js(`document.querySelector('#uim-fields input').value = 'Changed my mind'; document.getElementById('uim-cancel') ? document.getElementById('uim-cancel').click() : document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;`); await sleep(800);
  ok('Cancel keeps the name', await js(`return !!${rnTile('Good')};`));
  // Back to "Rain" for the tests below (found by its link: its name is the label now).
  await js(`const it = __fakeFs.docs['dashboards/everwell_tony'].focusMedia.find(x => x.url === 'https://audio.test/rain.wav');
    document.querySelector('#focus-grid .media-tile[data-id="' + it.id + '"] [data-rename]').click(); return 1;`); await sleep(400);
  await js(`document.querySelector('#uim-fields input').value = 'Rain'; document.getElementById('uim-ok').click(); return 1;`); await sleep(1200);
  ok('…and renamed back', await js(`return !!${rnTile('Rain')};`));
  ok('a failed thumbnail (offline / blocked) leaves placeholder art, not a black box', await js(`return !document.querySelector('#focus-grid img') && document.querySelectorAll('#focus-grid .media-ph').length === 5;`));

  console.log('\nPlaying');
  await js(`${tile(1)}.querySelector('[data-play]').click(); return 1;`); await sleep(1500);
  ok('a tap plays it through youtube-nocookie with autoplay and the error channel', await js(`const f = ${tile(1)}.querySelector('iframe'); return !!f && /^https:\\/\\/www\\.youtube-nocookie\\.com\\/embed\\/goodvideo01\\?autoplay=1&.*enablejsapi=1/.test(f.src);`));
  ok('the playing video takes two columns, and offers only Stop and Open', await js(`const t = ${tile(1)}, w = t.getBoundingClientRect().width, o = ${tile(2)}.getBoundingClientRect().width;
    return t.classList.contains('playing') && w > o * 1.9 && !!t.querySelector('[data-stop]') && !t.querySelector('[data-rm], [data-expand]') && !!t.querySelector('.media-meta a');`));
  ok('the tile buttons are small and quiet (28px, no box until hovered)', await js(`const b = ${tile(2)}.querySelector('[data-rm]'), s = getComputedStyle(b); return b.offsetWidth === 28 && s.borderTopColor === 'rgba(0, 0, 0, 0)';`),
    await js(`const b = ${tile(2)}.querySelector('[data-rm]'); return b.offsetWidth + ' ' + getComputedStyle(b).borderTopColor;`));
  ok('a good video keeps playing (its messages are not errors)', await js(`return EWFocus.playing() !== null && !!${tile(1)}.querySelector('iframe');`));
  // Light on a busy PC (Tony, 2026-10-13): over 3 s of play with the controls up
  // (12 reports from the player), no button is redrawn and the bar is not drawn
  // every frame (a 2:00 video moves its bar about a pixel every 0.2 s).
  const cost = JSON.parse(await js(`const f = ${tile(1)}.querySelector('.media-frame'); let icons = 0, frames = 0, stop = false;
    const mo = new MutationObserver((l) => l.forEach((m) => { if (m.type === 'childList' && m.target.closest && m.target.closest('.vp-b, .vp-mid')) icons++; }));
    mo.observe(f, { childList: true, subtree: true });
    const raf0 = window.requestAnimationFrame; window.requestAnimationFrame = (cb) => raf0((t) => { frames++; cb(t); });
    const keep = setInterval(() => f.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })), 400);
    await new Promise((r) => setTimeout(r, 3000)); clearInterval(keep); mo.disconnect(); window.requestAnimationFrame = raf0;
    return JSON.stringify({ icons, frames, on: f.classList.contains('ui-on'), time: f.querySelector('[data-vp-time]').textContent });`));
  ok('while it plays, no button icon is redrawn and the controls are not drawn every frame', cost.on && cost.icons === 0 && cost.frames < 90, JSON.stringify(cost));

  console.log('\nThe player\'s own controls');
  ok("YouTube's controls are off (controls=0); Everwell draws its own over the video", await js(`const t = ${tile(1)}; return /controls=0/.test(t.querySelector('iframe').src) && !!t.querySelector('.vp-ui [data-vp="toggle"]') && !!t.querySelector('[data-vp-seek]') && !!t.querySelector('[data-vp="fill"]') && !!t.querySelector('[data-vp="fs"]');`));
  ok("YouTube's own chrome is hidden: the player is cut taller than the tile (title bar and logo fall outside)", await js(`const f = ${tile(1)}.querySelector('.media-frame').getBoundingClientRect(), i = ${tile(1)}.querySelector('iframe').getBoundingClientRect();
    return i.top <= f.top - 60 && i.bottom >= f.bottom + 60 && getComputedStyle(${tile(1)}.querySelector('.media-frame')).overflow === 'hidden';`));
  ok('…and a cover with the video\'s thumbnail sits over it whenever it is not playing', await js(`const p = ${tile(1)}.querySelector('[data-vp-poster]'); return !!p && p.style.backgroundImage.indexOf('i.ytimg.com/vi/goodvideo01/hqdefault') >= 0 && getComputedStyle(p).opacity === '0';`));
  ok('…showing the time from the player (0:00 / 2:00)', /0:0\d \/ 2:00/.test(await js(`return ${tile(1)}.querySelector('[data-vp-time]').textContent;`)), await js(`return ${tile(1)}.querySelector('[data-vp-time]').textContent;`));
  const fr = () => js(`const f = ${tile(1)}.querySelector('.media-frame'); return JSON.stringify({ on: f.classList.contains('ui-on'), idle: f.classList.contains('idle'), op: getComputedStyle(f.querySelector('.vp-ui')).opacity, tr: getComputedStyle(f.querySelector('.vp-ui')).transitionDuration });`).then(JSON.parse);
  let v = await js(`const r = ${tile(1)}.querySelector('.media-frame').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 3, r: r.right, b: r.bottom });`).then(JSON.parse);
  const mm = (type, x, y, extra) => c.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'none', buttons: 0 }, extra || {}));
  await mm('mouseMoved', v.x, v.y); await sleep(250); await mm('mouseMoved', v.x + 6, v.y + 4); await sleep(250);
  let u = await fr();
  ok('moving the cursor over the video brings the controls up (a quick fade in)', u.on && parseFloat(u.tr) <= 0.2, JSON.stringify(u));
  await sleep(3000);
  u = await fr();
  ok('…they FADE out (0.6s) once the cursor rests, never just vanish', !u.on && u.idle && parseFloat(u.tr) >= 0.5, JSON.stringify(u));
  await mm('mouseMoved', v.x, v.y); await sleep(200);
  await mm('mouseMoved', v.r + 40, v.b + 40); await sleep(300);
  u = await fr();
  ok('…and fade out as soon as the cursor leaves the video', !u.on && parseFloat(u.tr) >= 0.5, JSON.stringify(u));
  await js(`${tile(1)}.querySelector('.vp-row [data-vp="toggle"]').click(); return 1;`); await sleep(500);
  ok('Pause pauses the video (the player says so) and the controls stay up while paused', await js(`const f = ${tile(1)}.querySelector('.media-frame'); return f.classList.contains('paused') && getComputedStyle(f.querySelector('.vp-ui')).opacity === '1';`));
  ok("…and the cover hides YouTube's pause screen (only Everwell's controls show)", await js(`return getComputedStyle(${tile(1)}.querySelector('[data-vp-poster]')).opacity === '1';`));
  await js(`${tile(1)}.querySelector('.vp-row [data-vp="toggle"]').click(); return 1;`); await sleep(500);
  ok('…and Play plays it again', await js(`return !${tile(1)}.querySelector('.media-frame').classList.contains('paused');`));
  // Lighter controls (Tony, 2026-10-12: the cursor lagged while a video played): the dot moves by transform, nothing redraws while they are hidden.
  ok('the seek dot moves by transform (no layout), from a measured track', await js(`const k = ${tile(1)}.querySelector('.vp-knob'); return k.style.left === '' && /px$/.test(k.style.getPropertyValue('--kx'));`));
  // The "now playing" pill plays and pauses it from another tab.
  await js(`EWApp.go('dashboard'); return 1;`); await sleep(500);
  ok('the "now playing" pill has play/pause', await js(`const b = document.getElementById('ew-now-pp'); return !!b && !b.hidden && b.getAttribute('aria-label') === 'Pause';`));
  await js(`document.getElementById('ew-now-pp').click(); return 1;`); await sleep(500);
  ok('…which pauses it (the pill says Paused, its button turns to Play)', await js(`return document.getElementById('ew-now').classList.contains('paused') && document.getElementById('ew-now-pp').getAttribute('aria-label') === 'Play' && EWMedia.now().paused === true;`));
  ok('…and the backdrop is not slowed while nothing plays', await js(`return EWBackdrop.quiet() === false;`));
  await js(`document.getElementById('ew-now-pp').click(); return 1;`); await sleep(500);
  ok('…and plays it again; the backdrop rests while it plays', await js(`return !document.getElementById('ew-now').classList.contains('paused') && EWMedia.now().paused === false && EWBackdrop.quiet() === true;`));
  await js(`EWApp.go('focus'); return 1;`); await sleep(500);
  // Ads (Tony, 2026-10-12): YouTube's Skip button sits under Everwell's layers, so they must step aside.
  const adState = () => js(`const f = ${tile(1)}.querySelector('.media-frame'), hit = f.querySelector('[data-vp-hit]'), r = f.getBoundingClientRect();
    return JSON.stringify({ ad: f.classList.contains('ad'), hit: getComputedStyle(hit).pointerEvents, top: (document.elementFromPoint(r.right - 60, r.bottom - 70) || {}).tagName,
      mid: (document.elementFromPoint(r.left + r.width * 0.35, r.top + r.height * 0.4) || {}).tagName });`).then(JSON.parse);
  let ad = await adState();
  ok('playing normally (the clock moves), Everwell\'s layers take the clicks', !ad.ad && ad.hit !== 'none' && ad.top !== 'IFRAME', JSON.stringify(ad));
  await js(`${tile(1)}.querySelector('iframe').contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'testAd', args: [true] }), '*'); return 1;`); await sleep(3600);
  ad = await adState();
  // Only a hole over YouTube's Skip corner (Tony, 2026-10-12): elsewhere YouTube never sees the mouse, so its own buttons never show under Everwell's.
  ok("an ad (playing, the clock stands still): the bottom-right corner reaches YouTube's Skip, everywhere else stays Everwell's", ad.ad && ad.top === 'IFRAME' && ad.mid !== 'IFRAME' &&
    await js(`const f = ${tile(1)}.querySelector('.media-frame'); return getComputedStyle(f.querySelector('.vp-bar')).opacity === '0' && getComputedStyle(f.querySelector('[data-vp-poster]')).opacity === '0';`), JSON.stringify(ad));
  // A click on YouTube's Skip moves the focus into the iframe (Tony, 2026-10-12: YouTube's own buttons stayed instead of Everwell's).
  await js(`window.focus(); ${tile(1)}.querySelector('iframe').focus(); return 1;`); await sleep(1700);
  ad = await adState();
  ok("a click into YouTube (its Skip) hands the player back to Everwell's controls a moment later", !ad.ad && ad.hit !== 'none' && ad.top !== 'IFRAME', JSON.stringify(ad));
  await sleep(3000);
  ok('…and an ad still running (clock frozen) steps them aside again', (await adState()).ad);
  await js(`${tile(1)}.querySelector('iframe').contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'testAd', args: [false] }), '*'); return 1;`); await sleep(1500);
  ad = await adState();
  ok('…and once the video\'s clock moves again, Everwell\'s controls are back', !ad.ad && ad.hit !== 'none' && ad.top !== 'IFRAME', JSON.stringify(ad));
  await js(`${tile(1)}.querySelector('[data-vp="ad"]').click(); return 1;`); await sleep(300);
  ad = await adState();
  ok('the ad button hands the player to YouTube by hand (any ad that keeps its own clock)', ad.ad && ad.top === 'IFRAME', JSON.stringify(ad));
  await sleep(2000);
  ok('…and it stays handed over while the clock runs (until its 20 seconds are up)', (await adState()).ad);
  await js(`${tile(1)}.querySelector('[data-vp-hit]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true })); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true })); return 1;`); await sleep(400);
  ad = await adState();
  ok('…or until Everwell\'s own play/pause is used (K pauses, K plays): the controls take it back', !ad.ad && ad.top !== 'IFRAME', JSON.stringify(ad));
  await js(`${tile(1)}.querySelector('[data-vp="fill"]').click(); return 1;`); await sleep(600);
  ok('"Fill the window": the video covers the whole browser window, not the screen', await js(`const t = ${tile(1)}, r = t.querySelector('.media-frame').getBoundingClientRect();
    return t.classList.contains('filled') && !document.fullscreenElement && Math.round(r.left) === 0 && Math.round(r.top) === 0 && Math.round(r.width) === innerWidth && Math.round(r.height) === innerHeight &&
      document.elementFromPoint(innerWidth / 2, 10).closest('.media-tile') === t;`), await js(`const r = ${tile(1)}.querySelector('.media-frame').getBoundingClientRect(); return JSON.stringify(r) + ' ' + innerWidth + 'x' + innerHeight;`));
  ok('…the same iframe keeps playing (nothing reloaded)', await js(`return !!${tile(1)}.querySelector('iframe') && EWFocus.playing() !== null;`));
  // A phone's Back swipe (Android, iOS) exits the fill, never the page (Tony, 2026-10-11).
  ok('filling the window adds one history entry at the same address', await js(`return !!history.state && history.state.ewLayer === 1 && location.pathname.endsWith('/everwell.html') && !location.hash;`));
  await js(`history.back(); return 1;`); await sleep(700);
  ok('Back (the swipe) exits the fill and stays in Everwell, still playing', await js(`return !${tile(1)}.classList.contains('filled') && !document.documentElement.classList.contains('vp-lock') && /everwell\.html$/.test(location.pathname) && EWFocus.playing() !== null;`));
  await js(`${tile(1)}.querySelector('[data-vp="fill"]').click(); return 1;`); await sleep(500);
  await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;`); await sleep(400);
  ok('Escape puts it back in its tile', await js(`return !history.state || !history.state.ewLayer;`) && await js(`return !${tile(1)}.classList.contains('filled') && !document.documentElement.classList.contains('vp-lock');`));
  await js(`${tile(1)}.querySelector('[data-vp-hit]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true })); return 1;`); await sleep(400);
  ok('T fills the window from the keyboard', await js(`return ${tile(1)}.classList.contains('filled');`));
  await js(`EWApp.go('goals'); return 1;`); await sleep(400);
  ok('switching tabs takes it back into its tile, still playing', await js(`return !document.querySelector('.media-tile.filled') && EWFocus.playing() !== null;`));
  await js(`EWApp.go('focus'); return 1;`); await sleep(400);
  v = await js(`const r = ${tile(1)}.querySelector('[data-vp-seek]').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width * 0.5, y: r.top + r.height / 2 });`).then(JSON.parse);
  await mm('mouseMoved', v.x, v.y - 40); await sleep(150);
  await mm('mousePressed', v.x, v.y, { button: 'left', buttons: 1, clickCount: 1 }); await mm('mouseReleased', v.x, v.y, { button: 'left', buttons: 0, clickCount: 1 }); await sleep(500);
  ok('clicking the middle of the seek bar seeks to 1:00', /^1:0\d \/ 2:00$/.test(await js(`return ${tile(1)}.querySelector('[data-vp-time]').textContent;`)), await js(`return ${tile(1)}.querySelector('[data-vp-time]').textContent;`));
  await add('https://www.youtube.com/watch?v=abcdefghijk', 'Added while playing');
  ok('adding while one plays does not restart it (the player stays put)', await js(`return document.querySelectorAll('#focus-grid .media-tile').length === 6 && ${tile(2)}.querySelector('.t').textContent === 'Good' && !!${tile(2)}.querySelector('iframe');`));
  await js(`${tile(1)}.querySelector('[data-rm]').click(); return 1;`); await sleep(300);
  ok('remove asks first, in the page (title, name, red Remove)', await js(`return document.getElementById('uim-overlay').classList.contains('show') && document.getElementById('uim-title').textContent === 'Remove video?' &&
    /“Added while playing” leaves Focus on every device/.test(document.getElementById('uim-msg').textContent) && document.getElementById('uim-ok').textContent === 'Remove';`));
  await js(`document.getElementById('uim-cancel').click(); return 1;`); await sleep(300);
  ok('Cancel keeps it', await js(`return document.querySelectorAll('#focus-grid .media-tile').length === 6;`));
  await js(`${tile(1)}.querySelector('[data-rm]').click(); return 1;`); await sleep(300);
  // A real tap: the press AND the click on the dim (a press that began in the
  // box and ended on the dim no longer closes a dialog, 2026-10-15).
  await js(`const ov = document.getElementById('uim-overlay'); ov.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); ov.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1;`); await sleep(300);
  ok('a tap on the backdrop cancels too', await js(`return !document.getElementById('uim-overlay').classList.contains('show') && document.querySelectorAll('#focus-grid .media-tile').length === 6;`));
  await js(`${tile(1)}.querySelector('[data-rm]').click(); return 1;`); await sleep(300);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;`); await sleep(300);
  ok('Escape cancels', await js(`return !document.getElementById('uim-overlay').classList.contains('show') && document.querySelectorAll('#focus-grid .media-tile').length === 6;`));
  await js(`${tile(1)}.querySelector('[data-rm]').click(); return 1;`); await sleep(300);
  await js(`document.getElementById('uim-ok').click(); return 1;`); await sleep(400);
  ok('removing another tile while one plays leaves the player alone', await js(`return document.querySelectorAll('#focus-grid .media-tile').length === 5 && !!${tile(1)}.querySelector('iframe');`));

  console.log('\nFailures are shown');
  await js(`${tile(2)}.querySelector('[data-play]').click(); return 1;`); await sleep(1800);
  ok('embed-blocked (150): the player closes and the tile says so, with a link to YouTube', /^blocked\|YouTube will not play this one here.*Open on YouTube/.test(await msg(2)) && await js(`return !document.querySelector('#focus-grid iframe') && EWFocus.playing() === null;`), await msg(2));
  await js(`${tile(3)}.querySelector('[data-play]').click(); return 1;`); await sleep(1800);
  ok('removed (100): "unavailable: removed or made private"', /^gone\|.*removed or made private/.test(await msg(3)), await msg(3));
  ok('…and the earlier message stays on its own tile', /^blocked/.test(await msg(2)));
  await js(`${tile(4)}.querySelector('[data-play]').click(); return 1;`); await sleep(1800);
  ok('a broken audio link: the tile says it could not play', /^error\|This audio could not play/.test(await msg(4)), await msg(4));
  await js(`${tile(5)}.querySelector('[data-play]').click(); return 1;`); await sleep(1500);
  ok('a working audio link plays in an <audio> with controls, looping', await js(`const a = ${tile(5)}.querySelector('audio'); return !!a && a.controls && a.loop && !a.error && /rain\\.wav$/.test(a.src);`), await js(`const a = ${tile(5)}.querySelector('audio'); return a ? String(a.error && a.error.code) : 'none';`));
  ok('one at a time: only the audio is live', await js(`return document.querySelectorAll('#focus-grid iframe, #focus-grid audio').length === 1;`));

  console.log('\nOffline');
  await net(true); await sleep(500);
  ok('going offline while playing says so on the live tile (no restart)', /^lost\|/.test(await msg(5)) && await js(`return !!${tile(5)}.querySelector('audio');`), await msg(5));
  await js(`${tile(1)}.querySelector('[data-play]').click(); return 1;`); await sleep(500);
  ok('an offline tap makes no player and says "You are offline"', /^offline\|You are offline/.test(await msg(1)) && await js(`return !document.querySelector('#focus-grid iframe');`), await msg(1));
  await net(false); await sleep(500);
  ok('back online, the offline note clears', (await msg(1)) === '');

  console.log('\nLeaving and locking');
  await js(`${tile(1)}.querySelector('[data-play]').click(); return 1;`); await sleep(800);
  await js(`EWApp.go('goals'); return 1;`); await sleep(500);
  ok('leaving Focus KEEPS it playing (Tony, 2026-10-11), and the pill says so', await js(`return !!document.querySelector('#focus-grid iframe') && EWFocus.playing() !== null && document.getElementById('ew-now').classList.contains('on') && /Playing in Focus/.test(document.getElementById('ew-now').textContent);`));
  await js(`EWApp.go('focus'); return 1;`); await sleep(600);
  ok('coming back, it is still the same player', await js(`return !!document.querySelector('#focus-grid iframe') && !document.getElementById('ew-now').classList.contains('on');`));
  await js(`document.querySelector('#focus-grid [data-stop]').click(); return 1;`); await sleep(300);
  await js(`${tile(1)}.querySelector('[data-play]').click(); return 1;`); await sleep(800);
  await js(`EWApp.go('mindset'); return 1;`); await sleep(700);
  await js(`document.getElementById('media-url').value = 'https://youtu.be/blockedvid1'; document.getElementById('media-add').requestSubmit(); return 1;`); await sleep(300);
  await js(`document.getElementById('media-url').value = 'https://audio.test/rain.wav'; document.getElementById('media-add').requestSubmit(); return 1;`); await sleep(300);
  ok('Mindset takes no audio link', /not a YouTube or Instagram link/.test(await js(`return document.getElementById('media-err').textContent;`)));
  await js(`document.querySelector('#media-grid [data-play]').click(); return 1;`); await sleep(1800);
  ok('Mindset gets the same failure handling (embed-blocked shown)', /^blocked/.test(await js(`const m = document.querySelector('#media-grid .media-msg'); return m ? m.dataset.msg : '';`)));
  await js(`EWApp.go('focus'); return 1;`); await sleep(600);
  await js(`${tile(1)}.querySelector('[data-play]').click(); return 1;`); await sleep(800);
  recs['applock:tony_everwell_tab_focus'] = 'f';
  await js(`Guardian.refresh(['tony_everwell_tab_focus'], true); return 1;`); await sleep(1500);
  ok('a Focus lock stops it and empties the tab', await js(`const b = document.getElementById('ew-body-focus'); return b.dataset.state === 'locked' && !b.querySelector('iframe, audio, .media-tile') && EWFocus.playing() === null;`));
  delete recs['applock:tony_everwell_tab_focus'];

  console.log('\nPhone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
  await fresh(`sessionStorage.setItem('ew.skipIntro', '1'); sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/everwell_tony': { focusMedia: [{ id: 'a', url: 'https://audio.test/rain.wav', title: 'Rain' }, { id: 'b', url: 'https://youtube.com/shorts/ABCDEFGHIJK', title: 'A Short with a long title that has to be cut off somewhere' }] } }));`);
  await js(`document.getElementById('ew-intro-overlay') && document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1200);
  await js(`EWApp.go('focus'); return 1;`); await sleep(1200);
  ok('360px: one column, nothing wider than the screen', await js(`const g = document.getElementById('focus-grid'); return g.querySelectorAll('.media-tile').length === 2 && getComputedStyle(g).gridTemplateColumns.split(' ').length === 1 && document.documentElement.scrollWidth <= 360;`), await js(`return document.documentElement.scrollWidth + ' ' + getComputedStyle(document.getElementById('focus-grid')).gridTemplateColumns;`));
  ok('…the Short is tall but fits the screen', await js(`const f = document.querySelector('#focus-grid .media-tile.tall .media-frame').getBoundingClientRect(); return f.height <= innerHeight * 0.72 + 1 && f.width <= 360;`));
  await js(`document.querySelector('#focus-grid .media-tile [data-play]').click(); return 1;`); await sleep(800);
  ok('…and audio plays there too', await js(`return !!document.querySelector('#focus-grid audio');`));
  ok('…a playing tile stays one column wide on a phone (no sideways scroll)', await js(`const t = document.querySelector('.media-tile.playing'); return !!t && t.getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= 360;`));
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  console.log('\nExpand a playlist');
  await fresh(`sessionStorage.setItem('ew.skipIntro', '1'); sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/everwell_tony': { focusMedia: [
    { id: 'p1', url: 'https://www.youtube.com/playlist?list=PLgoodlist01', title: 'Study list' },
    { id: 'p2', url: 'https://www.youtube.com/playlist?list=PLbadlist001', title: 'Private list' },
    { id: 'v1', url: 'https://youtu.be/abcdefghijk', title: 'Plain video' }] } }));`);
  await js(`document.getElementById('ew-intro-overlay') && document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1200);
  await js(`EWApp.go('focus'); return 1;`); await sleep(1200);
  const q = (s) => `document.querySelector('${s}')`;
  ok('playlists get an Expand button; a plain video does not', await js(`return !!${q('[data-id="p1"] [data-expand]')} && !!${q('[data-id="p2"] [data-expand]')} && !${q('[data-id="v1"] [data-expand]')};`));
  await js(`${q('[data-id="p1"] [data-expand]')}.click(); return 1;`); await sleep(1200);
  ok('Expand lays each video out as its own tile, in a full-width group', await js(`const g = ${q('.media-group[data-id="p1"]')}; return !!g && g.querySelectorAll('.media-tile').length === 3 && /3 videos/.test(g.textContent) && getComputedStyle(g).gridColumnStart === '1';`),
    await js(`return document.getElementById('focus-grid').innerHTML.slice(0, 300);`));
  ok('…asking personal-ai /yt/playlist for that list', lists.includes('PLgoodlist01'), lists);
  await sleep(1500);
  ok('…and the expanded list is saved with the item (it syncs)', await js(`const p = __fakeFs.docs['dashboards/everwell_tony'].focusMedia.find(x => x.id === 'p1'); return p.expanded === true && p.videos.length === 3 && p.videos[1].id === 'listvideo02';`));
  await js(`${q('[data-id="p1~listvideo02"] [data-play]')}.click(); return 1;`); await sleep(1200);
  ok('a video in the group plays inside its playlist (the next one follows)', await js(`const f = ${q('[data-id="p1~listvideo02"] iframe')}; return !!f && /embed\\/listvideo02\\?.*&list=PLgoodlist01/.test(f.src);`));
  await js(`${q('[data-id="p1~blockedvid1"] [data-play]')}.click(); return 1;`); await sleep(1800);
  ok('one plays at a time, and a blocked one in the group shows its note', (await js(`const m = ${q('[data-id="p1~blockedvid1"] .media-msg')}; return m ? m.dataset.msg : '';`)) === 'blocked' && await js(`return !document.querySelector('#focus-grid iframe');`));
  ok('videos in a group have no remove button of their own', await js(`return !${q('.media-group .media-grid [data-rm]')};`));

  // An expanded playlist follows YouTube (Tony, 2026-10-11).
  const ORIG = PLAYLISTS.PLgoodlist01.slice();
  const tonyWrites = () => js(`return __fakeFs.log.filter(e => e.path === 'dashboards/everwell_tony').length;`);
  let w0 = await tonyWrites(), n0 = lists.length;
  await js(`EWFocus.resync(); return 1;`); await sleep(1200);
  ok('re-sync: an unchanged playlist is fetched again but writes nothing', lists.length === n0 + 1 && (await tonyWrites()) === w0, lists.length - n0 + ' fetch, ' + ((await tonyWrites()) - w0) + ' writes');
  PLAYLISTS.PLgoodlist01 = [{ id: 'listvideo00', title: 'New on YouTube' }].concat(ORIG.map((v) => v.id === 'listvideo02' ? { id: v.id, title: 'Two (renamed)' } : v));
  await js(`EWFocus.resync(); return 1;`); await sleep(1500);
  ok('re-sync: a video added on YouTube shows up first, a renamed one is renamed', await js(`const g = ${q('.media-group[data-id="p1"]')}; const t = [...g.querySelectorAll('.media-grid .media-tile')]; return t.length === 4 && t[0].dataset.id === 'p1~listvideo00' && /Two \\(renamed\\)/.test(t[2].textContent) && /4 videos/.test(g.textContent);`),
    await js(`return ${q('.media-group[data-id="p1"]')}.textContent.slice(0, 200);`));
  ok('…and is saved, so every device gets it', await js(`const p = __fakeFs.docs['dashboards/everwell_tony'].focusMedia.find(x => x.id === 'p1'); return p.videos.length === 4 && p.videos[0].id === 'listvideo00' && p.expanded === true;`));
  await js(`${q('[data-id="p1~listvideo01"] [data-play]')}.click(); return 1;`); await sleep(1000);
  await js(`window.__frame = ${q('[data-id="p1~listvideo01"] iframe')}; return 1;`);
  PLAYLISTS.PLgoodlist01 = ORIG.slice();
  await js(`EWFocus.resync(); return 1;`); await sleep(1500);
  ok('re-sync while a video in the group plays: the player is left alone', await js(`return EWFocus.playing() === 'p1~listvideo01' && ${q('[data-id="p1~listvideo01"] iframe')} === window.__frame && ${q('.media-group[data-id="p1"]')}.querySelectorAll('.media-grid .media-tile').length === 4;`));
  await js(`${q('[data-id="p1~listvideo01"] [data-stop]')}.click(); return 1;`); await sleep(1500);
  ok('…and catches up once it stops (the removed video goes)', await js(`return !${q('[data-id="p1~listvideo00"]')} && ${q('.media-group[data-id="p1"]')}.querySelectorAll('.media-grid .media-tile').length === 3;`));

  // Its videos drag to reorder, like an Instagram collection's covers (Tony, 2026-10-13).
  const order = () => js(`return [...${q('.media-group[data-id="p1"]')}.querySelectorAll('.media-grid .media-tile')].map(t => t.dataset.id.split('~')[1]).join();`);
  const saved = () => js(`const p = __fakeFs.docs['dashboards/everwell_tony'].focusMedia.find(x => x.id === 'p1'); return p.videos.map(v => v.id).join() + '|' + (p.order || []).join();`);
  const rect = (id) => js(`const r = ${q('[data-id="p1~' + id + '"] .media-meta .t')}.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });`).then(JSON.parse);
  const mouse = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const a = await rect('listvideo01'), b = await rect('blockedvid1');
  await mouse('mousePressed', a.x, a.y); await sleep(350);
  for (let i = 1; i <= 16; i++) { await mouse('mouseMoved', a.x + (b.x - a.x + 30) * i / 16, a.y + (b.y - a.y) * i / 16); await sleep(16); }
  await sleep(200); await mouse('mouseReleased', b.x + 30, b.y); await sleep(1800);
  ok('a playlist\'s videos drag to reorder', (await order()) === 'listvideo02,blockedvid1,listvideo01', await order());
  ok('…and Tony\'s order is saved with it', (await saved()) === 'listvideo02,blockedvid1,listvideo01|listvideo02,blockedvid1,listvideo01', await saved());
  PLAYLISTS.PLgoodlist01 = [{ id: 'listvideo00', title: 'New on YouTube' }].concat(ORIG);
  await js(`EWFocus.resync(); return 1;`); await sleep(1500);
  ok('re-sync keeps Tony\'s order, a video new on YouTube on top', (await order()) === 'listvideo00,listvideo02,blockedvid1,listvideo01', await order());
  await js(`${q('[data-id="p1~listvideo02"] [data-play]')}.click(); return 1;`); await sleep(1000);
  ok('a video then plays the rest in Tony\'s order, not YouTube\'s', await js(`const f = ${q('[data-id="p1~listvideo02"] iframe')}; return !!f && /embed\\/listvideo02\\?.*&playlist=blockedvid1,listvideo01$/.test(f.src) && !/&list=/.test(f.src);`),
    await js(`const f = ${q('[data-id="p1~listvideo02"] iframe')}; return f ? f.src : 'none';`));
  ok('…with the playlist\'s previous / next still on it', await js(`return !!${q('[data-id="p1~listvideo02"] [data-vp="next"]')};`));
  await js(`${q('[data-id="p1~listvideo02"] [data-stop]')}.click(); return 1;`); await sleep(500);

  // The Refresh button (Tony, 2026-10-20: a live he added on YouTube had not come in).
  const toastTxt = () => js(`const t = [...document.querySelectorAll('.toast')].pop(); return t ? t.textContent : '';`);
  ok('an expanded playlist has a Refresh button', await js(`const b = ${q('.media-group[data-id="p1"] .media-group-head [data-ytsync="p1"]')}; return !!b && /Refresh/.test(b.textContent);`));
  // On a phone the head's buttons sat over the title (Tony, 2026-10-20): they get a row of their own.
  const headFits = () => js(`const g = ${q('.media-group[data-id="p1"]')}, gr = g.getBoundingClientRect(), tr = g.querySelector('.media-group-title').getBoundingClientRect();
    const bs = [...g.querySelectorAll('.media-group-head .media-meta > *')].map(b => b.getBoundingClientRect());
    return bs.length === 5 && bs.every(b => b.top >= tr.bottom - 0.5 && b.right <= gr.right - 4 && b.left >= gr.left) && bs.every((b, i) => !i || b.left >= bs[i - 1].right) && document.documentElement.scrollWidth <= innerWidth;`);
  for (const w of [390, 360]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 2, mobile: true }); await sleep(500);
    ok(w + 'px: the playlist\'s buttons sit in their own row under the title, none overlapping or past the edge', await headFits());
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await sleep(500);
  PLAYLISTS.PLgoodlist01 = [{ id: 'livenew0001', title: 'A live added on YouTube' }, { id: 'listvideo00', title: 'New on YouTube' }].concat(ORIG);
  const f0 = freshAsks.length;
  await js(`${q('[data-ytsync="p1"]')}.click(); return 1;`); await sleep(1500);
  ok('Refresh asks personal-ai past its cache (&fresh=1)', freshAsks.length === f0 + 1 && freshAsks[f0] === 'PLgoodlist01', freshAsks);
  ok('...brings in what was added on YouTube, on top, and keeps Tony\'s order', (await order()) === 'livenew0001,listvideo00,listvideo02,blockedvid1,listvideo01', await order());
  ok('...and says so', /1 new video/.test(await toastTxt()), await toastTxt());
  ok('...saved with Tony\'s order intact', /^livenew0001,listvideo00,listvideo02,blockedvid1,listvideo01\|listvideo02,blockedvid1,listvideo01$/.test(await saved()), await saved());
  w0 = await tonyWrites();
  await js(`${q('[data-ytsync="p1"]')}.click(); return 1;`); await sleep(1500);
  ok('Refresh with nothing new says "Up to date" and writes nothing', /Up to date/.test(await toastTxt()) && (await tonyWrites()) === w0, await toastTxt());
  delete PLAYLISTS.PLgoodlist01;
  await js(`${q('[data-ytsync="p1"]')}.click(); return 1;`); await sleep(1500);
  ok('Refresh failing says so and keeps the list', /Could not reach YouTube/.test(await toastTxt()) && (await order()) === 'livenew0001,listvideo00,listvideo02,blockedvid1,listvideo01', await toastTxt());
  PLAYLISTS.PLgoodlist01 = [{ id: 'livenew0001', title: 'A live added on YouTube' }].concat(ORIG);
  await js(`${q('[data-id="p1~listvideo02"] [data-play]')}.click(); return 1;`); await sleep(1000);
  await js(`window.__frame = ${q('[data-id="p1~listvideo02"] iframe')}; ${q('[data-ytsync="p1"]')}.click(); return 1;`); await sleep(1500);
  ok('Refresh while a video in it plays: the player is left alone, the change waits for Stop', await js(`return EWFocus.playing() === 'p1~listvideo02' && ${q('[data-id="p1~listvideo02"] iframe')} === window.__frame;`) && /shows when you stop/.test(await toastTxt()), await toastTxt());
  await js(`${q('[data-id="p1~listvideo02"] [data-stop]')}.click(); return 1;`); await sleep(1200);
  ok('...and shows it at Stop', !(await order()).includes('listvideo00'), await order());
  PLAYLISTS.PLgoodlist01 = ORIG.slice();
  await js(`EWFocus.resync(); return 1;`); await sleep(1500);
  delete PLAYLISTS.PLgoodlist01; w0 = await tonyWrites();
  await js(`EWFocus.resync(); return 1;`); await sleep(1200);
  ok('re-sync failing (private now, or YouTube silent) keeps the stored list', (await tonyWrites()) === w0 && await js(`return ${q('.media-group[data-id="p1"]')}.querySelectorAll('.media-grid .media-tile').length === 3 && !${q('.media-group[data-id="p1"] [data-msg="nolist"]')};`));
  PLAYLISTS.PLgoodlist01 = ORIG.slice();
  await js(`${q('[data-id="p2"] [data-expand]')}.click(); return 1;`); await sleep(1200);
  ok('a list that cannot be read says so on its tile and stays one tile', /^nolist\|Could not list its videos/.test(await js(`const m = ${q('[data-id="p2"] .media-msg')}; return m ? m.dataset.msg + '|' + m.textContent : '';`)) && await js(`return !${q('.media-group[data-id="p2"]')};`));
  await js(`${q('[data-id="p1~listvideo01"] [data-play]')}.click(); return 1;`); await sleep(800);
  await js(`${q('[data-collapse="p1"]')}.click(); return 1;`); await sleep(1500);
  ok('Collapse folds it back to one tile, stopping a video playing in it', await js(`return !${q('.media-group')} && !!${q('.media-tile[data-id="p1"] [data-expand]')} && EWFocus.playing() === null && !document.querySelector('#focus-grid iframe');`));
  ok('…and drops the stored list (fetched fresh next time)', await js(`const p = __fakeFs.docs['dashboards/everwell_tony'].focusMedia.find(x => x.id === 'p1'); return p.expanded === false && !('videos' in p);`));
  await js(`${q('[data-id="p1"] [data-expand]')}.click(); return 1;`); await sleep(1200);
  await js(`${q('.media-group[data-id="p1"] .media-group-head [data-rm]')}.click(); return 1;`); await sleep(300);
  ok('removing an expanded playlist asks, counting its videos', await js(`return document.getElementById('uim-title').textContent === 'Remove playlist?' && /“Study list” and its 3 videos leave Focus/.test(document.getElementById('uim-msg').textContent);`),
    await js(`return document.getElementById('uim-title').textContent + ' | ' + document.getElementById('uim-msg').textContent;`));
  await js(`document.getElementById('uim-ok').click(); return 1;`); await sleep(500);
  ok('…and Remove takes the whole group', await js(`return !${q('[data-id="p1"]')} && !${q('[data-id^="p1~"]')};`));
  await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true }); await sleep(600);
  ok('360px: a tile with Expand fits, no sideways scroll', await js(`return document.documentElement.scrollWidth <= 360;`), await js(`return document.documentElement.scrollWidth;`));
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  console.log('\nA live stream (Tony, 2026-10-20)');
  await fresh(`sessionStorage.setItem('ew.skipIntro', '1'); sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/everwell_tony': { focusMedia: [
    { id: 'l1', url: 'https://www.youtube.com/live/livestream1', title: 'A live' }] } }));`);
  await js(`document.getElementById('ew-intro-overlay') && document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1200);
  await js(`EWApp.go('focus'); return 1;`); await sleep(1000);
  await js(`${q('[data-id="l1"] [data-play]')}.click(); return 1;`); await sleep(1800);
  const lv = () => js(`const f = ${q('[data-id="l1"] .media-frame')}; const fill = f.querySelector('.vp-fill').style.transform; return JSON.stringify({ live: f.classList.contains('live'), head: f.classList.contains('at-head'), time: f.querySelector('[data-vp-time]').textContent, btn: getComputedStyle(f.querySelector('.vp-live')).display, fill: parseFloat((fill.match(/scaleX\\(([^)]+)\\)/) || [])[1]) });`).then(JSON.parse);
  const key = (k) => js(`const h = ${q('[data-id="l1"] [data-vp-hit]')}; h.focus(); h.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true })); return 1;`);
  await key('m'); await key('m'); await sleep(400);   // a key wakes the controls
  let L = await lv();
  ok('a live plays and is known as live (its LIVE button shows, red at the live edge)', L.live && L.head && L.btn !== 'none', JSON.stringify(L));
  ok('...its clock is not the stream\'s age ("1984:..."): blank at the live edge', L.time === '', JSON.stringify(L));
  ok('...and the bar spans what YouTube keeps, so it sits at the end', L.fill > 0.99, JSON.stringify(L));
  await key('j'); await key('j'); await key('j'); await sleep(600);
  L = await lv();
  ok('seeking back 30s: the clock says how far behind live, the dot is no longer red', !L.head && /^−0:(29|3\d)$/.test(L.time), JSON.stringify(L));
  await js(`${q('[data-id="l1"] [data-vp="live"]')}.click(); return 1;`); await sleep(600);
  L = await lv();
  ok('LIVE jumps back to the live edge', L.head && L.time === '', JSON.stringify(L));
  await js(`${q('[data-id="l1"] [data-stop]')}.click(); return 1;`); await sleep(400);

  console.log('\nPage errors');
  ok('no uncaught exceptions', errs.length === 0, errs.join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
