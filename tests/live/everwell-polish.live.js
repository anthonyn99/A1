// Everwell (A1-Priv/everwell.html) Phase 8, Polish: the responsive audit,
// reduced motion and a clean console, in the real page against the fake
// Firebase. Nothing here reaches the network.
//
//   - every tab, in BOTH profiles, at 360px and 320px: no element spills past
//     the screen's edge (body has overflow-x:hidden, so scrollWidth alone would
//     hide a clipped spill; every box is measured instead), and the header row
//     fits; the same for the dialogs a phone opens (rotation, routines, a
//     circuit, a recipe)
//   - reduced motion: no CSS animation or transition runs anywhere, the
//     backdrop is one still frame, and smooth scrolling is off
//   - no uncaught exception, console.error or failed request on any of it
//
// AUDIT=1 prints every offender instead of only the first few.
// Run: node tests/live/everwell-polish.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, process.env.AUDIT ? 4000 : 600) : '')); }
};
const BASE = 'https://anthonyn99.github.io/A1/';
const PAGE = BASE + 'everwell.html';
const TABS = ['dashboard', 'fitness', 'nutrition', 'prayer', 'mindset', 'goals', 'focus'];

const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://ddragon.leagueoflegends.com/*', 'https://warroom-api.av1.workers.dev/*', 'https://personal-ai.av1.workers.dev/*',
    'https://www.youtube-nocookie.com/*', 'https://www.instagram.com/*', 'https://i.ytimg.com/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = new URL(req.url), p = u.pathname;
    if (u.host === 'i.ytimg.com') return { status: 404, text: '' };
    if (/\.png$/.test(p)) return { text: '', type: 'image/png' };   // the R icon: an empty 200 (the mock sends text only)
    if (u.host === 'www.youtube-nocookie.com' || u.host === 'www.instagram.com') return { text: '<!doctype html><title>fake player</title>', type: 'text/html' };
    if (u.host === 'personal-ai.av1.workers.dev' && p === '/quote/daily')
      return { json: { ok: true, date: u.searchParams.get('date'), text: 'A long enough line of the day that wraps across a narrow phone screen without trouble.', via: 'orca' } };
    if (u.host === 'warroom-api.av1.workers.dev') return { json: ['16.99.1'] };
    if (u.host === 'ddragon.leagueoflegends.com') {
      if (p === '/api/versions.json') return { json: ['16.99.1'] };
      if (/Yunara\.json$/.test(p)) return { json: { data: { Yunara: { title: 'the Unbroken Faith', spells: [{}, {}, {}, { name: "Transcend One's Self", description: 'Yunara enters a Transcendent State that upgrades <br>her basic Abilities.', image: { full: 'YunaraR.png' } }] } } } };
      return { status: 404, text: '' };
    }
    if (p === '/auth/journal/status-many') {   // no lock anywhere (a missing answer would gate the app)
      const out = {}; ((req.postData ? JSON.parse(req.postData) : {}).locks || []).forEach((l) => { out[l.journal + ':' + l.entryId] = { hasLock: false, ver: null }; });
      return { json: { ok: true, locks: out } };
    }
    return { json: { ok: false } };
  },
};

