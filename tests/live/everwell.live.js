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
// Riot's Data Dragon and RiftIQ's version worker, faked: RIOT.desc can be
// changed to prove a reworded ability is shown untouched.
const RIOT = { ver: '16.99.1', title: 'the Unbroken Faith', desc: 'Yunara enters a Transcendent State that upgrades <br>her basic Abilities.' };
const riotCalls = [];
// personal-ai /quote/daily, faked: QUOTE.reply null = the worker is unreachable.
const QUOTE = { reply: null, calls: [] };
const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://ddragon.leagueoflegends.com/*', 'https://warroom-api.av1.workers.dev/*', 'https://personal-ai.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = new URL(req.url), p = u.pathname, b = req.postData ? JSON.parse(req.postData) : {};
    if (u.host === 'personal-ai.av1.workers.dev' && p === '/quote/daily') {
      QUOTE.calls.push(u.search);
      return QUOTE.reply ? { json: Object.assign({ date: u.searchParams.get('date') }, QUOTE.reply) } : { status: 503, json: { ok: false, error: 'unavailable' } };
    }
    if (u.host === 'warroom-api.av1.workers.dev') { riotCalls.push('worker' + p); return { json: [RIOT.ver, '16.98.1'] }; }
    if (u.host === 'ddragon.leagueoflegends.com') {
      riotCalls.push('dd' + p);
      if (p === '/api/versions.json') return { json: ['16.50.1'] };
      if (/\/data\/en_US\/champion\/Yunara\.json$/.test(p)) return { json: { data: { Yunara: { title: RIOT.title, spells: [{}, {}, {}, { name: "Transcend One's Self", description: RIOT.desc, image: { full: 'YunaraR.png' } }] } } } };
      return { status: 404, text: '' };
    }
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
  ok('Dashboard is open and rendered', await js(`return EWApp.current() === 'dashboard' && EWApp.rendered().dashboard === true && !!document.querySelector('#ew-body-dashboard #dash-split');`));
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
  ok('the right password renders the section', await js(`return !!document.querySelector('#ew-body-prayer .pray-grid') && EWApp.rendered().prayer === true;`));
  await js(`Guardian.lockNow('tony_everwell_tab_prayer'); return 1;`); await sleep(500);
  ok('"Lock this device now" empties it again', await js(`return !document.querySelector('#ew-body-prayer .pray-grid') && !EWApp.rendered().prayer && document.getElementById('ew-body-prayer').dataset.state === 'locked';`));
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

  /* ── Phase 2: Fitness + Nutrition on Solace's own docs ── */
  console.log('\nFitness (dashboards/motioncore)');
  const MC = { circuits: [{ id: 'c1', name: 'Real Core', desc: 'mine', _open: false, modules: [{ id: 'm1', name: 'Plank', time: 3, desc: '' }, { id: 'm2', name: 'Crunch', time: 2, desc: '' }] },
    { id: 'c2', name: 'Second Circuit', _open: false, modules: [{ id: 'm3', name: 'Burpee', time: 5 }] }],
    routines: [{ id: 'r1', name: 'Push Day', content: 'Bench Press - 4 x 8\n\nDips - 3 x 10', _open: false }], savedAt: 1 };
  const MEAL = { recipes: [{ id: 'rA', name: 'Overnight Oats', category: 'Breakfast', prepTime: '5 min', servings: '1', ingredients: [{ name: 'Oats', qty: '1/2 cup' }], tools: ['Jar'], instructions: '1. Mix\n2. Chill' },
    { id: 'rB', name: 'Steak Night', category: 'Dinner', prepTime: '', servings: '', ingredients: [], tools: [], instructions: '' }], savedAt: 1 };
  const seed = `sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/motioncore': ${JSON.stringify(MC)}, 'dashboards/mealsuite': ${JSON.stringify(MEAL)}, 'dashboards/mealsuite-veda': { recipes: [{ id: 'veda1', name: 'VEDA ONLY' }] } }));`;
  await fresh({ seed });
  await tapIntro();
  await js(`EWApp.go('fitness'); return 1;`); await sleep(1500);
  ok('the sync status is a dot and a word, no outline', await js(`const s = getComputedStyle(document.getElementById('ew-sync')); return s.borderTopWidth === '0px' || s.borderTopStyle === 'none';`));
  ok('your circuits load from the same doc Solace uses', await js(`return EWFitness.state().loaded && [...document.querySelectorAll('#mc-circuits-list .circuit-card-title')].map(e => e.textContent).join() === 'Real Core,Second Circuit';`),
    await js(`return JSON.stringify(EWFitness.state());`));
  ok('…and nothing of them is cached in browser storage', await js(`return !Object.keys(localStorage).some(k => /^mc_|motioncore|Real Core/.test(k + localStorage.getItem(k)));`));
  // The redesign (Tony, 2026-10-11): circuits and routines are cards side by side; a tap opens a sheet.
  ok('circuits are cards in a grid, side by side, each leading with its total time', await js(`const g = document.getElementById('mc-circuits-list'), c = g.querySelectorAll('.circuit-card');
    return getComputedStyle(g).display === 'grid' && c.length === 2 && Math.abs(c[0].getBoundingClientRect().top - c[1].getBoundingClientRect().top) < 2 && c[0].querySelector('.fx-num').textContent === '5' && /sec/.test(c[0].querySelector('.fx-unit').textContent);`));
  ok('…with a segment per exercise, as wide as its time (3s and 2s)', await js(`const i = [...document.querySelectorAll('#mc-circuits-list .circuit-card:first-child .fx-seg i')]; return i.length === 2 && Math.abs(i[0].getBoundingClientRect().width / i[1].getBoundingClientRect().width - 1.5) < 0.2;`));
  await js(`document.querySelector('#mc-circuits-list .circuit-card .fx-name').click(); return 1;`); await sleep(300);
  ok('tapping a circuit opens its sheet: the exercises in order, Run, Edit, Delete', await js(`const s = document.getElementById('mc-sheet'); return s.classList.contains('open') && document.getElementById('mc-sheet-title').textContent === 'Real Core' &&
    [...s.querySelectorAll('.sh-mod .nm')].map(e => e.textContent).join() === 'Plank,Crunch' && !!s.querySelector('[data-act="run"]') && !!s.querySelector('[data-act="del-circuit"]');`));
  await js(`document.querySelector('#mc-sheet [data-act="sheet-close"]').click(); return 1;`); await sleep(200);
  ok('the sheet closes', await js(`return !document.getElementById('mc-sheet').classList.contains('open');`));
  await js(`document.getElementById('mc-nav-routines').click(); return 1;`); await sleep(400);
  ok('Circuits | Routines is a segmented control with a sliding thumb', await js(`const t = document.querySelector('#mc-seg .ew-seg-thumb'), b = document.getElementById('mc-nav-routines'); return document.getElementById('mc-view-routines').classList.contains('active') && b.getAttribute('aria-selected') === 'true' && Math.abs(t.getBoundingClientRect().left - b.getBoundingClientRect().left) < 2;`));
  ok('a routine card previews its first lines', await js(`return [...document.querySelectorAll('#mc-routines-list .routine-card .rt-peek li')].map(l => l.textContent).join('|') === 'Bench Press4 x 8|Dips3 x 10';`));
  ok('routines render grouped, "name - detail" split (in the sheet)',
    await js(`document.querySelector('#mc-routines-list .routine-card .fx-name').click(); return document.querySelectorAll('#mc-routine-body-r1 .routine-group').length === 2 && document.querySelector('#mc-routine-body-r1 .routine-line-detail').textContent === '4 x 8';`));
  await js(`document.querySelector('#mc-sheet [data-act="sheet-close"]').click(); return 1;`); await sleep(200);
  await js(`document.getElementById('mc-nav-circuits').click(); mcOpenNewCircuitModal(); document.getElementById('mc-circuit-name').value = 'New One';
    document.getElementById('mc-mod-name').value = 'Squat'; document.getElementById('mc-mod-time').value = '20'; mcAddModuleToBuild(); mcSaveCircuit(); return 1;`);
  await sleep(2200);
  ok('a new circuit is saved to dashboards/motioncore, existing ids untouched', await js(`const d = __fakeFs.docs['dashboards/motioncore']; return d.circuits.length === 3 && d.circuits[0].id === 'c1' && d.circuits[0].modules[0].id === 'm1' && d.circuits[2].name === 'New One' && d.routines[0].id === 'r1' && d.savedAt > 1;`),
    await js(`return JSON.stringify(__fakeFs.docs['dashboards/motioncore']).slice(0, 300);`));
  // The cards sit in one row here: drag the third onto the first's left half.
  a = await rect('#mc-circuits-list .circuit-card:nth-child(3) .circuit-card-title'); b = await rect('#mc-circuits-list .circuit-card:nth-child(1)');
  const bx = b.x - b.w / 2 + 20;
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 14; i++) { await mouse('mouseMoved', a.x + (bx - a.x) * i / 14, a.y + (b.y - a.y) * i / 14); await sleep(16); }
  await sleep(250);
  ok('mid-drag, the other cards SLIDE aside like Nutrition\'s (transform transition, moved)', await js(`const n = document.querySelector('#mc-circuits-list .circuit-card:nth-child(1)'); const cs = getComputedStyle(n);
    return /transform/.test(cs.transitionProperty) && cs.transform !== 'none';`), await js(`const cs = getComputedStyle(document.querySelector('#mc-circuits-list .circuit-card:nth-child(1)')); return cs.transitionProperty + ' | ' + cs.transform;`));
  await mouse('mouseReleased', bx, b.y); await sleep(2300);
  ok('dragging a circuit reorders the saved list', await js(`return __fakeFs.docs['dashboards/motioncore'].circuits.map(c => c.name).join() === 'New One,Real Core,Second Circuit';`),
    await js(`return __fakeFs.docs['dashboards/motioncore'].circuits.map(c => c.name).join();`));
  await js(`__fakeFs.remote('dashboards/motioncore', Object.assign({}, __fakeFs.docs['dashboards/motioncore'], { routines: [{ id: 'r1', name: 'Push Day (edited elsewhere)', content: 'x' }], savedAt: Date.now() + 9 })); return 1;`);
  await sleep(800);
  ok("another device's edit appears live", await js(`document.getElementById('mc-nav-routines').click(); return document.querySelector('#mc-routines-list .routine-title').textContent === 'Push Day (edited elsewhere)';`));
  await js(`document.getElementById('mc-nav-circuits').click(); mcStartTimer('c1'); return 1;`); await sleep(400);
  ok('Run opens the circuit timer (get ready countdown)', await js(`return document.getElementById('mc-timer-overlay').classList.contains('open') && document.getElementById('mc-timer-exercise').textContent === 'GET READY';`));
  ok('the timer covers the header (nothing else is tappable)', await js(`const r = document.getElementById('ew-tab-dashboard').getBoundingClientRect(); const el = document.elementFromPoint(r.left + 5, r.top + 5); return !!el.closest('#mc-timer-overlay');`));
  await js(`mcStopTimer(); return 1;`);

  console.log('\nNutrition (dashboards/mealsuite)');
  await js(`EWApp.go('nutrition'); return 1;`); await sleep(1500);
  ok('your recipes load from the same doc Solace uses', await js(`return [...document.querySelectorAll('#rec-root .rec-name')].map(e => e.textContent).join() === 'Overnight Oats,Steak Night';`));
  ok("Tony gets the voice/type bar", await js(`return getComputedStyle(document.getElementById('float-voice')).display !== 'none';`));
  await js(`EWRec.recOpenDetail('rB'); EWRec.recAddStep(); return 1;`); await sleep(200);
  await js(`document.getElementById('rec-step-input').value = 'Sear 3 minutes a side'; EWRec.recSaveStep(0); return 1;`); await sleep(1800);
  ok('an added step is saved, numbered, to dashboards/mealsuite', await js(`const r = __fakeFs.docs['dashboards/mealsuite'].recipes.find(x => x.id === 'rB'); return r.instructions === '1. Sear 3 minutes a side';`));
  await js(`EWRec.recUndo(); return 1;`); await sleep(1800);
  ok('undo puts it back (and saves that)', await js(`return __fakeFs.docs['dashboards/mealsuite'].recipes.find(x => x.id === 'rB').instructions === '';`));
  ok("Veda's recipe doc was never written", await js(`return !__fakeFs.log.some(l => /mealsuite-veda/.test(l.path)) && __fakeFs.docs['dashboards/mealsuite-veda'].recipes[0].name === 'VEDA ONLY';`));
  await js(`EWApp.go('fitness'); return 1;`); await sleep(300);
  ok('leaving Nutrition hides its voice bar', await js(`return !document.getElementById('float-voice') || getComputedStyle(document.getElementById('float-voice')).display === 'none' || document.getElementById('ew-pane-nutrition').offsetParent === null;`));

  console.log('\nA locked section drops its data');
  recs['applock:tony_everwell_tab_fitness'] = 'fit';
  await js(`Guardian.refresh(['tony_everwell_tab_fitness'], true); return 1;`); await sleep(1500);
  ok('locking Fitness empties it: no list, no data in memory', await js(`return !document.getElementById('mc-root') && EWFitness.state().circuits === 0 && !EWFitness.state().loaded && document.getElementById('ew-body-fitness').dataset.state === 'locked';`),
    await js(`return JSON.stringify(EWFitness.state()) + ' ' + document.getElementById('ew-body-fitness').dataset.state;`));
  const writesBefore = await js(`return __fakeFs.log.length;`);
  await js(`__fakeFs.remote('dashboards/motioncore', Object.assign({}, __fakeFs.docs['dashboards/motioncore'], { savedAt: Date.now() + 20 })); return 1;`); await sleep(500);
  ok('…and its listener is gone (a remote change renders nothing)', await js(`return !document.getElementById('mc-root') && EWFitness.state().circuits === 0;`));
  await js(`document.querySelector('[data-unlock="fitness"]').click(); return 1;`); await sleep(800);
  await gtype('Password', 'fit'); await gclick('Unlock'); await sleep(1500);
  d = await dlg(); if (d.open && /Not now/.test(d.buttons.join())) await gclick('Not now');
  ok('unlocking loads it again from the server', await js(`return EWFitness.state().loaded && EWFitness.state().circuits === 3;`), await js(`return JSON.stringify(EWFitness.state());`));
  delete recs['applock:tony_everwell_tab_fitness'];

  /* ── Phase 5: Prayer (its own habit, shared with TaskHub) ── */
  console.log('\nPrayer');
  // An old week's tick is already in the shared doc before Prayer opens.
  await js(`__fakeFs.remote('dashboards/everwell_prayer', { done: { '2019-05-06': true } }, { merge: true }); return 1;`);
  await js(`EWApp.go('prayer'); return 1;`); await sleep(1500);
  const pToday = await js(`return EWCore.dateKey();`);
  ok('a new week starts empty: ticks from before this Monday are cleared from the shared doc', await js(`return !('2019-05-06' in (__fakeFs.docs['dashboards/everwell_prayer'].done || {}));`),
    await js(`return JSON.stringify(__fakeFs.docs['dashboards/everwell_prayer']);`));
  await js(`window.__pg = document.querySelector('.pray-grid'); return 1;`);
  ok('Prayer opens unticked for today, with a Mon–Sun week', await js(`return EWPrayer.state().loaded && document.getElementById('pray-big').textContent === 'Not yet today' && document.querySelectorAll('.pray-week .pray-day').length === 7;`));
  ok('future days cannot be ticked', await js(`const t = '${pToday}'; return [...document.querySelectorAll('.pray-day')].every(b => (b.dataset.pray > t) === b.disabled);`));
  await js(`document.getElementById('pray-btn').click(); return 1;`); await sleep(1500);
  ok("marking it writes today's LOCAL date to dashboards/everwell_prayer", await js(`const d = __fakeFs.docs['dashboards/everwell_prayer']; return !!d && d.done['${pToday}'] === true && d.by === 'everwell';`),
    await js(`return JSON.stringify(__fakeFs.docs['dashboards/everwell_prayer']);`));
  ok('…and shows "Prayed today", the button now undoes', await js(`return document.getElementById('pray-big').textContent === 'Prayed today' && /undo/i.test(document.getElementById('pray-btn').textContent);`));
  ok('no flash: the tick updated the section in place (same node, entrance not replayed)', await js(`return document.querySelector('.pray-grid') === window.__pg;`));
  ok('…and the button was never greyed out while saving', await js(`return !document.getElementById('pray-btn').disabled;`));
  await js(`__fakeFs.remote('dashboards/everwell_prayer', { done: { '${pToday}': false, '2020-01-01': true }, savedAt: Date.now(), by: 'taskhub' }, { merge: true }); return 1;`); await sleep(1000);
  ok('an untick from TaskHub shows here', await js(`return document.getElementById('pray-big').textContent === 'Not yet today' && !EWPrayer.state().done['${pToday}'];`));
  ok('…and every tick is merged per date (older days kept)', await js(`return __fakeFs.docs['dashboards/everwell_prayer'].done['2020-01-01'] === true;`));
  ok("Prayer never writes TaskHub's own doc", await js(`return !__fakeFs.log.some(l => l.path === 'dashboards/main');`));

  /* ── Phase 3: the Dashboard ── */
  console.log('\nDashboard: rotation');
  const today = await js(`return EWCore.dateKey();`);
  const MC3 = { circuits: [], routines: [{ id: 'r1', name: 'Push Day A', content: 'Bench Press - 4 x 8\nIncline DB - 3 x 10' }, { id: 'r2', name: 'Leg Day', content: 'Squat - 5 x 5' }], savedAt: 1 };
  await fresh({ seed: `sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/motioncore': ${JSON.stringify(MC3)} }));` });
  riotCalls.length = 0;
  await tapIntro();
  await js(`EWApp.go('dashboard'); return 1;`); await sleep(1800);
  ok('first run (nothing stored): today is Push, with no "Step 1 of 3 · Tomorrow" line (Tony removed it)', (await js(`return document.getElementById('dash-split-name').textContent;`)) === 'Push' && await js(`return !document.querySelector('.split-meta') && !/Step \\d+ of|Tomorrow:/.test(document.getElementById('dash-split').textContent);`));
  ok('…and that default is written once, after the real read', await js(`const r = (__fakeFs.docs['dashboards/everwell_tony'] || {}).rotation; return !!r && r.steps.map(s => s.name).join() === 'Push,Pull,Legs' && r.anchor.date === '${today}' && r.anchor.idx === 0;`),
    await js(`return JSON.stringify(__fakeFs.docs['dashboards/everwell_tony']);`));
  ok('the week strip shows 7 days from today, in order', (await js(`return [...document.querySelectorAll('.split-day .nm')].map(e => e.textContent).join();`)) === 'Push,Pull,Legs,Push,Pull,Legs,Push');
  await js(`document.querySelector('[data-today="2"]').click(); return 1;`); await sleep(1500);
  ok("a tap changes today's split (Legs), and tomorrow follows from it", (await js(`return document.getElementById('dash-split-name').textContent + '|' + [...document.querySelectorAll('.split-day .nm')].slice(0, 3).map(e => e.textContent).join();`)) === 'Legs|Legs,Push,Pull');
  ok('…saved as a new anchor (today, Legs) with a log entry', await js(`const r = __fakeFs.docs['dashboards/everwell_tony'].rotation; return r.anchor.date === '${today}' && r.anchor.idx === 2 && r.log.length === 1 && r.log[0].date === '${today}';`));

  console.log('\nDashboard: routine pairings');
  ok('auto-paired ONCE by name: Legs → Leg Day; "Push Day A" is not an exact match, so Push stays free', await js(`const r = __fakeFs.docs['dashboards/everwell_tony'].rotation;
    return r.autoPaired === true && r.steps[2].routineId === 'r2' && !r.steps[0].routineId && !r.steps[1].routineId;`), await js(`return JSON.stringify(__fakeFs.docs['dashboards/everwell_tony'].rotation.steps);`));
  ok("today (Legs) names its routine and offers Show routine", /Routine: Leg Day/.test(await js(`return document.getElementById('dash-split-pair').textContent;`)) && await js(`return !!document.querySelector('[data-act="toggle-routine"]');`));
  await js(`document.querySelector('[data-act="toggle-routine"]').click(); return 1;`); await sleep(300);
  ok("Show routine previews it (from Fitness, read only)", (await js(`return document.querySelector('.split-routine .routine-line-name').textContent;`)) === 'Squat' &&
    await js(`return !__fakeFs.log.some(l => l.path === 'dashboards/motioncore' && l.op !== 'remote');`));
  await js(`document.querySelector('[data-act="pairs"]').click(); return 1;`); await sleep(300);
  ok('Routines opens one row per split, each with a picker of Fitness routines', await js(`return document.querySelectorAll('#pair-list .pair-row').length === 3 &&
    [...document.querySelectorAll('#pair-list .pair-row:nth-child(1) select option')].map(o => o.textContent).join() === 'No routine,Push Day A,Leg Day';`));
  ok('…with no field highlighted: focus is on the dialog itself (Tony)', await js(`const a = document.activeElement; return !!a && a.classList.contains('ew-dlg') && getComputedStyle(a).outlineStyle === 'none';`));
  await js(`const s = document.querySelector('#pair-list .pair-row:nth-child(1) select'); s.value = 'r1'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1;`);
  await js(`document.querySelector('#pair-list .pair-row:nth-child(3) [data-unpair]').click(); return 1;`); await sleep(300);
  ok('removing a pairing asks first, in the page, over the dialog', await js(`return document.getElementById('uim-overlay').classList.contains('show') && document.getElementById('uim-title').textContent === 'Remove pairing?' && /Legs will no longer open “Leg Day”/.test(document.getElementById('uim-msg').textContent);`),
    await js(`return document.getElementById('uim-msg').textContent;`));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;`); await sleep(300);
  ok('…Escape cancels it and leaves the pairing dialog open', await js(`return !!document.getElementById('pair-editor') && document.querySelector('#pair-list .pair-row:nth-child(3)').classList.contains('on');`));
  await js(`document.querySelector('#pair-list .pair-row:nth-child(3) [data-unpair]').click(); return 1;`); await sleep(300);
  await js(`document.getElementById('uim-ok').click(); return 1;`); await sleep(300);
  ok('pairing Push and removing Legs shows in the dialog before saving', await js(`const rows = document.querySelectorAll('#pair-list .pair-row'); return rows[0].classList.contains('on') && rows[0].querySelector('select').value === 'r1' && !rows[2].classList.contains('on') && rows[2].querySelector('select').value === '';`));
  await js(`document.querySelector('[data-act="pair-save"]').click(); return 1;`); await sleep(1500);
  ok('saved with the rotation: Push → Push Day A, Legs → none', await js(`const r = __fakeFs.docs['dashboards/everwell_tony'].rotation; return r.steps[0].routineId === 'r1' && !r.steps[2].routineId && r.autoPaired === true;`));
  ok('…and today (Legs) no longer shows a routine', await js(`return !document.getElementById('dash-split-pair') && !document.querySelector('[data-act="toggle-routine"]');`));
  await c.send('Page.reload'); await sleep(2500); await tapIntro(); await js(`EWApp.go('dashboard'); return 1;`); await sleep(1500);
  ok('auto-pairing never runs again (Legs stays unpaired after a reload)', await js(`return !__fakeFs.docs['dashboards/everwell_tony'].rotation.steps[2].routineId;`));
  await js(`document.querySelector('[data-act="pairs"]').click(); return 1;`); await sleep(300);
  await js(`const s = document.querySelector('#pair-list .pair-row:nth-child(3) select'); s.value = 'r2'; s.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[data-act="pair-save"]').click(); return 1;`); await sleep(1500);
  ok('re-pairing Legs → Leg Day works', (await js(`return document.getElementById('dash-split-pair').textContent;`)).includes('Leg Day'));
  await js(`document.querySelector('[data-act="toggle-routine"]').click(); return 1;`); await sleep(300);
  ok('the shown routine has a pencil', await js(`return !!document.querySelector('[data-act="edit-routine"] svg');`));
  await js(`document.querySelector('[data-act="edit-routine"]').click(); return 1;`); await sleep(1800);
  ok('the pencil opens Fitness ▸ Routines with that routine\'s editor', await js(`return EWApp.current() === 'fitness' && document.getElementById('mc-view-routines').classList.contains('active') &&
    document.getElementById('mc-routine-modal').classList.contains('open') && document.getElementById('mc-routine-name').value === 'Leg Day';`),
    await js(`return EWApp.current() + ' ' + (document.getElementById('mc-routine-name') || {}).value;`));
  await js(`mcCloseModal('mc-routine-modal'); EWApp.go('dashboard'); return 1;`); await sleep(800);

  // Edit rotation: add a rest day; pairings ride along untouched.
  await js(`document.querySelector('[data-act="edit-rot"]').click(); return 1;`); await sleep(400);
  ok('Edit rotation opens with the three steps, and no routine picker', (await js(`return document.querySelectorAll('#rot-list .rot-row').length;`)) === 3 && (await js(`return document.querySelectorAll('#rot-list select').length;`)) === 0);
  ok('…with no step highlighted: focus is on the dialog itself (Tony)', await js(`const a = document.activeElement; return !!a && a.classList.contains('ew-dlg') && !!a.querySelector('#rot-list');`));
  await js(`document.querySelector('[data-act="rot-add"]').click(); const rows = document.querySelectorAll('#rot-list .rot-row'); const last = rows[rows.length - 1];
    last.querySelector('input[type=text]').value = 'Rest'; last.querySelector('input[type=checkbox]').checked = true; return 1;`);
  await js(`document.querySelector('[data-act="rot-save"]').click(); return 1;`); await sleep(1500);
  ok('saved: 4 steps with a rest day, today still Legs, pairings kept', await js(`const r = __fakeFs.docs['dashboards/everwell_tony'].rotation; return r.steps.length === 4 && r.steps[3].rest === true && r.steps[2].routineId === 'r2' && r.steps[0].routineId === 'r1';`) &&
    (await js(`return document.getElementById('dash-split-name').textContent + '|' + [...document.querySelectorAll('.split-day .nm')].slice(0, 3).map(e => e.textContent).join();`)) === 'Legs|Legs,Rest,Push');
  await js(`__fakeFs.remote('dashboards/everwell_tony', { rotation: { steps: [{ id: 'x1', name: 'Upper' }, { id: 'x2', name: 'Lower' }], anchor: { date: '${today}', idx: 1 }, log: [] }, savedAt: Date.now() + 50 }, { merge: true }); return 1;`);
  await sleep(800);
  ok("another device's rotation arrives live", (await js(`return document.getElementById('dash-split-name').textContent;`)) === 'Lower');

  console.log('\nDashboard: faith, R, quote');
  ok('the Data Dragon version came from RiftIQ\'s worker first', riotCalls[0] === 'worker/api/ddragon-version' && riotCalls.includes('dd/cdn/16.99.1/data/en_US/champion/Yunara.json'), riotCalls.join(' '));
  ok('"The Unbroken Faith" (Riot\'s title) with a check', await js(`return document.getElementById('dash-faith-title').textContent === 'The Unbroken Faith' && !!document.querySelector('.faith-line .ew-check');`));
  ok('"I have unbreakable faith" with its own check', await js(`const l = document.querySelector('.faith-line.mine'); return l.textContent.trim() === 'I have unbreakable faith' && !!l.querySelector('.ew-check');`));
  ok('the small caption "Yunara\'s title from League of Legends"; no R-card credit', await js(`const cap = document.querySelector('#dash-faith .faith-cap'); return !!cap && cap.textContent === "Yunara's title from League of Legends" && parseFloat(getComputedStyle(cap).fontSize) <= 12 && !document.querySelector('.rcard-credit');`));
  ok("Tony's profile pill shows his purple fleur-de-lis", await js(`const s = document.querySelector('#ew-profile-btn .ew-fleur path'); return !!s && s.getAttribute('fill') === '#c0aeea';`));
  ok("…alone, in a circle the lock button's size, the mark bigger than before", await js(`const b = document.getElementById('ew-profile-btn'), r = b.getBoundingClientRect(), l = document.getElementById('ew-lock-btn').getBoundingClientRect(), f = b.querySelector('.ew-fleur').getBoundingClientRect();
    return !b.textContent.trim() && Math.round(r.width) === Math.round(l.width) && Math.round(r.height) === Math.round(l.height) && getComputedStyle(b).borderRadius === '50%' && f.width >= 17 && /Tony/.test(b.getAttribute('aria-label'));`),
    await js(`const b = document.getElementById('ew-profile-btn'); return JSON.stringify([b.getBoundingClientRect().width, document.getElementById('ew-lock-btn').getBoundingClientRect().width, getComputedStyle(b).borderRadius, b.querySelector('.ew-fleur').getBoundingClientRect().width]);`));
  ok('R card: icon from Data Dragon, "R  Transcend One\'s Self"', await js(`return /\\/cdn\\/16\\.99\\.1\\/img\\/spell\\/YunaraR\\.png$/.test(document.querySelector('.rcard-icon').src) && document.querySelector('.rcard-name').textContent === "Transcend One's Self";`));
  ok('"Yunara enters" and "her basic Abilities" struck through, new words beneath', await js(`const sw = [...document.querySelectorAll('#dash-rdesc .swap')];
    return sw.length === 2 && sw[0].querySelector('s').textContent === 'Yunara enters' && sw[0].querySelector('.new').textContent === 'I enter' &&
      sw[1].querySelector('s').textContent === 'her basic Abilities' && sw[1].querySelector('.new').textContent === 'my entire life' &&
      getComputedStyle(sw[0].querySelector('s')).textDecorationLine.includes('line-through') &&
      sw[0].querySelector('.new').getBoundingClientRect().top > sw[0].querySelector('s').getBoundingClientRect().top;`));
  ok('the rewritten line reads exactly', (await js(`return document.querySelector('.rcard-mine').textContent;`)) === 'I enter a Transcendent State that upgrades my entire life.');
  ok('the date reads like "Sun, Oct 11" at the top, and the quote card carries no date of its own', await js(`const want = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \\d{1,2}$/.test(want) && document.getElementById('dash-date').textContent === want && !document.querySelector('#dash-quote .quote-src') && !document.getElementById('dash-quote').textContent.includes(want);`),
    await js(`return document.getElementById('dash-date').textContent + ' | ' + document.getElementById('dash-quote').textContent;`));
  ok('with the AI unreachable, the quote of the day is the local line for today', (await js(`return document.getElementById('dash-quote-text').textContent === EWCore.localQuote(EWCore.dateKey());`)));

  // If Riot ever rewords the ability, the official text is shown untouched.
  await js(`localStorage.setItem('ew.tony.riot.yunara', JSON.stringify({ at: Date.now(), data: { ver: '16.99.1', title: 'the Unbroken Faith', live: true, r: { name: "Transcend One's Self", desc: 'Yunara ascends and empowers her spells.', img: 'YunaraR.png' } } })); return 1;`);
  await c.send('Page.reload'); await sleep(2200); await tapIntro(); await js(`EWApp.go('dashboard'); return 1;`); await sleep(800);
  ok('…after a reload: no swap, the official words as Riot wrote them', await js(`return document.querySelectorAll('#dash-rdesc .swap').length === 0 && document.getElementById('dash-rdesc').textContent === 'Yunara ascends and empowers her spells.';`));
  await js(`localStorage.removeItem('ew.tony.riot.yunara'); return 1;`);

  console.log('\nQuote of the day: AI (Phase 4)');
  ok('Tony asked personal-ai once for today (profile tony, local date)', QUOTE.calls.length >= 1 && QUOTE.calls.every((s) => s === '?profile=tony&date=' + today), QUOTE.calls);
  ok('the worker was unreachable, so the local line stays and the try is throttled', await js(`return document.getElementById('dash-quote').dataset.source === 'local' && JSON.parse(localStorage.getItem('ew.tony.quoteTry')).date === '${today}';`));
  QUOTE.calls.length = 0;
  await c.send('Page.reload'); await sleep(2200); await tapIntro(); await js(`EWApp.go('dashboard'); return 1;`); await sleep(800);
  ok('a reload within 30 minutes does NOT ask again', QUOTE.calls.length === 0, QUOTE.calls);
  QUOTE.reply = { ok: true, quote: 'Strength is the quiet decision to begin again, every single morning.', source: 'orca' };
  await js(`localStorage.removeItem('ew.tony.quoteTry'); return 1;`);
  await c.send('Page.reload'); await sleep(2200); await tapIntro(); await js(`EWApp.go('dashboard'); return 1;`); await sleep(1200);
  ok("the day's AI line replaces the local one", await js(`return document.getElementById('dash-quote-text').textContent === 'Strength is the quiet decision to begin again, every single morning.' && document.getElementById('dash-quote').dataset.source === 'orca';`));
  ok('…kept for the day on this device', await js(`const q = JSON.parse(localStorage.getItem('ew.tony.quote')); return q.date === '${today}' && q.source === 'orca';`));
  QUOTE.calls.length = 0;
  await c.send('Page.reload'); await sleep(2200); await tapIntro(); await js(`EWApp.go('dashboard'); return 1;`); await sleep(600);
  ok('…so the next open shows it at once and makes no request', QUOTE.calls.length === 0 && (await js(`return document.getElementById('dash-quote').dataset.source;`)) === 'orca');
  ok('EWQuote.today() gives Mindset the same line', (await js(`return EWQuote.today().then(q => q.text);`)) === 'Strength is the quiet decision to begin again, every single morning.');
  QUOTE.reply = null;

  // Today's step linked to a routine (through the synced doc), then Fitness locked.
  await js(`__fakeFs.remote('dashboards/everwell_tony', { rotation: { steps: [{ id: 'x1', name: 'Upper', routineId: 'r1' }, { id: 'x2', name: 'Lower', routineId: 'r2' }], anchor: { date: '${today}', idx: 1 }, log: [] }, savedAt: Date.now() + 60 }, { merge: true }); return 1;`);
  recs['applock:tony_everwell_tab_fitness'] = 'fit';
  await js(`Guardian.refresh(['tony_everwell_tab_fitness'], true); return 1;`); await sleep(1200);
  await c.send('Page.reload'); await sleep(2500); await tapIntro(); await js(`EWApp.go('dashboard'); return 1;`); await sleep(1500);
  await js(`document.querySelector('[data-act="toggle-routine"]').click(); return 1;`); await sleep(400);
  ok('a locked Fitness keeps its routine out of the Dashboard', /Fitness is locked/.test(await js(`return (document.querySelector('.split-routine') || {}).textContent || '';`)), await js(`return (document.querySelector('#dash-split') || {}).textContent;`));
  delete recs['applock:tony_everwell_tab_fitness'];

  console.log('\nPhone (390px): Dashboard');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(500);
  ok('Dashboard: no sideways scroll; the week strip fits', await js(`const w = document.querySelector('.split-week').getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth && w.right <= innerWidth;`));
  ok('…the two swaps still stack (new words under the old)', await js(`const s = document.querySelector('#dash-rdesc .swap'); return !s || s.querySelector('.new').getBoundingClientRect().top > s.querySelector('s').getBoundingClientRect().top;`));
  // The tagline: shown whenever it fits, hidden only where it would hit the buttons.
  const tagAt = async (w) => { await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 844, deviceScaleFactor: 3, mobile: true }); await sleep(500);
    return js(`const t = document.querySelector('.ew-tagline'); if (getComputedStyle(t).display === 'none') return 'hidden';
      const r = t.getBoundingClientRect(), next = document.querySelector('.ew-spacer').nextElementSibling; let x = innerWidth;
      for (let e = next; e; e = e.nextElementSibling) if (e.offsetWidth) { x = e.getBoundingClientRect().left; break; }
      return r.right + 4 <= x ? 'fits' : 'overlaps';`); };
  ok('header tagline: shown on a wider phone (520px) without touching the buttons', (await tagAt(520)) === 'fits');
  ok('…hidden at 360px, where it would run into them', (await tagAt(360)) === 'hidden');
  await c.send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);
  ok('…and back on the desktop', (await js(`return getComputedStyle(document.querySelector('.ew-tagline')).display;`)) !== 'none');

  console.log('\nPhone (390px): Fitness + Nutrition');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(500);
  ok('Fitness: no sideways scroll', await js(`return document.documentElement.scrollWidth <= innerWidth;`), await js(`return document.documentElement.scrollWidth;`));
  await js(`EWApp.go('nutrition'); return 1;`); await sleep(1200);
  ok('Nutrition: no sideways scroll, the voice bar fits', await js(`const r = document.getElementById('float-voice').getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth && r.left >= 0 && r.right <= innerWidth;`));
  await c.send('Emulation.clearDeviceMetricsOverride');

  /* ── Display ── */
  console.log('\nDisplay profile');
  await fresh({ display: true });
  ok('Display loads no Firebase at all', !reqs.some((u) => /firebasejs|firestore\.googleapis|identitytoolkit|securetoken/.test(u)), reqs.filter((u) => /firebase|google/.test(u)).join(' '));
  // Real requests only: the data: manifest names this host in its JSON.
  const net = reqs.filter((u) => /^https?:/.test(u));
  ok('…and calls no worker', !net.some((u) => /^https:\/\/[^/]*\.workers\.dev\//.test(u)), net.filter((u) => /workers\.dev/.test(u)).join(' '));
  ok("the intro offers Tony's profile, not the Display one", await js(`return getComputedStyle(document.getElementById('ew-intro-tony')).display !== 'none' && getComputedStyle(document.getElementById('ew-intro-display')).display === 'none';`));
  await tapIntro();
  ok("no Tony launcher, no lock button; the pill has the same grey outline as Tony's, uppercase, no icon, Display in a softer gold", await js(`const b = document.getElementById('ew-display-btn'), t = getComputedStyle(document.getElementById('ew-profile-btn')), s = getComputedStyle(b);
    return !document.querySelector('a1-lifehub') && getComputedStyle(document.getElementById('ew-lock-btn')).display === 'none' &&
    s.display !== 'none' && b.textContent === 'Display' && !b.querySelector('svg') && s.color === 'rgb(205, 182, 140)' && s.borderTopColor === t.borderTopColor && s.textTransform === 'uppercase';`),
    await js(`const s = getComputedStyle(document.getElementById('ew-display-btn')); return s.color + ' ' + s.borderTopColor + ' / ' + getComputedStyle(document.getElementById('ew-profile-btn')).borderTopColor;`));
  ok('no "demo data" chip under any tab (Tony, 2026-10-11)', await js(`return !document.querySelector('.ew-demo-note') && !/Display profile · demo data/.test(document.getElementById('ew-main').textContent);`));
  await js(`EWApp.go('fitness'); return 1;`); await sleep(400);
  ok('Display Fitness shows demo circuits and Push/Pull/Legs routines', await js(`return EWFitness.circuits()[0].id.indexOf('demo-') === 0 && EWFitness.routines().map(r => r.name).join() === 'Push,Pull,Legs';`));
  await js(`EWApp.go('nutrition'); return 1;`); await sleep(400);
  ok('Display Nutrition shows demo recipes and NO voice bar', await js(`return EWRec.recipes().length === 3 && EWRec.recipes()[0].id.indexOf('demo-') === 0 && !document.getElementById('float-voice');`));
  ok('Display never loaded the Firebase fake at all', await js(`return typeof window.__fakeFs === 'undefined' && !window.EWFB;`));
  await js(`EWApp.go('prayer'); return 1;`); await sleep(400);
  await js(`document.getElementById('pray-btn').click(); return 1;`); await sleep(300);
  ok('Display Prayer ticks in memory only (demo), still no Firebase', await js(`return document.getElementById('pray-big').textContent === 'Prayed today' && typeof window.__fakeFs === 'undefined' && /demo/i.test(document.querySelector('.pray-note').textContent);`));
  await js(`EWApp.go('dashboard'); return 1;`); await sleep(300);
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
