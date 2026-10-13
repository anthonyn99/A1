// Everwell (A1-Priv/everwell.html), Tony's 2026-10-12 refinements, in the real
// page against the fake Firebase. Nothing here reaches the network: personal-ai
// /ig/media and /ig/thumb, the Instagram CDN and Instagram itself (a saved
// collection page and its web API) are all faked.
//
//   - Instagram collections on Mindset: covers, Everwell's own player (videos
//     advance at their end, photos and carousels, the embed fallback), the
//     modes (Advance / Repeat / Once), keys, fill, stop, drag to reorder,
//     collapse and expand; a pasted reel plays in place, in its own sequence
//   - the sync: an #ew-igc= link merges (Tony's order kept, new on top,
//     unsaved gone) and a new collection lands in Mindset; the REAL bookmarklet
//     run on a fake instagram.com collection page (its API, then its links)
//   - linking: a pasted collection link, the dialog; removal asks first
//   - Display: a sample collection, nothing touches Instagram or the worker
//   - phones: the player and a playing YouTube video fit, every control shows
//   - recipes: tools with quantities (old string tools still read), the tools
//     checklist; the routine sheet's numbers and totals
//
// Run: node tests/live/everwell-instagram.live.js
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
const CID = '17912345678901234', COLL = 'https://www.instagram.com/tony/saved/discipline/' + CID + '/';