// Tony's seed: long names on purpose, the things a narrow screen breaks on.
const LONG = 'Supercalifragilistic Posterior Chain Mobility Sequence';
const SEED = {
  'dashboards/motioncore': { savedAt: 1,
    circuits: [{ id: 'c1', name: LONG, desc: 'A description long enough to wrap on a phone screen, twice over at least.', _open: true, modules: [{ id: 'm1', name: 'Plank with shoulder taps and reach', time: 3, desc: 'Keep the hips square' }, { id: 'm2', name: 'Crunch', time: 2, desc: '' }] },
      { id: 'c2', name: 'Second', _open: false, modules: [{ id: 'm3', name: 'Burpee', time: 5 }] }],
    routines: [{ id: 'r1', name: 'Push Day', content: 'Bench Press - 4 x 8\n\nIncline Dumbbell Press With A Pause At The Bottom - 3 x 10\n\nDips - 3 x 10', _open: true },
      { id: 'r2', name: 'Pull Day', content: 'Rows - 4 x 8', _open: false }, { id: 'r3', name: 'Leg Day', content: 'Squat - 5 x 5', _open: false }] },
  'dashboards/mealsuite': { savedAt: 1, recipes: [
    { id: 'rA', name: 'Overnight Oats With Blueberries, Chia And Greek Yoghurt', category: 'Breakfast', prepTime: '5 min', servings: '1', ingredients: [{ name: 'Rolled oats, old-fashioned (not instant)', qty: '1/2 cup' }, { name: 'Milk', qty: '1/2 cup' }], tools: ['Jar with a tight lid'], instructions: '1. Mix everything in the jar and stir thoroughly so the chia does not clump\n2. Chill overnight' },
    { id: 'rB', name: 'Steak Night', category: 'Dinner', prepTime: '', servings: '', ingredients: [], tools: [], instructions: '' }] },
  'dashboards/everwell_tony': {
    focusMedia: [{ id: 'f1', url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', title: 'A very long focus video title that should wrap or clip neatly' },
      { id: 'f2', url: 'https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', title: 'Playlist' },
      { id: 'f3', url: 'https://www.youtube.com/shorts/abcdefghijk', title: 'Short' },
      { id: 'f4', url: 'https://ice1.somafm.com/groovesalad-128-mp3', title: 'Groove Salad' }],
    mindsetMedia: [{ id: 'm1', url: 'https://www.instagram.com/reel/ABCdef123/', title: 'Reel' }, { id: 'm2', url: 'https://youtu.be/jfKfPfyJRdk', title: 'Video' }] },
  'dashboards/everwell_notes': { _order: ['prayer', 'goals-mindset', 'relationship-principles', 'with-parents'],
    e_prayer: { id: 'prayer', template: 'page', title: 'Prayer', data: { html: '<p><strong>Thank you</strong> for an unreasonably long sentence with averyveryveryverylongunbrokenwordthatcouldpushthelayoutsideways.</p>' } },
    'e_goals-mindset': { id: 'goals-mindset', template: 'page', title: 'Goals & Mindset', data: { html: '<h2>Heading</h2><ul><li>alpha</li></ul><ol><li>one</li></ol>' } },
    'e_relationship-principles': { id: 'relationship-principles', template: 'page', title: 'Relationship Principles', data: { html: '<p>p</p>' } },
    'e_with-parents': { id: 'with-parents', template: 'page', title: 'With Parents', data: { html: '<ol><li>p1</li></ol>' } } },
};

// Every visible box past the screen's edge, outermost only, unless a scroller
// or clipper that itself fits on screen holds it (the tab strip, a dialog).
const OFFENDERS = `(() => {
  const W = document.documentElement.clientWidth, out = [];
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const bad = (e) => {
    const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    if (cs.position === 'absolute' && cs.clip !== 'auto') return false;
    if (r.right <= W + 0.5 && r.left >= -0.5) return false;
    for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (a !== document.body && /(auto|scroll|hidden|clip)/.test(s.overflowX)) { const ar = a.getBoundingClientRect(); if (ar.right <= W + 0.5 && ar.left >= -0.5) return false; }
      if (s.display === 'none') return false;
    }
    return r;
  };
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('#ew-backdrop, canvas, svg *, a1-lifehub, guardian-lock')) continue;
    const r = bad(e); if (!r) continue;
    if (e.parentElement && bad(e.parentElement)) continue;
    out.push(name(e) + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + W + ']');
  }
  return JSON.stringify(out);
})()`;

// Visible buttons, links, inputs and selects with no accessible name.
const NAMELESS = `JSON.stringify([...document.querySelectorAll('#ew-head button, #ew-head a, #ew-tabs button, #ew-main button, #ew-main a[href], #ew-main input:not([type=hidden]), #ew-main select, #ew-main textarea')].filter(e => {
  if (!e.offsetWidth || !e.offsetHeight) return false;
  const lab = e.labels && e.labels.length ? [...e.labels].map(l => l.textContent).join('') : '';
  const by = e.getAttribute('aria-labelledby'); const byText = by ? by.split(/\s+/).map(i => (document.getElementById(i) || {}).textContent || '').join('') : '';
  return !((e.getAttribute('aria-label') || '') + (e.getAttribute('title') || '') + lab + byText + (e.textContent || '') + (e.getAttribute('placeholder') || '') + (e.querySelector('img[alt]:not([alt=""])') ? 'img' : '')).trim();
}).map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/)[0] : '') + (e.dataset.act ? '[' + e.dataset.act + ']' : '')))`;

(async () => {
  const c = await connect({ mock: firebaseMock(mock) });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable'); await c.send('Log.enable');
  const errs = [];
  const IGNORE = /AppCheck|ReCaptchaV3Provider|i\.ytimg\.com/;
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data), p = m.params;
    let t = null;
    if (m.method === 'Runtime.exceptionThrown') t = 'exception: ' + ((p.exceptionDetails.exception || {}).description || p.exceptionDetails.text || '');
    if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') t = 'console.error: ' + p.args.map((a) => a.value !== undefined ? a.value : a.description).join(' ');
    if (m.method === 'Log.entryAdded' && p.entry.level === 'error') t = 'log: ' + p.entry.text + ' ' + (p.entry.url || '');
    if (t && !IGNORE.test(t)) errs.push(t.slice(0, 300));
  });
  const js = (e) => evalJs(c, e);
  const size = (w) => c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 760, deviceScaleFactor: 2, mobile: true });
  const fresh = async (display) => {
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(300);
    await js(`localStorage.clear(); sessionStorage.clear(); ${display ? "sessionStorage.setItem('ew.profile', 'display');" : `sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(SEED))});`} return 1;`);
    await c.send('Page.navigate', { url: PAGE }); await sleep(2800);
    await js(`document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1200);
  };
  const offenders = async () => JSON.parse(await js(`return ${OFFENDERS};`));
  const show = (o) => (process.env.AUDIT ? o : o.slice(0, 6)).join(' | ');
  const headerFits = () => js(`const row = document.querySelector('.ew-head-row'); return row.scrollWidth <= row.clientWidth + 0.5 && [...row.children].every(e => !e.offsetWidth || e.getBoundingClientRect().right <= innerWidth + 0.5);`);
  const closeAll = () => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelectorAll('#mc-root .modal-backdrop.open, #mc-root .modal-overlay.open').forEach(m => m.classList.remove('open'));
    const rm = document.getElementById('rec-modal'); if (rm) rm.style.display = 'none';
    const back = [...document.querySelectorAll('#ew-body-nutrition button')].find(b => /back to recipes|recipe book/i.test(b.textContent)); if (back) back.click();
    if (window.EWReader) EWReader.close(); return 1;`);

  // Each dialog a phone opens: [tab, label, js that opens it, selector of its box].
  const DIALOGS = [
    ['dashboard', 'Edit rotation', `document.querySelector('#ew-body-dashboard [data-act="edit-rot"]').click()`],
    ['dashboard', 'Routines', `document.querySelector('#ew-body-dashboard [data-act="pairs"]').click()`],
    ['nutrition', 'a recipe', `document.querySelector('#ew-body-nutrition .rec-row .rec-name').click()`],
    ['fitness', 'a circuit sheet', `document.querySelector('#ew-body-fitness .circuit-card .fx-name').click()`],
    ['mindset', 'the reader', `EWMindset.show('writings'); document.querySelector('#ew-body-mindset .wr-card .wr-title').click()`],
  ];

  for (const display of [false, true]) {
    const who = display ? 'Display' : 'Tony';
    await size(360);
    await fresh(display);
    ok(`${who}: the app is open with every tab (else nothing below means anything)`, await js(`return document.getElementById('ew-app').classList.contains('on') && document.querySelectorAll('.ew-tab').length === 7;`));
    for (const w of [360, 320]) {
      console.log('\n' + who + ' at ' + w + 'px');
      await size(w); await sleep(500);
      ok(`${who} ${w}px: the header row fits (tagline, pills, lock, LifeHub)`, await headerFits(),
        await js(`return [...document.querySelector('.ew-head-row').children].filter(e => e.offsetWidth).map(e => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().left) + '-' + Math.round(e.getBoundingClientRect().right)).join(' ') + ' / ' + innerWidth;`));
      for (const t of TABS) {
        await js(`EWApp.go('${t}'); return 1;`); await sleep(t === 'nutrition' || t === 'fitness' ? 1400 : 900);
        const o = await offenders(), shown = await js(`const b = document.getElementById('ew-body-${t}'); return !!b && b.dataset.state === 'open' && b.children.length > 0;`);
        ok(`${who} ${w}px ${t}: rendered, nothing past the edge`, shown && o.length === 0, shown ? show(o) : 'not rendered');
        if (w === 360) {
          const nameless = JSON.parse(await js(`return ${NAMELESS};`));
          ok(`${who} ${t}: every visible control has a name (screen readers)`, nameless.length === 0, nameless.join(' | '));
        }
      }
      for (const [tab, label, open] of DIALOGS) {
        await js(`EWApp.go('${tab}'); return 1;`); await sleep(900);
        const r = await js(`try { ${open}; return 'opened'; } catch (e) { return 'cannot open: ' + e.message; }`); await sleep(700);
        if (r !== 'opened') { ok(`${who} ${w}px dialog ${label}: opens`, false, r + ' / ' + await js(`const b = document.getElementById('ew-body-${tab}'); return b ? b.innerText.slice(0, 300) : 'no body; current=' + EWApp.current() + ' ids=' + [...document.querySelectorAll('[id^=ew-body]')].map(e => e.id).join();`)); continue; }
        const o = await offenders();
        ok(`${who} ${w}px dialog ${label}: nothing past the edge`, o.length === 0, show(o));
        await closeAll(); await sleep(400);
      }
    }
  }

  // The intro mark must not shake while "Everwell" spreads its letters
  // (Tony, 2026-10-11): its left edge is sampled every frame of the entrance.
  // A phone's address bar hiding/showing while scrolling changes the window
  // height; that used to resize (and so wipe) the backdrop canvas: a black flash.
  console.log('\nPhone scroll: no black flash');
  await size(390); await fresh(false); await sleep(800);
  const bd = () => js(`const cv = document.getElementById('ew-bg-canvas'), p = cv.getContext('2d').getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
    return JSON.stringify({ w: cv.width, h: cv.height, px: p[0] + p[1] + p[2] });`).then(JSON.parse);
  const b0 = await bd();
  for (const h of [700, 640, 760, 700]) { await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: h, deviceScaleFactor: 2, mobile: true }); await sleep(60); }
  await sleep(400);
  const b1 = await bd();
  ok('the address bar coming and going leaves the backdrop canvas alone (no resize, no wipe)', b1.w === b0.w && b1.h === b0.h && b1.px > 0, JSON.stringify([b0, b1]));
  ok('…and it is as tall as the large viewport, so it always covers the screen', await js(`return document.getElementById('ew-backdrop').getBoundingClientRect().height >= innerHeight;`));
  await c.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 760, deviceScaleFactor: 2, mobile: true }); await sleep(500);
  ok('a real width change (rotation) still redraws it at the new size, painted', await js(`const cv = document.getElementById('ew-bg-canvas'), p = cv.getContext('2d').getImageData(5, 5, 1, 1).data; return cv.width === Math.round(430 * ${b0.w} / 390) && Math.round(cv.getBoundingClientRect().width) === 430 && p[0] + p[1] + p[2] > 0;`),
    await js(`return document.getElementById('ew-bg-canvas').width;`));

  console.log('\nIntro');
  const probe = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__markX = []; (function f(){ const m = document.querySelector('.ew-intro-mark'); if (m) window.__markX.push(m.getBoundingClientRect().left); if (window.__markX.length < 120) requestAnimationFrame(f); })();` });
  for (const w of [1440, 390]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: w < 500 ? 3 : 1, mobile: w < 500 });
    await c.send('Page.navigate', { url: PAGE }); await sleep(3000);
    const xs = JSON.parse(await js(`return JSON.stringify(window.__markX);`));
    ok(`intro ${w}px: the mark holds still sideways through the entrance (${xs.length} frames)`, xs.length > 40 && new Set(xs).size === 1, [...new Set(xs)].join(' '));
  }
  await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: probe.identifier });

  console.log('\nReduced motion');
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await size(390);
  await fresh(false);
  for (const t of TABS) {
    await js(`EWApp.go('${t}'); return 1;`); await sleep(600);
    const running = JSON.parse(await js(`return JSON.stringify(document.getAnimations().filter(a => a.playState === 'running' && (a.effect && a.effect.getComputedTiming().duration > 1)).map(a => (a.animationName || a.transitionProperty || 'js') + '@' + (a.effect.target ? (a.effect.target.id || a.effect.target.className) : '')));`));
    ok(`reduced motion ${t}: no animation running`, running.length === 0, running.join(' | '));
  }
  ok('reduced motion: the backdrop is one still frame', await js(`const s = EWBackdrop.state(); return !s.running && s.frames >= 1;`), await js(`return JSON.stringify(EWBackdrop.state());`));
  ok('reduced motion: no smooth scrolling anywhere', await js(`return [...document.querySelectorAll('*')].every(e => getComputedStyle(e).scrollBehavior !== 'smooth');`));
  await c.send('Emulation.setEmulatedMedia', { features: [] });
  await c.send('Emulation.clearDeviceMetricsOverride');

  console.log('\nConsole');
  ok('no exception, console.error or failed request on any of it', errs.length === 0, errs.join(' | '));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
