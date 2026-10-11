// Everwell (A1-Priv/everwell.html) Phase 1, in its real page served by cdp.js
// from ../A1-Priv, against the fake Firebase (fake-firebase.js) and a fake
// lock worker. Nothing here reaches the network.
//
//   - intro on every launch → app; the agreed default tab order
//   - tabs switch; a mouse drag and a touch hold-drag reorder them; the order
//     is written to dashboards/everwell_tony and survives a reload; another
//     device's order arrives live
//   - a tab lock keeps its pane EMPTY until unlocked (with Cancel), and "Lock
//     this device now" empties it again; the app lock is a hard gate after
//     the intro
//   - the Display profile loads no Firebase and no Tony launcher, writes none
//     of Tony's keys, and is reached and left without touching the URL
//   - phone width: no sideways scroll; reduced motion: the backdrop is still
//
// Run: node tests/live/everwell.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const BASE = 'https://anthonyn99.github.io/A1/';
const PAGE = BASE + 'everwell.html';

// Fake lock worker: recs['applock:<id>'] = password.
const recs = {};
const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = new URL(req.url), p = u.pathname, b = req.postData ? JSON.parse(req.postData) : {};
    if (p === '/auth/journal/status-many') {
      const out = {}; (b.locks || []).forEach((l) => { const k = l.journal + ':' + l.entryId; out[k] = { hasLock: !!recs[k], ver: recs[k] ? 'v1' : null }; });
      return { json: { ok: true, locks: out } };
    }
    if (p === '/auth/journal/verify') { const r = recs[b.journal + ':' + b.entryId]; return { json: r ? { ok: r === b.password } : { ok: false, noLock: true } }; }
    if (p === '/auth/journal/set-lock') { recs[b.journal + ':' + b.entryId] = b.password; return { json: { ok: true } }; }
    return { json: { ok: false } };
  },
};