// A short silent WAV (every byte ASCII; the mock sends text): 2 s (16448 bytes: every size byte stays ASCII), so a
// "reel" ends quickly. A <video> plays an audio-only file and fires 'ended'.
const le = (n, w) => { let s = ''; for (let i = 0; i < w; i++) s += String.fromCharCode((n >> (8 * i)) & 255); return s; };
const WAV = 'RIFF' + le(36 + 16448, 4) + 'WAVEfmt ' + le(16, 4) + le(1, 2) + le(1, 2) + le(4112, 4) + le(8224, 4) + le(2, 2) + le(16, 2) + 'data' + le(16448, 4) + '\0'.repeat(16448);
const svg = (t, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#456"/><text x="10" y="30" fill="#fff">${t}</text></svg>`;
const net = [];   // every request to the worker's /ig, the CDN or Instagram
const API = { fail: false, pages: [] };   // Instagram's collection API, faked
const IGPAGE = (links) => `<!doctype html><title>Instagram</title><body><main>${links.map((c) => `<a href="/p/${c}/">${c}</a>`).join('')}</main><div style="height:3000px"></div></body>`;
const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://ddragon.leagueoflegends.com/*', 'https://warroom-api.av1.workers.dev/*', 'https://personal-ai.av1.workers.dev/*',
    'https://www.youtube-nocookie.com/*', 'https://www.instagram.com/*', 'https://i.ytimg.com/*', 'https://cdn.test/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = new URL(req.url), p = u.pathname;
    if (u.host === 'cdn.test' || u.host === 'www.instagram.com' || (u.host === 'personal-ai.av1.workers.dev' && p.startsWith('/ig/'))) net.push(u.host + p + u.search);
    if (u.host === 'i.ytimg.com') return { status: 404, text: '' };
    if (u.host === 'www.youtube-nocookie.com') return { text: '<!doctype html><title>fake player</title>', type: 'text/html' };
    if (u.host === 'cdn.test') return /\.wav$/.test(p) ? { text: WAV, type: 'audio/wav' } : { text: svg(p, 400, 600), type: 'image/svg+xml' };
    if (u.host === 'www.instagram.com') {
      const m = p.match(/^\/api\/v1\/feed\/collection\/(\d+)\/posts\/$/);
      if (m) {
        if (API.fail) return { status: 403, json: { message: 'login_required' } };
        const i = u.searchParams.get('max_id') ? 1 : 0, pg = API.pages[i] || [];
        const cand = (c) => ({ candidates: [{ width: 1080, height: 1350, url: 'https://scontent-x.cdninstagram.com/' + c + '-1080.jpg' }, { width: 640, height: 800, url: 'https://scontent-x.cdninstagram.com/' + c + '-640.jpg' }, { width: 150, height: 150, url: 'https://scontent-x.cdninstagram.com/' + c + '-150.jpg' }] });
        return { json: { items: pg.map((c) => ({ media: { code: c, media_type: /^V/.test(c) ? 2 : 1, product_type: /^V/.test(c) ? 'clips' : 'feed', video_duration: 12.4, caption: { text: 'caption of ' + c }, user: { username: 'acct' },
          image_versions2: cand(c), original_width: 1080, original_height: 1350, video_versions: /^V/.test(c) ? [{ url: 'https://scontent-x.cdninstagram.com/' + c + '.mp4' }] : undefined } })),
          more_available: i === 0 && API.pages.length > 1, next_max_id: i === 0 ? 'NEXT' : null } };
      }
      if (/\/saved\//.test(p)) return { text: IGPAGE(['LNKaaaa1', 'LNKaaaa2']), type: 'text/html' };
      return { text: '<!doctype html><body style="background:#fff">Instagram embed</body>', type: 'text/html' };
    }
    if (u.host === 'personal-ai.av1.workers.dev' && p === '/ig/thumb') return /^BLK/.test(u.searchParams.get('code')) ? { status: 404, text: 'not found' } : { text: svg(u.searchParams.get('code'), 360, 480), type: 'image/svg+xml' };
    if (u.host === 'personal-ai.av1.workers.dev' && p === '/ig/px') {
      const t = u.searchParams.get('u') || '';
      if (/gone/.test(t)) return { status: 403, text: 'URL signature expired' };
      return /\.mp4$/.test(t) ? { text: WAV, type: 'audio/wav' } : { text: svg(t.split('/').pop(), 400, 500), type: 'image/svg+xml' };
    }
    if (u.host === 'personal-ai.av1.workers.dev' && p === '/ig/media') {
      const c = u.searchParams.get('code');
      if (/^BAD|^BLK/.test(c)) return { json: { ok: false, error: 'unavailable' } };
      // Instagram's embed without video_url: only the cover (NOV: flagged by worker v29; OLD: an older cached answer).
      if (/^NOV|^OLD/.test(c)) return { json: Object.assign({ ok: true, code: c, user: 'nov.acct', caption: 'the whole caption of ' + c + ' #mindset', items: [{ type: 'image', src: 'https://cdn.test/' + c + '.svg', w: 720, h: 1280 }] }, /^NOV/.test(c) ? { noVideo: true } : {}) };
      if (/^CAR/.test(c)) return { json: { ok: true, code: c, user: 'car.acct', caption: 'three slides', items: [1, 2, 3].map((i) => ({ type: 'image', src: 'https://cdn.test/' + c + i + '.svg', w: 1080, h: 1350 })) } };
      if (/^PIC|^LNK/.test(c)) return { json: { ok: true, code: c, user: 'pic.acct', caption: 'a photo', items: [{ type: 'image', src: 'https://cdn.test/' + c + '.svg', w: 1080, h: 1080 }] } };
      return { json: { ok: true, code: c, user: 'reel.acct', caption: 'Caption with a #tag', items: [{ type: 'video', src: 'https://cdn.test/' + c + '.wav', poster: 'https://cdn.test/' + c + '.svg', w: 720, h: 1280, dur: 2 }] } };
    }
    if (u.host === 'personal-ai.av1.workers.dev' && p === '/quote/daily') return { json: { ok: true, date: u.searchParams.get('date'), text: 'Small steps.', via: 'orca' } };
    if (u.host === 'warroom-api.av1.workers.dev') return { json: ['16.99.1'] };
    if (u.host === 'ddragon.leagueoflegends.com') return { status: 404, text: '' };
    if (p === '/auth/journal/status-many') { const out = {}; ((req.postData ? JSON.parse(req.postData) : {}).locks || []).forEach((l) => { out[l.journal + ':' + l.entryId] = { hasLock: false, ver: null }; }); return { json: { ok: true, locks: out } }; }
    return { json: { ok: false } };
  },
};
const post = (c, k, d) => ({ c, k: k || (/^V/.test(c) ? 'r' : /^CAR/.test(c) ? 's' : 'p'), d: d || 0, t: 'post ' + c, u: 'acct' });
const SEED = () => ({
  'dashboards/motioncore': { savedAt: 1, circuits: [],
    routines: [{ id: 'r1', name: 'Push Day', content: 'Incline Bench - 3 sets\nPec Fly - 3 sets\n\nTrap Shrugs - 3 sets\n\nAb Circuit\n\nCardio: Stairmaster - 20 mins' }] },
  'dashboards/mealsuite': { savedAt: 1, recipes: [{ id: 'rA', name: 'Pasta Primavera', category: 'Dinner', prepTime: '30 min', servings: '', ingredients: [{ name: 'Penne', qty: '300g' }],
    tools: ['Large pot', { name: 'Wooden spoon', qty: '2' }], instructions: '1. Boil.' }] },
  'dashboards/everwell_tony': {
    mindsetMedia: [
      { id: 'col1', url: COLL, title: 'Discipline', igc: { cid: CID, user: 'tony', slug: 'discipline', at: Date.now() - 7200e3 },
        posts: [post('VIDaaaa1', 'r', 12), post('VIDaaaa2', 'r', 30), post('PICaaaa3'), post('CARaaaa4'), post('BADaaaa5')], expanded: true },
      { id: 'col2', url: 'https://www.instagram.com/tony/saved/blocked/17955555555555555/', title: 'Blocked', igc: { cid: '17955555555555555', user: 'tony', slug: 'blocked', at: Date.now() - 60e3 },
        posts: [Object.assign(post('BLKphoto1', 'p'), { i: 'https://scontent-x.cdninstagram.com/BLKphoto1-640.jpg', m: [{ t: 'i', u: 'https://scontent-x.cdninstagram.com/BLKphoto1-1080.jpg', w: 1080, h: 1350 }] }),
          Object.assign(post('BLKgone02', 'p'), { i: 'https://scontent-x.cdninstagram.com/gone-640.jpg', m: [{ t: 'i', u: 'https://scontent-x.cdninstagram.com/gone-1080.jpg', w: 1080, h: 1080 }] })], expanded: false },
      { id: 'm1', url: 'https://www.instagram.com/reel/VIDmanual/', title: 'A pasted reel' },
      { id: 'm2', url: 'https://youtu.be/jfKfPfyJRdk', title: 'A video' }],
    focusMedia: [{ id: 'f1', url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', title: 'Focus video' }] },
});
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

(async () => {
  const c = await connect({ mock: firebaseMock(mock) });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || '').slice(0, 300));
    if (m.method === 'Page.javascriptDialogOpening') c.send('Page.handleJavaScriptDialog', { accept: true });
  });
  const js = (e) => evalJs(c, e);
  const size = (w, h, mob) => c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h || 900, deviceScaleFactor: 1, mobile: !!mob });
  const fresh = async (opts) => {
    opts = opts || {};
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(300);
    await js(`localStorage.clear(); sessionStorage.clear(); ${opts.display ? "sessionStorage.setItem('ew.profile', 'display');" : `sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(opts.seed || SEED()))});`} return 1;`);
    await c.send('Page.navigate', { url: PAGE + (opts.hash || '') }); await sleep(2800);
    await js(`document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1300);
  };
  const go = (t) => js(`EWApp.go('${t}'); return 1;`).then(() => sleep(800));
  const media = () => js(`return JSON.stringify(__fakeFs.docs['dashboards/everwell_tony'].mindsetMedia);`).then(JSON.parse);
  const stage = () => js(`const s = document.querySelector('#media-grid [data-igstage]'); if (!s) return 'null';
    const v = s.querySelector('[data-ig-media] video'), im = s.querySelector('[data-ig-media] img'), f = s.querySelector('[data-ig-media] iframe');
    return JSON.stringify({ cls: s.className, pos: s.querySelector('[data-ig-pos]').textContent, who: s.querySelector('[data-ig-who]').textContent, cap: s.querySelector('[data-ig-cap]').innerHTML,
      v: v ? v.src : null, loop: v ? v.loop : null, img: im ? im.src : null, frame: f ? f.src : null, note: s.querySelector('[data-ig-note]').textContent, segs: s.querySelectorAll('[data-ig-segs] span').length,
      mode: s.querySelector('[data-igs="mode"]').textContent, on: [...document.querySelectorAll('#media-grid .igc-cell.on, #media-grid .media-tile.ig-on')].map(e => e.dataset.id).join(),
      now: (EWMedia.now() || {}).title || null });`).then(JSON.parse);
  const click = (sel) => js(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'missing'; e.click(); return 1;`);
  const toast = () => js(`return document.getElementById('ew-toast').textContent;`);

  await size(1280, 900);

  console.log('\nA collection on Mindset');
  await fresh(); await go('mindset');
  ok('the expanded collection shows its covers (through personal-ai /ig/thumb), kinds and lengths', await js(`const g = document.querySelector('#media-grid .igc-group[data-id="col1"]'); if (!g) return false;
    const cells = [...g.querySelectorAll('.igc-cell')]; return cells.length === 5 && cells[0].querySelector('img').src.indexOf('https://personal-ai.av1.workers.dev/ig/thumb?code=VIDaaaa1') === 0 &&
    !!cells[0].querySelector('.igc-k') && cells[0].querySelector('.igc-d').textContent === '0:12' && !!cells[3].querySelector('.igc-k') && !cells[2].querySelector('.igc-k') &&
    g.querySelector('[data-igc-kind]').textContent === 'Instagram · synced 2 h ago' && !!g.querySelector('.igc-head .igc-acts [data-igplay]') && !!g.querySelector('.igc-acts [data-igsync]') && !!g.querySelector('.igc-acts [data-igcollapse]');`));
  ok('the pasted reel stays its own tile beside it, with its cover', await js(`const t = document.querySelector('#media-grid .media-tile[data-id="m1"]'); return !!t && /ig\\/thumb\\?code=VIDmanual/.test(t.querySelector('img').src) && t.querySelector('.k').textContent === 'Instagram reel';`));
  ok('nothing loads a post until one is played (covers only)', !net.some((u) => /ig\/media|cdn\.test/.test(u)));

  console.log('\nThe player');
  await click('#media-grid .igc-cell[data-id="col1~VIDaaaa1"]'); await sleep(900);
  let s = await stage();
  ok('a cover opens the player in its collection, above the covers, on that post', s && /ig-stage/.test(s.cls) && s.v === 'https://cdn.test/VIDaaaa1.wav' && s.pos === 'Discipline · 1 of 5' && s.on === 'col1~VIDaaaa1', JSON.stringify(s));
  ok('it reads the post from personal-ai /ig/media: account and full caption, tags marked', s.who === '@reel.acct' && /Caption with a <span class="tag">#tag<\/span>/.test(s.cap), JSON.stringify(s));
  ok('the shell knows what plays (the "now playing" pill)', s.now === 'post VIDaaaa1');
  ok('the default mode is Advance', s.mode === 'Advance');
  await sleep(2600);
  s = await stage();
  ok('a reel that ends moves on by itself, and then the next', /VIDaaaa2|PICaaaa3/.test((s.v || '') + (s.img || '')) && (s.on === 'col1~VIDaaaa2' || s.on === 'col1~PICaaaa3'), JSON.stringify(s));
  await js(`EWMedia.stopAll(); return 1;`); await sleep(500);
  ok('stop takes the player away and clears the covers', await js(`return !document.querySelector('[data-igstage]') && !document.querySelector('.igc-cell.on') && !EWMedia.now();`));
  await click('#media-grid .igc-cell[data-id="col1~PICaaaa3"]'); await sleep(900);
  s = await stage();
  ok('a photo shows as an image (no seek bar, no sound button), from the CDN', s.img === 'https://cdn.test/PICaaaa3.svg' && /\bimg\b/.test(s.cls) && s.segs === 0, JSON.stringify(s));
  await click('#media-grid [data-igstage] .ig-ctl [data-igs="next"]'); await sleep(900);
  s = await stage();
  ok('Next: a carousel shows its first slide with a segment per slide', s.img === 'https://cdn.test/CARaaaa41.svg' && s.segs === 3 && /multi/.test(s.cls) && s.pos === 'Discipline · 4 of 5', JSON.stringify(s));
  await click('#media-grid [data-igstage] [data-igs="cnext"]');
  let turnAt = 'none';
  for (let w = 0; w < 40; w++) {
    turnAt = await js(`const s = document.querySelector('[data-igstage]'), g = s.querySelector('.ig-ghost'), m = s.querySelector('[data-ig-media]'); if (!g) return 'none';
      const x = (el) => new DOMMatrix(getComputedStyle(el).transform).m41, bw = s.querySelector('[data-ig-box]').getBoundingClientRect().width;
      return JSON.stringify({ gi: (g.querySelector('img') || {}).src, mi: (m.querySelector('img') || {}).src, gx: x(g), mx: x(m), bw, mo: getComputedStyle(m).opacity, go: getComputedStyle(g).opacity, gp: getComputedStyle(g).pointerEvents });`);
    if (turnAt !== 'none') { const q = JSON.parse(turnAt); if (q.gx < 0) break; }
    await sleep(15);
  }
  const mq = turnAt === 'none' ? {} : JSON.parse(turnAt);
  ok('a slide turn moves both slides together, side by side: the old one out left, the new one in from the right, no gap', mq.gi === 'https://cdn.test/CARaaaa41.svg' && mq.mi === 'https://cdn.test/CARaaaa42.svg' && mq.gx < 0 && mq.mx > 0 && Math.abs(mq.mx - mq.gx - mq.bw) < 2, turnAt);
  ok('…with nothing faded (no dark flash between them), and the leaving slide takes no clicks', mq.mo === '1' && mq.go === '1' && mq.gp === 'none', turnAt);
  await sleep(600);
  s = await stage();
  ok('its arrow moves to the next slide', s.img === 'https://cdn.test/CARaaaa42.svg');
  ok('…and when the turn ends the old slide is gone and the new one rests in place', await js(`const s = document.querySelector('[data-igstage]'); return !s.querySelector('.ig-ghost') && getComputedStyle(s.querySelector('[data-ig-media]')).transform === 'none';`));
  await js(`const b = document.querySelector('[data-igstage] [data-igs="cprev"]'); b.click(); return 1;`); await sleep(30);
  await js(`const b = document.querySelector('[data-igstage] [data-igs="cnext"]'); b.click(); return 1;`); await sleep(40);
  await js(`const b = document.querySelector('[data-igstage] [data-igs="cnext"]'); b.click(); return 1;`); await sleep(800);
  s = await stage();
  ok('rapid presses all count and leave one clean slide (no stray layers)', s.img === 'https://cdn.test/CARaaaa43.svg' && await js(`return document.querySelectorAll('[data-igstage] .ig-ghost').length === 0 && document.querySelectorAll('[data-igstage] [data-ig-media] img').length === 1;`), JSON.stringify(s));
  await js(`document.querySelector('[data-igstage] [data-igs="cprev"]').click(); return 1;`); await sleep(800);
  ok('the slide arrows are big and clear (46px)', await js(`return document.querySelector('[data-igstage] .ig-cnav.cnext').getBoundingClientRect().width === 46;`));
  await click('#media-grid [data-igstage] .ig-ctl [data-igs="toggle"]'); await sleep(250);
  ok('pausing stops the bars on its cover, and the shell knows (the pill says Paused)', await js(`const c = document.querySelector('.igc-cell.on'); return EWMedia.now().paused === true && c.classList.contains('paused') && getComputedStyle(c.querySelector('.igc-eq i')).animationPlayState === 'paused';`));
  await go('focus');
  ok('…the "now playing" pill on another tab stops its bars and says Paused', await js(`const n = document.getElementById('ew-now'); return n.classList.contains('on') && n.classList.contains('paused') && /^Paused in Mindset$/.test(document.getElementById('ew-now-k').textContent) && getComputedStyle(n.querySelector('.ew-now-eq i')).animationPlayState === 'paused';`));
  await go('mindset');
  await click('#media-grid [data-igstage] .ig-ctl [data-igs="toggle"]'); await sleep(250);
  ok('playing again moves them again', await js(`const c = document.querySelector('.igc-cell.on'); return EWMedia.now().paused === false && !c.classList.contains('paused') && getComputedStyle(c.querySelector('.igc-eq i')).animationPlayState === 'running';`));
  await js(`document.querySelector('#media-grid [data-igstage]').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return 1;`); await sleep(900);
  s = await stage();
  ok("a post the worker cannot read plays in Instagram's own embed, and says Next is by hand", s.frame === 'https://www.instagram.com/p/BADaaaa5/embed/captioned/' && /embed/.test(s.cls) && /Use Next/.test(s.note) && s.pos === 'Discipline · 5 of 5', JSON.stringify(s));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return 1;`); for (let w = 0; w < 30 && (await js(`return document.querySelector('[data-ig-pos]').textContent;`)) === 'Discipline · 5 of 5'; w++) await sleep(50);
  s = await stage();
  ok('Advance wraps round from the last to the first (↓ moves a post)', s.pos === 'Discipline · 1 of 5' && s.v === 'https://cdn.test/VIDaaaa1.wav', JSON.stringify(s));
  await click('#media-grid [data-igstage] .ig-ctl [data-igs="next"]');
  const mid = await js(`const b = document.querySelector('[data-ig-box]'); return JSON.stringify({ a: b.getAnimations().length, pos: document.querySelector('[data-ig-pos]').textContent });`).then(JSON.parse);
  await sleep(500);
  ok('Next turns like the Principles reader: the post slides out first, then the next lands', mid.a > 0 && mid.pos === 'Discipline · 1 of 5' && (await stage()).pos === 'Discipline · 2 of 5', JSON.stringify(mid));
  await js(`const b = document.querySelector('#media-grid [data-igstage] .ig-ctl [data-igs="next"]'); b.click(); b.click(); return 1;`); await sleep(600);
  ok('two quick presses move two posts (a turn lands at once when pressed again)', (await stage()).pos === 'Discipline · 4 of 5');
  await click('#media-grid .igc-cell[data-id="col1~VIDaaaa1"]'); await sleep(700);
  ok('picking an earlier cover turns back to it', (await stage()).pos === 'Discipline · 1 of 5');
  await click('#media-grid [data-igstage] [data-igs="mode"]'); await sleep(200);
  // The 0.5 s test reel may have ended as Repeat was picked: back on the first, deterministically.
  await click('#media-grid .igc-cell[data-id="col1~VIDaaaa1"]'); await sleep(700);
  s = await stage();
  ok('the mode button turns to Repeat: the video loops, saved for this device', s.mode === 'Repeat' && s.loop === true && await js(`return localStorage.getItem('ew.tony.igMode') === 'one';`), JSON.stringify(s));
  await sleep(2000);
  ok('…and stays on the same post', (await stage()).pos === 'Discipline · 1 of 5');
  await click('#media-grid [data-igstage] [data-igs="mode"]'); await sleep(200);
  s = await stage();
  ok('then Once: no wrapping, so Previous is off on the first', s.mode === 'Once' && await js(`return document.querySelector('#media-grid [data-igstage] .ig-ctl [data-igs="prev"]').disabled === true && document.querySelector('#media-grid [data-igstage] .ig-ctl [data-igs="next"]').disabled === false;`));
  await click('#media-grid [data-igstage] [data-igs="mode"]'); await sleep(200);
  ok('then back to Advance', (await stage()).mode === 'Advance');
  await click('#media-grid [data-igstage] [data-igs="fill"]'); await sleep(500);
  ok('Fill: the player covers the window', await js(`const s = document.querySelector('[data-igstage]'), r = s.getBoundingClientRect(); return s.classList.contains('filled') && r.left === 0 && r.top === 0 && r.width === innerWidth && r.height === innerHeight && document.documentElement.classList.contains('vp-lock');`));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;`); await sleep(400);
  ok('Escape puts it back, still playing', await js(`const s = document.querySelector('[data-igstage]'); return !!s && !s.classList.contains('filled') && !document.documentElement.classList.contains('vp-lock');`));
  await go('focus'); await go('mindset');
  ok('it keeps playing across tabs (standing rule)', !!(await js(`return EWMedia.now() && EWMindset.playing();`)));
  await click('#media-grid [data-igstage] [data-igs="close"]'); await sleep(500);
  ok('Stop (×) closes it', await js(`return !document.querySelector('[data-igstage]') && !EWMedia.now();`));

  console.log('\nArranging');
  const pt = (sel) => js(`const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });`).then(JSON.parse);
  await js(`document.querySelector('.igc-cell[data-id="col1~VIDaaaa1"]').scrollIntoView({ block: 'center' }); return 1;`); await sleep(300);
  const a = await pt('.igc-cell[data-id="col1~VIDaaaa1"]'), b = await pt('.igc-cell[data-id="col1~PICaaaa3"]');
  const mouse = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await mouse('mousePressed', a.x, a.y); await sleep(350);
  for (let i = 1; i <= 16; i++) { await mouse('mouseMoved', a.x + (b.x - a.x + 30) * i / 16, a.y + (b.y - a.y) * i / 16); await sleep(16); }
  await sleep(200); await mouse('mouseReleased', b.x + 30, b.y); await sleep(1800);
  let mm = await media();
  ok('covers drag to reorder, saved', mm[0].posts.map((x) => x.c).join() !== 'VIDaaaa1,VIDaaaa2,PICaaaa3,CARaaaa4,BADaaaa5' && mm[0].posts[0].c === 'VIDaaaa2', mm[0].posts.map((x) => x.c).join());
  ok('…and dragging did not play anything', !(await js(`return !!document.querySelector('[data-igstage]');`)));
  const order = mm[0].posts.map((x) => x.c);
  await click('#media-grid [data-igcollapse="col1"]'); await sleep(1800);
  ok('Collapse: one tile with a strip of its first four covers, Play and Expand', await js(`const t = document.querySelector('#media-grid .igc-tile[data-id="col1"]'); return !!t && t.querySelectorAll('.igc-strip img').length === 4 && !!t.querySelector('[data-igplay]') && !!t.querySelector('[data-igexpand]');`) &&
    (await media())[0].expanded === false);
  await click('#media-grid .igc-tile .media-play[data-igplay]'); await sleep(900);
  s = await stage();
  ok('Play on the collapsed tile opens it and plays from the first (in Tony\'s order)', !!s && s.pos === 'Discipline · 1 of 5' && s.on === 'col1~' + order[0] && (await media())[0].expanded === true, JSON.stringify(s));
  await click('#media-grid [data-igs="close"]'); await sleep(400);

  console.log('\nPosts kept off other sites (the sync\'s copy) and hiding the details');
  await click('#media-grid [data-igexpand="col2"]'); await sleep(900);
  ok("a blocked post's cover comes from the sync's copy through the worker relay when /ig/thumb has none", await js(`const im = document.querySelector('.igc-cell[data-id="col2~BLKphoto1"] img'); return !!im && im.complete && im.naturalWidth > 0 && im.src.indexOf('https://personal-ai.av1.workers.dev/ig/px?u=' + encodeURIComponent('https://scontent-x.cdninstagram.com/BLKphoto1-640.jpg')) === 0;`));
  await click('#media-grid .igc-cell[data-id="col2~BLKphoto1"]'); await sleep(1000);
  s = await stage();
  ok('…and it plays from that copy (no "broken" embed)', s.img === 'https://personal-ai.av1.workers.dev/ig/px?u=' + encodeURIComponent('https://scontent-x.cdninstagram.com/BLKphoto1-1080.jpg') && !s.frame && !/embed|gone/.test(s.cls), JSON.stringify(s));
  await click('#media-grid [data-igstage] .ig-ctl [data-igs="next"]'); await sleep(1000);
  ok('a copy that has run out says to sync again, with a link to Instagram', await js(`const s = document.querySelector('[data-igstage]'); return s.classList.contains('gone') && /needs a fresh sync/.test(s.querySelector('[data-ig-gone]').textContent) && !!s.querySelector('[data-ig-gone] a[href*="instagram.com/p/BLKgone02"]');`));
  await click('#media-grid .ig-side [data-igs="side"]'); await sleep(300);
  ok('Hide details: only the post, a small bar keeps Show, Fill and Stop; remembered on this device', await js(`const s = document.querySelector('[data-igstage]'); return s.classList.contains('bare') && getComputedStyle(s.querySelector('.ig-side')).display === 'none' &&
    getComputedStyle(s.querySelector('.ig-bare')).display === 'flex' && s.querySelectorAll('.ig-bare button').length === 3 && localStorage.getItem('ew.tony.igSide') === '0';`));
  await click('#media-grid .ig-bare [data-igs="side"]'); await sleep(300);
  ok('…and Show brings them back', await js(`const s = document.querySelector('[data-igstage]'); return !s.classList.contains('bare') && getComputedStyle(s.querySelector('.ig-side')).display !== 'none' && localStorage.getItem('ew.tony.igSide') === '1';`));
  await click('#media-grid [data-igs="close"]'); await sleep(400);
  await click('#media-grid [data-igcollapse="col2"]'); await sleep(500);
  ok('a collapsed collection: its name, one quiet line, and icon buttons on their own row', await js(`const t = document.querySelector('#media-grid .igc-tile[data-id="col2"]'); if (!t) return false;
    const ttl = t.querySelector('.igc-ttl').getBoundingClientRect(), acts = t.querySelector('.igc-acts').getBoundingClientRect();
    return t.querySelector('.igc-ttl .t').textContent === 'Blocked' && /^Instagram · synced [0-9]+ min ago$/.test(t.querySelector('.igc-ttl .s').textContent) && acts.top >= ttl.bottom - 1 && t.querySelectorAll('.igc-acts .igc-ib').length === 5;`));

  console.log('\nA pasted reel');
  await click('#media-grid .media-tile[data-id="m1"] [data-play]'); await sleep(900);
  ok('it opens the player in place of its tile, alone in its sequence', await js(`const h = document.querySelector('#media-grid .ig-host[data-id="m1"]'); return !!h && !!h.querySelector('[data-igstage]') && h.querySelector('[data-ig-pos]').textContent === '';`));
  await click('#media-grid [data-igstage] [data-igs="mode"]'); await click('#media-grid [data-igstage] [data-igs="mode"]'); await sleep(2200);
  ok('in Once mode it stops at the end and offers Play again', await js(`return document.querySelector('[data-igstage]').classList.contains('done') && getComputedStyle(document.querySelector('.ig-done')).display === 'flex';`));
  await click('#media-grid [data-igs="replay"]'); await sleep(400);
  ok('Play again restarts it', await js(`return !document.querySelector('[data-igstage]').classList.contains('done') && !!document.querySelector('[data-igstage] video');`));
  await js(`localStorage.setItem('ew.tony.igMode', 'all'); return 1;`);
  await click('#media-grid .media-tile[data-id="m2"] [data-play]'); await sleep(900);
  ok('playing a YouTube video stops the Instagram player (one thing at a time)', await js(`return !document.querySelector('[data-igstage]') && !!document.querySelector('#media-grid .media-tile.playing[data-id="m2"] iframe');`));
  await js(`EWMedia.stopAll(); return 1;`); await sleep(400);

  console.log('\nSync: an #ew-igc= link');
  const before = (await media())[0].posts.map((x) => x.c);
  const seedNow = await js(`return JSON.stringify(__fakeFs.docs);`).then(JSON.parse);
  const payload = { v: 2, cid: CID, user: 'tony', slug: 'discipline', name: 'Discipline', posts: [post('NEWaaaa6'), post('VIDaaaa1'), post('PICaaaa3'), post('VIDaaaa2')] };
  await fresh({ seed: seedNow, hash: '#ew-igc=' + b64(payload) });
  mm = await media();
  const keep = before.filter((x) => ['VIDaaaa1', 'PICaaaa3', 'VIDaaaa2'].includes(x));
  ok("it merges into the collection: Tony's order kept, the new post on top, unsaved ones gone", mm[0].posts.map((x) => x.c).join() === ['NEWaaaa6'].concat(keep).join() && mm[0].igc.at > Date.now() - 60000, mm[0].posts.map((x) => x.c).join());
  ok("a current bookmark's sync asks nothing", !(await js(`return document.getElementById('uim-overlay') && document.getElementById('uim-overlay').classList.contains('show');`)));
  ok('it says what changed', /Synced “Discipline”: 4 posts, 1 new, 2 unsaved\./.test(await toast()), await toast());
  ok('the link is gone from the address, and Mindset is open', await js(`return location.hash === '' && EWApp.current() === 'mindset';`));
  await sleep(2700);
  const other = { v: 1, cid: '17999999999999999', user: 'tony', slug: 'calm_mind', posts: [post('VIDbbbb1'), post('PICbbbb2')] };
  await fresh({ seed: await js(`return JSON.stringify(__fakeFs.docs);`).then(JSON.parse), hash: '#ew-igc=' + b64(other) });
  mm = await media();
  await sleep(1200);
  ok('a sync from an older bookmark (no covers or media links) asks once to replace the bookmark', await js(`return document.getElementById('uim-overlay').classList.contains('show') && document.getElementById('uim-title').textContent === 'Update your sync bookmark';`));
  await js(`document.getElementById('uim-ok').click(); return 1;`);
  ok('a collection not linked yet arrives as a new one on top of Mindset, named from its address', mm[0].igc && mm[0].igc.cid === '17999999999999999' && mm[0].title === 'Calm mind' && mm[0].posts.length === 2 && mm[0].url === 'https://www.instagram.com/tony/saved/calm_mind/17999999999999999/' && mm[1].id === 'col1', JSON.stringify(mm[0]).slice(0, 300));
  await sleep(2700);
  await fresh({ seed: await js(`return JSON.stringify(__fakeFs.docs);`).then(JSON.parse), hash: '#ew-igc=' + b64({ cid: 'nope', user: 'x', posts: [] }) });
  ok('a damaged sync link changes nothing and says so', /could not be read/.test(await toast()) && (await media()).length === 5);

  console.log('\nSync: the bookmarklet, on a (fake) Instagram collection page');
  const mark = await js(`return EWMedia.igMark();`);
  const code = decodeURIComponent(mark.slice('javascript:'.length));
  const runMark = async (url) => {
    await c.send('Page.navigate', { url }); await sleep(900);
    await js(`window.__alerts = []; window.alert = (m) => { window.__alerts.push(m); }; return 1;`);
    await c.send('Runtime.evaluate', { expression: code });
  };
  let docs = await js(`return JSON.stringify(__fakeFs.docs);`).then(JSON.parse);
  API.fail = false; API.pages = [['APIaaaa1', 'VIDaaaa1'], ['APIaaaa2']];
  await runMark(COLL); await sleep(3500);
  ok("it read the collection through Instagram's web API (both pages) and came back to Everwell with it", (await js(`return location.href;`)).indexOf(PAGE) === 0 &&
    net.filter((u) => /api\/v1\/feed\/collection\/17912345678901234\/posts/.test(u)).length === 2);
  await js(`document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1500);
  mm = await media();
  const col = mm.find((x) => x.id === 'col1');
  ok('…and the merge used what it read (new posts on top, kinds and captions from Instagram)', col && col.posts.map((x) => x.c).join() === 'APIaaaa1,APIaaaa2,VIDaaaa1' && col.posts[0].t === 'caption of APIaaaa1' && col.posts[0].u === 'acct', col && col.posts.map((x) => x.c).join());
  ok('…with each post\'s cover (about 640 wide) and media links: the photo at its largest, the reel\'s video and poster', col && col.posts[0].i === 'https://scontent-x.cdninstagram.com/APIaaaa1-640.jpg' &&
    JSON.stringify(col.posts[0].m) === JSON.stringify([{ t: 'i', u: 'https://scontent-x.cdninstagram.com/APIaaaa1-1080.jpg', w: 1080, h: 1350 }]) &&
    JSON.stringify(col.posts[2].m) === JSON.stringify([{ t: 'v', u: 'https://scontent-x.cdninstagram.com/VIDaaaa1.mp4', w: 1080, h: 1350, p: 'https://scontent-x.cdninstagram.com/VIDaaaa1-640.jpg' }]), col && JSON.stringify(col.posts.slice(0, 3)).slice(0, 600));
  ok('…and from now on Sync goes straight to Instagram (the bookmark is known)', await js(`return localStorage.getItem('ew.tony.igBm') === '1';`));
  docs = await js(`return JSON.stringify(__fakeFs.docs);`).then(JSON.parse);
  await js(`sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(docs))}); return 1;`);
  API.fail = true;
  await runMark(COLL); await sleep(7500);
  await js(`const o = document.getElementById('ew-intro-overlay'); if (o) o.click(); return 1;`); await sleep(1500);
  mm = await media();
  ok("when Instagram's API refuses, it reads the page's own post links instead", (mm.find((x) => x.id === 'col1') || { posts: [] }).posts.map((x) => x.c).join() === 'LNKaaaa1,LNKaaaa2', JSON.stringify((mm.find((x) => x.id === 'col1') || {}).posts));
  await runMark('https://www.instagram.com/tony/'); await sleep(600);
  ok('on any other Instagram page it only explains, and goes nowhere', (await js(`return (window.__alerts || []).join();`)).indexOf('open one of your saved collections') >= 0 && (await js(`return location.href;`)) === 'https://www.instagram.com/tony/');

  console.log('\nLinking and removing');
  await fresh(); await go('mindset');
  await js(`const u = document.getElementById('media-url'); u.value = 'https://www.instagram.com/tony/saved/evening_calm/17888888888888888/'; document.getElementById('media-add').requestSubmit(); return 1;`); await sleep(1800);
  mm = await media();
  ok('pasting a collection link links it (empty until synced) and opens the how-to', mm[0].igc && mm[0].igc.cid === '17888888888888888' && mm[0].posts.length === 0 && mm[0].title === 'Evening calm' &&
    await js(`const d = document.getElementById('igd'); return !!d && /^Sync “Evening calm”$/.test(d.querySelector('h3').textContent) && d.querySelector('.igd-mark').getAttribute('href').indexOf('javascript:') === 0 && document.activeElement === d.querySelector('.ew-dlg');`));
  await js(`window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; document.querySelector('#igd [data-igd="go"]').click(); return 1;`); await sleep(300);
  ok('"Open on Instagram" opens the collection itself', await js(`return window.__opened[0] === 'https://www.instagram.com/tony/saved/evening_calm/17888888888888888/' && !document.getElementById('igd');`));
  ok('an unsynced collection says so on its tile', await js(`const t = document.querySelector('#media-grid [data-id="${mm[0].id}"]'); return !!t && /not synced yet/.test(t.textContent);`));
  await click('#mind-media [data-iglink]'); await sleep(400);
  await js(`document.getElementById('igd-url').value = 'https://www.instagram.com/tony/'; document.querySelector('#igd [data-igd="go"]').click(); return 1;`); await sleep(200);
  ok('the link dialog refuses a link that is not a collection', /not a saved-collection link/.test(await js(`return document.getElementById('igd-err').textContent;`)));
  await js(`document.getElementById('igd-url').value = 'https://www.instagram.com/tony/saved/all-posts/'; document.querySelector('#igd [data-igd="go"]').click(); return 1;`); await sleep(1800);
  mm = await media();
  ok('…and links a good one, opening Instagram on it', mm[0].igc.cid === 'all' && mm[0].title === 'All saved' && await js(`return window.__opened[1] === 'https://www.instagram.com/tony/saved/all-posts/';`),
    JSON.stringify(mm[0]).slice(0, 200) + ' ' + await js(`return JSON.stringify(window.__opened) + (document.getElementById('igd') ? ' dialog still open: ' + document.getElementById('igd-err').textContent : '');`));
  await click(`#media-grid [data-rm="${mm[0].id}"]`); await sleep(400);
  ok('removing a collection asks first, and says Instagram is untouched', await js(`return document.getElementById('uim-title').textContent === 'Remove collection?' && /Nothing changes on Instagram/.test(document.getElementById('uim-msg').textContent);`));
  await js(`document.getElementById('uim-ok').click(); return 1;`); await sleep(1800);
  ok('…then it is gone', !(await media()).some((x) => x.igc && x.igc.cid === 'all'));

  console.log('\nPhone (390px)');
  await size(390, 844, true); await sleep(500);
  await click('#media-grid .igc-cell[data-id="col1~VIDaaaa1"]'); await sleep(1000);
  ok('the player fits the phone: the post as big as the screen allows, every control on screen', await js(`const s = document.querySelector('[data-igstage]'), W = document.documentElement.clientWidth;
    return [...s.querySelectorAll('.ig-box, .ig-side button, .ig-side a')].every(e => { const r = e.getBoundingClientRect(); return r.left >= -0.5 && r.right <= W + 0.5; }) && (b => b.height <= innerHeight * 0.75 && b.width >= 200)(s.querySelector('.ig-box').getBoundingClientRect());`),
    await js(`const s = document.querySelector('[data-igstage]'); if (!s) return 'no stage'; return [...s.querySelectorAll('.ig-box, .ig-side button, .ig-side a')].map(e => { const r = e.getBoundingClientRect(); return (e.className || e.tagName) + ':' + Math.round(r.left) + '-' + Math.round(r.right); }).join(' ') + ' W=' + document.documentElement.clientWidth;`));
  ok('phone: the arrows sit beside the post, never over it, and no control row under it', await js(`const s = document.querySelector('[data-igstage]'), b = s.querySelector('.ig-box').getBoundingClientRect(), pv = s.querySelector('.ig-nav.pv').getBoundingClientRect(), nx = s.querySelector('.ig-nav.nx').getBoundingClientRect();
    return pv.width > 0 && pv.right <= b.left + 0.5 && nx.left >= b.right - 0.5 && getComputedStyle(s.querySelector('.ig-ctl')).display === 'none';`));
  ok('phone: the preview caption is no scroll box, so a swipe on it scrolls the page', await js(`const c = getComputedStyle(document.querySelector('[data-igstage] .ig-cap')); return /clip|hidden/.test(c.overflowY) && c.overscrollBehaviorY === 'auto' && c.touchAction === 'pan-y';`));
  // A finger swipe, read from touch events (iPhone WebKit cancels the pointer mid-swipe).
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const swipe = async (x0, y, d) => { const t = (type, x) => c.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await t('touchStart', x0); for (let i = 1; i <= 8; i++) { await t('touchMove', x0 + i * d); await sleep(16); } await t('touchEnd'); await sleep(1100); };
  const bx = JSON.parse(await js(`const r = document.querySelector('[data-igstage] .ig-box').getBoundingClientRect(); return JSON.stringify({ x: r.left, y: r.top + r.height / 2, w: r.width });`));
  await swipe(bx.x + bx.w * 0.8, bx.y, -20);
  ok('phone: a finger swiping left on the post moves to the next post', (await stage()).pos === 'Discipline · 2 of 5', (await stage()).pos);
  await swipe(bx.x + bx.w * 0.2, bx.y, 20);
  ok('…right, back again', (await stage()).pos === 'Discipline · 1 of 5', (await stage()).pos);
  await swipe(bx.x + bx.w + 30, bx.y + 150, -25);
  ok('…and a swipe in the margin beside the post counts too', (await stage()).pos === 'Discipline · 2 of 5', (await stage()).pos);
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await click('#media-grid [data-igstage] .ig-side [data-igs="side"]'); await sleep(400);
  ok('phone, details hidden: the small bar sits above the post, never over it or its mute', await js(`const s = document.querySelector('[data-igstage]'), b = s.querySelector('.ig-box').getBoundingClientRect(), m = s.querySelector('.ig-mute').getBoundingClientRect();
    const bs = [...s.querySelectorAll('.ig-bare button')].map(e => e.getBoundingClientRect()); return bs.length === 3 && bs.every(r => r.height > 0 && r.bottom <= b.top + 0.5 && !(r.bottom > m.top && r.top < m.bottom && r.right > m.left && r.left < m.right));`));
  await click('#media-grid [data-igstage] .ig-bare [data-igs="side"]'); await sleep(300);
  await click('#media-grid .igc-cell[data-id="col1~CARaaaa4"]'); await sleep(900);
  await click('#media-grid [data-igstage] .ig-nav.nx'); await sleep(500);
  ok('phone: in a carousel the side arrow turns its slides first', (await stage()).img === 'https://cdn.test/CARaaaa42.svg' && (await stage()).pos === 'Discipline · 4 of 5');
  await click('#media-grid [data-igstage] .ig-nav.nx'); await sleep(400); await click('#media-grid [data-igstage] .ig-nav.nx'); await sleep(900);
  ok('…then, after its last slide, the next post', (await stage()).pos === 'Discipline · 5 of 5', (await stage()).pos);
  await click('#media-grid .igc-cell[data-id="col1~VIDaaaa1"]'); await sleep(900);
  await click('#media-grid [data-igs="fill"]'); await sleep(500);
  ok('filled on a phone it is exactly the screen', await js(`const r = document.querySelector('[data-igstage]').getBoundingClientRect(); return r.left === 0 && r.width === innerWidth && r.height === innerHeight;`));
  await click('#media-grid [data-igs="fill"]'); await click('#media-grid [data-igs="close"]'); await sleep(400);
  await go('focus');
  await click('#focus-grid [data-play]'); await sleep(1200);
  ok('a playing YouTube video takes the card\'s full width, and Fill / Full screen / mute all sit inside it', await js(`const t = document.querySelector('#focus-grid .media-tile.playing'), card = t.closest('.card').getBoundingClientRect(), r = t.getBoundingClientRect();
    const fr = t.querySelector('.media-frame').getBoundingClientRect();
    const btns = [...t.querySelectorAll('.vp-row .vp-b, .vp-top .vp-b')];
    return Math.abs(r.left - card.left) <= 1.5 && Math.abs(r.right - card.right) <= 1.5 && btns.length >= 4 && btns.every(b => { const x = b.getBoundingClientRect(); return x.left >= fr.left - 0.5 && x.right <= fr.right + 0.5; }) &&
      !!t.querySelector('.vp-row .vp-fillb') && !!t.querySelector('.vp-row .vp-fsb') && !!t.querySelector('.vp-top .vp-adb');`));
  await js(`EWMedia.stopAll(); return 1;`);
  await size(1280, 900);

  console.log('\nRecipes and the routine sheet');
  await go('nutrition');
  await js(`EWRec.recOpenEdit('rA'); return 1;`); await sleep(500);
  ok('the editor reads old string tools and new ones with a quantity', await js(`return [...document.querySelectorAll('#rec-tool-rows .re-row')].map(r => [...r.querySelectorAll('input')].map(i => i.value).join('|')).join(',') === 'Large pot|,Wooden spoon|2';`));
  ok('…its category is a chip and its head wears the colour; no field has the focus', await js(`return document.querySelector('#rec-cats-pick .re-chip.on').dataset.cat === 'Dinner' && document.activeElement === document.querySelector('#rec-modal .rec-mbox');`));
  await js(`document.querySelector('#rec-tool-rows .re-row input.q').value = '1'; document.querySelector('#rec-cats-pick [data-cat="Lunch"]').click(); EWRec.recSave(); return 1;`); await sleep(1800);
  ok('saving stores tools as {name, qty}', await js(`const r = __fakeFs.docs['dashboards/mealsuite'].recipes[0]; return JSON.stringify(r.tools) === JSON.stringify([{ name: 'Large pot', qty: '1' }, { name: 'Wooden spoon', qty: '2' }]) && r.category === 'Lunch';`),
    await js(`return JSON.stringify(__fakeFs.docs['dashboards/mealsuite'].recipes[0].tools);`));
  await js(`EWRec.recOpenDetail('rA'); return 1;`); await sleep(400);
  ok('the recipe lists its tools as a checklist with their quantities', await js(`return [...document.querySelectorAll('.rec-tools .rb-ing')].map(b => b.querySelector('.nm').textContent + '=' + b.querySelector('.qt').textContent).join() === 'Large pot=1,Wooden spoon=2';`));
  await click('.rec-tools .rb-ing[data-t="1"]'); await sleep(200);
  ok('…ticked off with a tap', await js(`return document.querySelector('.rec-tools .rb-ing[data-t="1"]').classList.contains('got') && !document.querySelector('.rec-tools .rb-ing[data-t="0"]').classList.contains('got');`));
  await js(`EWRec.recBack(); return 1;`);
  await go('fitness'); await js(`document.getElementById('mc-nav-routines').click(); return 1;`); await sleep(300);
  await click('#mc-routines-list .routine-card .fx-name'); await sleep(600);
  ok('the routine sheet: its split, exercises numbered across sections, only the exercise count (no sets or minutes totals)', await js(`const s = document.getElementById('mc-sheet');
    const nums = [...s.querySelectorAll('.sh-rt .routine-line')].map(l => getComputedStyle(l, '::before').content).join();
    const stats = [...s.querySelectorAll('.sh-stat')].map(x => x.textContent).join('|');
    return nums === 'counter(ex),counter(ex),counter(ex),counter(ex),counter(ex)' && getComputedStyle(s.querySelector('.sh-rt')).counterReset === 'ex 0' && getComputedStyle(s.querySelector('.sh-rt .routine-group')).counterReset === 'none' && stats === '5Exercises' && s.querySelectorAll('.sh-rt .routine-group').length === 4;`),
    await js(`const s = document.getElementById('mc-sheet'); return [...s.querySelectorAll('.sh-stat')].map(x => x.textContent).join('|') + ' / ' + [...s.querySelectorAll('.sh-rt .routine-line')].map(l => getComputedStyle(l, '::before').content).join();`));
  await click('#mc-sheet [data-act="sheet-close"]');

  console.log('\nReels Instagram\'s embed gives only as a cover (2026-10-13)');
  const NV = 'https://www.instagram.com/tony/saved/mindset/17966666666666666/';
  const nvSeed = SEED();
  nvSeed['dashboards/everwell_tony'].mindsetMedia = [{ id: 'nv', url: NV, title: 'Mindset', igc: { cid: '17966666666666666', user: 'tony', slug: 'mindset', at: Date.now() - 60e3 }, expanded: true, posts: [
    Object.assign(post('NOVreel01', 'r', 6), { m: [{ t: 'v', u: 'https://scontent-x.cdninstagram.com/NOVreel01.mp4', p: 'https://scontent-x.cdninstagram.com/NOVreel01-640.jpg', w: 720, h: 1280 }] }),
    post('OLDreel02', 'r', 8),
    Object.assign(post('NOVgone03', 'r', 5), { m: [{ t: 'v', u: 'https://scontent-x.cdninstagram.com/gone.mp4', w: 720, h: 1280 }] }),
    Object.assign(post('OLDreel04', 'r', 5), { m: [{ t: 'v', u: 'https://scontent-x.cdninstagram.com/OLDreel04.mp4', w: 720, h: 1280 }] })] }];
  await fresh({ seed: nvSeed }); await go('mindset');
  await click('#media-grid .igc-cell[data-id="nv~NOVreel01"]'); await sleep(900);
  s = await stage();
  ok('a reel the worker flags noVideo plays the video (with its sound) the sync brought back, not a still', s.v === 'https://personal-ai.av1.workers.dev/ig/px?u=' + encodeURIComponent('https://scontent-x.cdninstagram.com/NOVreel01.mp4') && !/\bimg\b/.test(s.cls) && !s.img, JSON.stringify(s));
  ok('…with the full caption and account from the worker (the sync keeps only a snippet)', s.who === '@nov.acct' && /the whole caption of NOVreel01/.test(s.cap), JSON.stringify(s));
  await click('#media-grid [data-igstage] .ig-ctl [data-igs="next"]'); await sleep(900);
  s = await stage();
  ok("a reel with no synced video (an older worker answer: a cover, no flag) plays in Instagram's own player, not as a silent still", s.frame === 'https://www.instagram.com/p/OLDreel02/embed/captioned/' && /embed/.test(s.cls) && !s.img, JSON.stringify(s));
  await click('#media-grid [data-igstage] .ig-ctl [data-igs="next"]'); await sleep(1200);
  s = await stage();
  ok("a synced video link that ran out falls back to Instagram's player (the post is public), not \"needs a sync\"", s.frame === 'https://www.instagram.com/p/NOVgone03/embed/captioned/' && !/gone/.test(s.cls), JSON.stringify(s));
  await click('#media-grid [data-igstage] .ig-ctl [data-igs="next"]'); await sleep(900);
  s = await stage();
  ok('an unflagged cover for a reel still prefers the synced video', s.v === 'https://personal-ai.av1.workers.dev/ig/px?u=' + encodeURIComponent('https://scontent-x.cdninstagram.com/OLDreel04.mp4'), JSON.stringify(s));
  await js(`EWMedia.stopAll(); return 1;`); await sleep(300);

  console.log('\nDisplay');
  net.length = 0;
  await fresh({ display: true }); await go('focus');
  ok('Focus shows a sample collection with placeholder covers', await js(`const t = document.querySelector('#focus-grid .igc-tile[data-id="demo-f5"]'); return !!t && t.querySelectorAll('.igc-strip .igc-ph').length === 4 && !t.querySelector('img');`));
  await click('#focus-grid .igc-tile [data-igplay]'); await sleep(400);
  ok('tapping it plays nothing and says so', /Nothing plays here/.test(await toast()) && !(await js(`return !!document.querySelector('[data-igstage]');`)));
  await go('mindset');
  ok('Display touched no Instagram, CDN or /ig worker route', net.length === 0, net.join(' '));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
