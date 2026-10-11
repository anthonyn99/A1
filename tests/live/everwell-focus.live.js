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
const media = [];   // every request to a media host, for the Display check
// The fake player: answers "listening" with onError <code>, or with
// infoDelivery for a good video.
const CODES = { blockedvid1: 150, removedvid1: 100 };
const player = (code) => `<!doctype html><title>fake player</title><script>
addEventListener('message', function(e){ var d; try { d = JSON.parse(e.data); } catch (x) { return; }
  if (d.event !== 'listening') return;
  parent.postMessage(JSON.stringify(${code ? `{ event: 'onError', info: ${code} }` : `{ event: 'infoDelivery', info: { playerState: 1 } }`}), '*'); });
</script>`;
// A short silent WAV whose every byte is ASCII (the mock sends text as UTF-8):
// 16-bit mono at 4112 Hz, 4096 data bytes of zeros.
const le = (n, w) => { let s = ''; for (let i = 0; i < w; i++) s += String.fromCharCode((n >> (8 * i)) & 255); return s; };
const WAV = 'RIFF' + le(36 + 4096, 4) + 'WAVEfmt ' + le(16, 4) + le(1, 2) + le(1, 2) + le(4112, 4) + le(8224, 4) + le(2, 2) + le(16, 2) + 'data' + le(4096, 4) + '\0'.repeat(4096);
const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://www.youtube-nocookie.com/*', 'https://i.ytimg.com/*', 'https://audio.test/*', 'https://example.com/*', 'https://www.instagram.com/*'],
  handle(req) {
    const u = new URL(req.url);
    if (u.hostname !== 'taskhub-reminders.av1.workers.dev') {
      media.push(req.url);
      if (u.hostname === 'www.youtube-nocookie.com') { const id = u.pathname.split('/').pop(); return { text: player(CODES[id]), type: 'text/html' }; }
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
  ok('a link that is not video, reel or audio is refused', /not a YouTube, Instagram Reel or audio/.test(await js(`return document.getElementById('focus-err').textContent;`)));
  await add('https://audio.test/rain.wav', 'Rain');
  await add('https://audio.test/missing.mp3', 'Broken stream');
  await add('https://www.youtube.com/watch?v=removedvid1', 'Removed');
  await add('https://www.youtube.com/watch?v=blockedvid1', 'Blocked');
  await add('https://www.youtube.com/watch?v=goodvideo01', 'Good');
  await add('https://www.youtube.com/watch?v=goodvideo01');
  ok('a duplicate is refused', /already here/.test(await js(`return document.getElementById('focus-err').textContent;`)));
  ok('five tiles, newest first; the two audio tiles are short audio tiles', await js(`const t = [...document.querySelectorAll('#focus-grid .media-tile')]; return t.length === 5 && t[0].querySelector('.t').textContent === 'Good' && t.filter(x => x.dataset.kind === 'audio' && x.querySelector('.media-frame.audio')).length === 2;`));
  ok('nothing plays on open', await js(`return !document.querySelector('#focus-grid iframe, #focus-grid audio');`));
  ok('every tile has an "open on the site" link (new tab, no opener)', await js(`return [...document.querySelectorAll('#focus-grid .media-meta a')].length === 5 && [...document.querySelectorAll('#focus-grid .media-meta a')].every(a => a.target === '_blank' && /noopener/.test(a.rel));`));
  await sleep(1500);
  ok('saved as its own field, focusMedia (Mindset\'s list untouched)', await js(`const d = __fakeFs.docs['dashboards/everwell_tony'] || {}; return (d.focusMedia || []).length === 5 && !d.mindsetMedia;`), await js(`return JSON.stringify(__fakeFs.docs['dashboards/everwell_tony']);`));
  ok('a failed thumbnail (offline / blocked) leaves placeholder art, not a black box', await js(`return !document.querySelector('#focus-grid img') && document.querySelectorAll('#focus-grid .media-ph').length === 5;`));

  console.log('\nPlaying');
  await js(`${tile(1)}.querySelector('[data-play]').click(); return 1;`); await sleep(1500);
  ok('a tap plays it through youtube-nocookie with autoplay and the error channel', await js(`const f = ${tile(1)}.querySelector('iframe'); return !!f && /^https:\\/\\/www\\.youtube-nocookie\\.com\\/embed\\/goodvideo01\\?autoplay=1&.*enablejsapi=1/.test(f.src);`));
  ok('a good video keeps playing (its messages are not errors)', await js(`return EWFocus.playing() !== null && !!${tile(1)}.querySelector('iframe');`));
  await add('https://www.youtube.com/watch?v=abcdefghijk', 'Added while playing');
  ok('adding while one plays does not restart it (the player stays put)', await js(`return document.querySelectorAll('#focus-grid .media-tile').length === 6 && ${tile(2)}.querySelector('.t').textContent === 'Good' && !!${tile(2)}.querySelector('iframe');`));
  await js(`${tile(1)}.querySelector('[data-rm]').click(); return 1;`); await sleep(300);
  ok('removing another tile while one plays leaves the player alone', await js(`return document.querySelectorAll('#focus-grid .media-tile').length === 5 && !!${tile(1)}.querySelector('iframe');`));

  console.log('\nFailures are shown');
  await js(`${tile(2)}.querySelector('[data-play]').click(); return 1;`); await sleep(1800);
  ok('embed-blocked (150): the player closes and the tile says so, with a link to YouTube', /^blocked\|.*only lets it play on YouTube.*Open on YouTube/.test(await msg(2)) && await js(`return !document.querySelector('#focus-grid iframe') && EWFocus.playing() === null;`), await msg(2));
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
  ok('leaving Focus stops it', await js(`return !document.querySelector('#focus-grid iframe, #focus-grid audio') && EWFocus.playing() === null;`));
  await js(`EWApp.go('focus'); return 1;`); await sleep(600);
  ok('coming back plays nothing on its own', await js(`return !document.querySelector('#focus-grid iframe, #focus-grid audio');`));
  await js(`${tile(1)}.querySelector('[data-play]').click(); return 1;`); await sleep(800);
  await js(`EWApp.go('mindset'); return 1;`); await sleep(700);
  await js(`document.getElementById('media-url').value = 'https://youtu.be/blockedvid1'; document.getElementById('media-add').requestSubmit(); return 1;`); await sleep(300);
  await js(`document.getElementById('media-url').value = 'https://audio.test/rain.wav'; document.getElementById('media-add').requestSubmit(); return 1;`); await sleep(300);
  ok('Mindset takes no audio link', /not a YouTube or Instagram Reel/.test(await js(`return document.getElementById('media-err').textContent;`)));
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
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  console.log('\nDisplay');
  media.length = 0;
  await fresh(`sessionStorage.setItem('ew.profile', 'display'); sessionStorage.setItem('ew.skipIntro', '1');`);
  await js(`EWApp.go('focus'); return 1;`); await sleep(800);
  ok('Display shows four sample tiles, no add form, no remove, no site links', await js(`return document.querySelectorAll('#focus-grid .media-tile').length === 4 && !document.getElementById('focus-add') && !document.querySelector('#focus-grid [data-rm], #focus-grid .media-meta a');`));
  await js(`document.querySelector('#focus-grid [data-play]').click(); return 1;`); await sleep(600);
  ok('a tap plays nothing and says why', await js(`return !document.querySelector('#focus-grid iframe, #focus-grid audio') && /Nothing plays here/.test(document.getElementById('ew-toast').textContent);`));
  ok('Display touched no media host (no thumbnails, no player) and no Firebase', media.length === 0 && await js(`return typeof window.__fakeFs === 'undefined';`), media.join(' '));

  console.log('\nPage errors');
  ok('no uncaught exceptions', errs.length === 0, errs.join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