(async () => {
  const c = await connect({ mock: firebaseMock(mock) });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  const errs = [], reqs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || '').slice(0, 300));
    if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url);
  });
  const js = (e) => evalJs(c, e);
  const sr = `document.querySelector('guardian-lock') && document.querySelector('guardian-lock').shadowRoot`;
  const dlg = () => js(`const s = ${sr}; const ov = s && s.querySelector('.ov');
    return JSON.stringify(ov ? { open: true, text: s.querySelector('.card').innerText, buttons: [...s.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean) } : { open: false });`).then(JSON.parse);
  const gtype = (ph, v) => js(`const s = ${sr}; const i = [...s.querySelectorAll('input')].find(i => i.placeholder === ${JSON.stringify(ph)}); if (!i) return 'missing'; i.value = ${JSON.stringify(v)}; return 1;`);
  const gclick = (t) => js(`const s = ${sr}; const b = [...s.querySelectorAll('button')].find(b => b.textContent.trim().indexOf(${JSON.stringify(t)}) === 0); if (!b) return 'missing'; b.click(); return 1;`).then(async (r) => { await sleep(900); return r; });
  const appOn = () => js(`return document.getElementById('ew-app').classList.contains('on');`);
  const introUp = () => js(`const o = document.getElementById('ew-intro-overlay'); return !o.hidden && getComputedStyle(o).display !== 'none';`);
  const rect = (sel) => js(`const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width });`).then(JSON.parse);
  const mouse = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const touch = (type, x, y) => c.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  // A clean device: no storage, no cookies, the fake store emptied, a profile.
  const fresh = async (opts) => {
    opts = opts || {};
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(300);
    await js(`localStorage.clear(); sessionStorage.clear(); document.cookie.split(';').forEach(k => document.cookie = k.split('=')[0].trim() + '=; path=/; max-age=0');
      ${opts.display ? "sessionStorage.setItem('ew.profile', 'display');" : ''} ${opts.seed || ''} return 1;`);
    reqs.length = 0;
    await c.send('Page.navigate', { url: PAGE }); await sleep(opts.wait || 2500);
  };
  let d0;
  const tapIntro = async () => { await js(`document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(900); };

  /* ── Tony, no locks ── */
  console.log('\nTony: intro, tabs, order sync');
  Object.keys(recs).forEach((k) => delete recs[k]);
  await fresh();
  ok('the intro is up on launch, the app hidden', (await introUp()) && !(await appOn()));
  ok('the intro reads Everwell / Mind. Health. Faith.', await js(`return /Everwell/.test(document.querySelector('.ew-intro-word').textContent) && document.querySelector('.ew-intro-sub').textContent === 'Mind. Health. Faith.';`));
  ok('the backdrop is animating the intro scene', await js(`const s = EWBackdrop.state(); return s.scene === 'intro' && s.running && s.frames > 5;`));
  ok('Tony loads Firebase (the fake)', reqs.some((u) => u.includes('/firebasejs/')));
  await tapIntro();
  ok('a tap leaves the intro for the app', (await appOn()) && !(await introUp()));
  ok('seven tabs in the agreed order', (await js(`return [...document.querySelectorAll('.ew-tab')].map(b => b.dataset.id).join();`)) === 'dashboard,fitness,nutrition,prayer,mindset,goals,focus');
  ok('Dashboard is open and rendered', await js(`return EWApp.current() === 'dashboard' && EWApp.rendered().dashboard === true && !!document.querySelector('#ew-body-dashboard .ew-soon');`));
  ok('the LifeHub launcher is there for Tony', await js(`return !!document.querySelector('a1-lifehub');`));
  await js(`document.getElementById('ew-tab-goals').click(); return 1;`); await sleep(400);
  ok('a click switches tab (aria-selected, pane, scene)', await js(`return EWApp.current() === 'goals' && document.getElementById('ew-tab-goals').getAttribute('aria-selected') === 'true' && document.getElementById('ew-pane-goals').classList.contains('on') && EWBackdrop.state().scene === 'goals';`));

  // Mouse drag: Focus (last) onto Dashboard (first).
  let a = await rect('#ew-tab-focus'), b = await rect('#ew-tab-dashboard');
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 14; i++) { await mouse('mouseMoved', a.x + (b.x - b.w / 2 - a.x) * i / 14, a.y); await sleep(16); }
  await mouse('mouseReleased', b.x - b.w / 2, a.y); await sleep(1600);
  ok('a mouse drag moves Focus to the front', (await js(`return EWApp.order()[0];`)) === 'focus', await js(`return EWApp.order().join();`));
  ok('the drop did not open Focus (the click is swallowed)', (await js(`return EWApp.current();`)) === 'goals');
  ok('the order is written to dashboards/everwell_tony (merge)', await js(`const d = __fakeFs.docs['dashboards/everwell_tony']; return !!d && d.tabOrder[0] === 'focus' && d.tabOrder.length === 7 && !!d.savedAt;`),
    await js(`return JSON.stringify(__fakeFs.docs['dashboards/everwell_tony']);`));

  await c.send('Page.reload'); await sleep(2500);
  ok('a reload shows the intro again', await introUp());
  await tapIntro();
  ok('…and keeps the order and the last tab', (await js(`return EWApp.order()[0] + '/' + EWApp.current();`)) === 'focus/goals');

  await js(`__fakeFs.remote('dashboards/everwell_tony', { tabOrder: ['prayer','dashboard','fitness','nutrition','mindset','goals','focus'], savedAt: Date.now() + 5 }, { merge: true }); return 1;`);
  await sleep(700);
  ok("another device's order arrives live", (await js(`return EWApp.order().join();`)) === 'prayer,dashboard,fitness,nutrition,mindset,goals,focus');
  await js(`const t = document.getElementById('ew-tab-mindset'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true, bubbles: true })); return 1;`); await sleep(1200);
  ok('Alt+Shift+Left moves the focused tab (keyboard reorder)', (await js(`return EWApp.order().indexOf('mindset');`)) === 3);
  ok('desktop tabs are slim (32px) and header controls 30px', await js(`return Math.round(document.getElementById('ew-tab-goals').getBoundingClientRect().height) === 32 && Math.round(document.getElementById('ew-lock-btn').getBoundingClientRect().height) === 30;`));

  // The Everwell mark beside the wordmark returns to the intro.
  await js(`document.getElementById('ew-intro-btn').click(); return 1;`); await sleep(500);
  ok('the mark button brings back the intro (app hidden, intro scene)', (await introUp()) && !(await appOn()) && (await js(`return EWBackdrop.state().scene === 'intro';`)));
  await tapIntro();
  ok('…and continuing returns to the same tab', (await appOn()) && !(await introUp()) && (await js(`return EWApp.current();`)) === 'goals');

  // Setting the app password from the header must not blank the page
  // (2026-10-11: Guardian fires onBlock mid-flow, with the biometrics card up).
  await js(`document.getElementById('ew-lock-btn').click(); return 1;`); await sleep(1000);
  await js(`const s = ${sr}; [...s.querySelectorAll('input')].forEach(i => { i.value = /hint/i.test(i.placeholder) ? 'h' : 'newpw'; }); [...s.querySelectorAll('button')].find(b => /^Set password/.test(b.textContent.trim())).click(); return 1;`);
  await sleep(1500);
  ok('setting the password keeps the app on screen (card still up)', await appOn(), await js(`return JSON.stringify(Guardian.status('tony_everwell_standalone'));`));
  d0 = await dlg(); if (d0.open) await gclick('Not now');
  ok('…and after the last card closes', (await appOn()) && !(await dlg()).open);
  delete recs['applock:tony_everwell_standalone'];

  /* ── Tab lock ── */
  console.log('\nTab lock');
  recs['applock:tony_everwell_tab_prayer'] = 'pray';
  await fresh();
  await tapIntro();
  await js(`document.getElementById('ew-tab-prayer').click(); return 1;`); await sleep(900);
  ok('the locked tab shows its lock in the strip', await js(`return !!document.querySelector('#ew-tab-prayer .ew-tab-lock');`));
  ok('the locked pane renders NOTHING of the section', await js(`const b = document.getElementById('ew-body-prayer'); return b.dataset.state === 'locked' && !b.querySelector('.ew-soon') && !!b.querySelector('[data-unlock]') && !EWApp.rendered().prayer;`),
    await js(`return document.getElementById('ew-body-prayer').dataset.state;`));
  await js(`document.querySelector('[data-unlock="prayer"]').click(); return 1;`); await sleep(800);
  let d = await dlg();
  ok('Unlock asks for the tab password, with Cancel', d.open && /Prayer/.test(d.text) && d.buttons.includes('Cancel'), JSON.stringify(d));
  await gtype('Password', 'pray'); await gclick('Unlock'); await sleep(400);
  d = await dlg(); if (d.open && /Not now/.test(d.buttons.join())) await gclick('Not now');
  ok('the right password renders the section', await js(`return !!document.querySelector('#ew-body-prayer .ew-soon') && EWApp.rendered().prayer === true;`));
  await js(`Guardian.lockNow('tony_everwell_tab_prayer'); return 1;`); await sleep(500);
  ok('"Lock this device now" empties it again', await js(`return !document.querySelector('#ew-body-prayer .ew-soon') && !EWApp.rendered().prayer && document.getElementById('ew-body-prayer').dataset.state === 'locked';`));
  ok('other tabs are unaffected', await js(`document.getElementById('ew-tab-goals').click(); return true;`) && (await js(`return document.getElementById('ew-body-goals').dataset.state;`)) === 'open');

  /* ── App lock ── */
  console.log('\nApp lock');
  recs['applock:tony_everwell_standalone'] = 'whole';
  await fresh({ wait: 3500 });
  ok('the intro still comes first', (await introUp()) && !(await dlg()).open);
  await tapIntro(); await sleep(800);
  d = await dlg();
  ok('then a hard gate (no Cancel), the app hidden', d.open && !d.buttons.includes('Cancel') && !(await appOn()), JSON.stringify(d));
  await gtype('Password', 'whole'); await gclick('Unlock'); await sleep(400);
  d = await dlg(); if (d.open && /Not now/.test(d.buttons.join())) await gclick('Not now');
  ok('the password opens the app', await appOn());
  delete recs['applock:tony_everwell_standalone']; delete recs['applock:tony_everwell_tab_prayer'];

  /* ── Display ── */
  console.log('\nDisplay profile');
  await fresh({ display: true });
  ok('Display loads no Firebase at all', !reqs.some((u) => /firebasejs|firestore\.googleapis|identitytoolkit|securetoken/.test(u)), reqs.filter((u) => /firebase|google/.test(u)).join(' '));
  // Real requests only: the data: manifest names this host in its JSON.
  const net = reqs.filter((u) => /^https?:/.test(u));
  ok('…and calls no worker', !net.some((u) => /^https:\/\/[^/]*\.workers\.dev\//.test(u)), net.filter((u) => /workers\.dev/.test(u)).join(' '));
  ok("the intro offers Tony's profile, not the Display one", await js(`return getComputedStyle(document.getElementById('ew-intro-tony')).display !== 'none' && getComputedStyle(document.getElementById('ew-intro-display')).display === 'none';`));
  await tapIntro();
  ok('no Tony launcher, no lock button, a clear demo badge', await js(`return !document.querySelector('a1-lifehub') && getComputedStyle(document.getElementById('ew-lock-btn')).display === 'none' && getComputedStyle(document.getElementById('ew-display-btn')).display !== 'none' && /demo/i.test(document.getElementById('ew-display-btn').textContent);`));
  ok('every pane says it is demo data', await js(`return /demo data/i.test(document.querySelector('#ew-body-dashboard .ew-demo-note').textContent);`));
  a = await rect('#ew-tab-goals'); b = await rect('#ew-tab-dashboard');
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', a.x + (b.x - b.w / 2 - a.x) * i / 12, a.y); await sleep(16); }
  await mouse('mouseReleased', b.x - b.w / 2, a.y); await sleep(1200);
  ok('Display can reorder (in memory)', (await js(`return EWApp.order()[0];`)) === 'goals');
  ok("…and writes none of Tony's keys", await js(`return Object.keys(localStorage).filter(k => k.indexOf('ew.') === 0).length === 0;`), await js(`return Object.keys(localStorage).join();`));
  ok('the address never changed', (await js(`return location.href;`)) === PAGE);
  await js(`document.getElementById('ew-display-btn').click(); return 1;`); await sleep(2500);
  ok("leaving Display reloads into Tony's profile, skipping the intro once", (await js(`return document.documentElement.dataset.ewProfile;`)) === 'tony' && !(await introUp()) && (await appOn()));
  ok("…with Display's reorder gone (it was memory only)", (await js(`return EWApp.order()[0];`)) === 'dashboard');

  /* ── Phone ── */
  console.log('\nPhone (390px, touch)');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await fresh();
  await tapIntro();
  ok('no sideways scroll on the page', await js(`return document.documentElement.scrollWidth <= innerWidth;`), await js(`return document.documentElement.scrollWidth + ' > ' + innerWidth;`));
  ok('the tab strip scrolls inside itself', await js(`const n = document.getElementById('ew-tabs'); return n.scrollWidth > n.clientWidth && getComputedStyle(n).overflowX === 'auto';`));
  ok('phone tabs are slim but tappable (36px)', await js(`return Math.round(document.getElementById('ew-tab-dashboard').getBoundingClientRect().height) === 36;`));
  a = await rect('#ew-tab-fitness'); b = await rect('#ew-tab-dashboard');
  await touch('touchStart', a.x, a.y); await sleep(450);
  for (let i = 1; i <= 12; i++) { await touch('touchMove', a.x + (b.x - b.w / 2 - a.x) * i / 12, a.y); await sleep(20); }
  await touch('touchEnd'); await sleep(1400);
  ok('a touch hold-drag reorders', (await js(`return EWApp.order()[0];`)) === 'fitness', await js(`return EWApp.order().join();`));
  ok('the phone backdrop is lighter (≤36 motes)', await js(`return EWBackdrop.state().motes <= 36;`));
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await c.send('Emulation.clearDeviceMetricsOverride');

  /* ── Reduced motion ── */
  console.log('\nReduced motion');
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await fresh();
  ok('the backdrop draws a still frame and never loops', await js(`const s = EWBackdrop.state(); return !s.running && s.frames >= 1;`), await js(`return JSON.stringify(EWBackdrop.state());`));
  ok('the intro text is visible at once', await js(`return getComputedStyle(document.querySelector('.ew-intro-word')).opacity === '1';`));
  await tapIntro();
  ok('…and leaves immediately', await appOn());
  await c.send('Emulation.setEmulatedMedia', { features: [] });

  console.log('\nPage errors');
  const real = errs.filter((e) => !/AppCheck|ReCaptchaV3Provider/.test(e));
  ok('no uncaught exceptions', real.length === 0, real.join(' | '));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
