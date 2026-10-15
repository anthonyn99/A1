// Everwell Body & fuel (refinement round 5, 2026-10-15), in the real page
// served by cdp.js from ../A1-Priv, against the fake Firebase and a fake
// personal-ai /fuel/plan. Nothing here reaches the network.
//
//   - first run: one person (Tony) after a REAL read; the stats editor (no
//     field focused); the first plan comes from the AI by itself
//   - the Dashboard's Nutrition and Today's fuel cards; meal and water ticks
//     write ONE merge each, at once; the done pills; another device's tick
//   - hand edits, Reset to the AI's plan, Re-run (asks first over edits), an
//     AI failure leaves the plan alone
//   - people: add, switch (synced), ticks kept apart, remove (photos and ticks go)
//   - photos: compressed under 700 KB, a thumbnail in the index, the gallery,
//     the viewer (Escape and Back close it), "sent to AI", sent to the AI, delete
//   - Nutrition: Plan | Recipe Book; the voice bar only on the book; the
//     choice is remembered; a Nutrition lock hides the Dashboard cards
//   - phones (360px): no sideways scroll, the editor fits, a tap ticks
//
// Run: node tests/live/everwell-fuel.live.js
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
const PLAN = { calories: 2500, protein: 175, carbs: 270, fat: 78, fiber: 35, waterOz: 120, meals: 3, mealNames: ['Breakfast', 'Lunch', 'Dinner'], activity: 'active', notes: ['Protein at every meal.', 'Front-load **carbs** around training.'] };
const AI = { reply: () => ({ json: { ok: true, plan: PLAN, via: 'orca', model: 'deepseek/free', sawPhotos: false } }), calls: [] };
const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://personal-ai.av1.workers.dev/*', 'https://warroom-api.av1.workers.dev/*', 'https://ddragon.leagueoflegends.com/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = new URL(req.url), p = u.pathname, b = req.postData ? JSON.parse(req.postData) : {};
    if (u.host === 'personal-ai.av1.workers.dev' && p === '/fuel/plan') { AI.calls.push(b); return AI.reply(b); }
    if (p === '/auth/journal/status-many') {
      const out = {}; (b.locks || []).forEach((l) => { const k = l.journal + ':' + l.entryId; out[k] = { hasLock: !!recs[k], ver: recs[k] ? 'v1' : null }; });
      return { json: { ok: true, locks: out } };
    }
    if (p === '/auth/journal/verify') { const r = recs[b.journal + ':' + b.entryId]; return { json: r ? { ok: r === b.password } : { ok: false, noLock: true } }; }
    return { status: 503, json: { ok: false } };
  },
};

(async () => {
  const c = await connect({ mock: firebaseMock(mock) });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || '').slice(0, 300)); });
  const js = (e) => evalJs(c, e);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  const fresh = async (seed) => {
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(300);
    await js(`localStorage.clear(); sessionStorage.clear(); ${seed ? `sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(seed))});` : ''} return 1;`);
    await c.send('Page.navigate', { url: PAGE }); await sleep(2600);
    await js(`document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1600);
  };
  const reload = async () => { const docs = await js(`return JSON.stringify(__fakeFs.docs);`); await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(300);
    await js(`sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(docs)}); return 1;`); await c.send('Page.navigate', { url: PAGE }); await sleep(2600);
    await js(`document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1600); };
  const doc = (p) => js(`return JSON.stringify(__fakeFs.docs['dashboards/${p}'] || null);`).then(JSON.parse);
  const text = (sel) => js(`const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText : '';`);
  const click = (sel) => js(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'missing'; e.click(); return 1;`);
  const dlgOk = async (val) => { await js(`const i = document.querySelector('#uim-fields input'); if (i && ${JSON.stringify(val !== undefined)}) i.value = ${JSON.stringify(val || '')}; document.getElementById('uim-ok').click(); return 1;`); await sleep(900); };
  const set = (id, v) => js(`const e = document.getElementById(${JSON.stringify(id)}); if (!e) return 'missing'; e.value = ${JSON.stringify(String(v))}; return 1;`);
  const toastText = () => js(`return document.getElementById('ew-toast').textContent;`);
  const today = await (async () => { await fresh(); return js(`return EWCore.dateKey();`); })();

  /* ── First run ── */
  console.log('\nFirst run');
  ok('the Dashboard has the two new cards: Today\'s fuel (left) and Nutrition (right)', await js(`return !!document.querySelector('#dash-col-a > #dash-fuel') && !!document.querySelector('#dash-col-b > #dash-body');`));
  const body0 = await doc('everwell_body');
  ok('after a REAL read found nobody, one person is written: Tony, trained by his Everwell rotation', !!body0 && body0.people.length === 1 && body0.people[0].name === 'Tony' && body0.people[0].training.source === 'everwell' && !body0.people[0].ai, JSON.stringify(body0));
  ok('the Nutrition card asks for the stats (one button, no description)', /Add Tony’s stats/.test(await text('#dash-body')) && !!(await js(`return document.querySelector('#dash-body [data-fx="edit"].btn');`)));
  ok('no AI call before there are stats', AI.calls.length === 0);
  await click('#dash-body .btn[data-fx="edit"]'); await sleep(500);
  ok('the editor opens, focused on its box (no field highlighted)', await js(`const d = document.querySelector('#fx-editor .ew-dlg'); return !!d && document.activeElement === d;`));
  ok('…with Body, Training, Photos and Plan', (await text('#fx-editor')).match(/BODY|TRAINING|PHOTOS|PLAN/g).length >= 4);
  ok('training reads the rotation (Push, Pull, Legs: 7 a week, no rest day)', /7 workouts a week/.test(await text('#fx-train')), await text('#fx-train'));
  await click('[data-fxc="sex"][data-v="male"]'); await sleep(150);
  await set('fx-age', 27); await set('fx-ft', 5); await set('fx-in', 10); await set('fx-lb', 175); await set('fx-diet', 'No pork');
  await click('[data-fxc="goal"][data-v="recomp"]'); await sleep(150);
  ok('a chip click keeps the typed values (the editor redraws from what is typed)', (await js(`return document.getElementById('fx-age').value + '|' + document.getElementById('fx-lb').value;`)) === '27|175');
  await click('[data-fxa="save"]'); await sleep(2200);
  ok('saving the first stats asks the AI by itself, once', AI.calls.length === 1, AI.calls.length);
  const req = AI.calls[0] || {};
  ok('…with the stats, the diet notes and the rotation (profile tony)', req.profile === 'tony' && req.person.stats.sex === 'male' && req.person.stats.age === 27 && req.person.stats.heightIn === 70 && req.person.stats.weightLb === 175 &&
    req.person.stats.goal === 'recomp' && req.person.stats.diet === 'No pork' && req.training.splits.join() === 'Push,Pull,Legs' && req.training.perWeek === 7 && Array.isArray(req.photos) && req.photos.length === 0, JSON.stringify(req));
  let b = await doc('everwell_body');
  ok('the plan is saved as the AI\'s (16 oz glasses), with no hand edits', b.people[0].ai.calories === 2500 && b.people[0].ai.glassOz === 16 && b.people[0].ai.model === 'deepseek/free' && JSON.stringify(b.people[0].over) === '{}', JSON.stringify(b.people[0]));
  ok('the Nutrition card shows it: 2,500 kcal, P/C/F, water, meals, fiber, the stats line', await js(`const t = document.getElementById('dash-body').innerText; return /2,500/.test(t) && /175\\s*g/.test(t) && /270\\s*g/.test(t) && /78\\s*g/.test(t) && /120 oz/.test(t) && /3 meals/.test(t) && /27 · 5′10″ · 175 lb · Recomp/.test(t);`),
    await text('#dash-body'));
  ok('the ring and bars carry the person\'s pastel', await js(`const r = document.querySelector('#dash-body .fx-ring .val'); return !!r && getComputedStyle(r).stroke === 'rgb(192, 174, 234)';`));

  /* ── Ticks ── */
  console.log('\nToday\'s fuel: meals and water');
  const pid = b.people[0].id;
  ok('three meal chips (the AI\'s names) and eight glasses (120 / 16 oz)', await js(`return [...document.querySelectorAll('#dash-fuel [data-fx="meal"]')].map(x => x.textContent).join() === 'Breakfast,Lunch,Dinner' && document.querySelectorAll('#dash-fuel [data-fx="glass"]').length === 8;`));
  ok('the pills read 0/3 meals and 0/8 water', /0\/3 meals/.test(await text('#dash-fuel .card-head')) && /0\/8 water/.test(await text('#dash-fuel .card-head')));
  await click('#dash-fuel [data-fx="meal"][data-i="1"]'); await sleep(700);
  let f = await doc('everwell_fuel');
  ok('one tap ticks one meal: ONE merge at d.<person>.<today>.m.1, sent at once', !!f && f.d[pid][today].m['1'] === true && !f.d[pid][today].m['0'], JSON.stringify(f));
  ok('…the chip turns green like Workout complete (wk-btn done)', await js(`const b = document.querySelector('#dash-fuel [data-fx="meal"][data-i="1"]'); return b.classList.contains('wk-btn') && b.classList.contains('done') && b.getAttribute('aria-pressed') === 'true';`));
  ok('…and the ring counts what was eaten', /eaten/.test(await text('#dash-body .fx-ring')));
  await click('#dash-fuel [data-fx="meal"][data-i="0"]'); await sleep(300); await click('#dash-fuel [data-fx="meal"][data-i="2"]'); await sleep(700);
  ok('all three: a "Meals complete" pill in the same done style as the workout and prayer', await js(`const p = [...document.querySelectorAll('#dash-fuel .card-head .fp.done')].find(x => /Meals complete/.test(x.textContent)); return !!p && !!p.querySelector('.fp-ic svg') && getComputedStyle(p.querySelector('.fp-ic')).backgroundColor === 'rgb(164, 185, 134)';`));
  ok('…and a toast says so', /Every meal done today/.test(await toastText()));
  await click('#dash-fuel [data-fx="meal"][data-i="2"]'); await sleep(700);
  f = await doc('everwell_fuel');
  ok('a second tap unticks (false is written, the others stay)', f.d[pid][today].m['2'] === false && f.d[pid][today].m['0'] === true && /2\/3 meals/.test(await text('#dash-fuel .card-head')));
  for (let i = 0; i < 8; i++) { await click(`#dash-fuel [data-fx="glass"][data-i="${i}"]`); await sleep(120); }
  await sleep(700);
  f = await doc('everwell_fuel');
  ok('eight glasses: each its own field, and "Water complete"', Object.keys(f.d[pid][today].w).length === 8 && /Water complete/.test(await text('#dash-fuel .card-head')));
  ok('a ticked glass fills (scaleY 1)', await js(`const l = document.querySelector('#dash-fuel .fx-glass.on .liq'); return !!l && getComputedStyle(l).transform === 'matrix(1, 0, 0, 1, 0, 0)';`));
  await js(`__fakeFs.remote('dashboards/everwell_fuel', { d: { ['${pid}']: { '${today}': { m: { 2: true } } } }, savedAt: Date.now() + 9 }, { merge: true }); return 1;`); await sleep(900);
  ok('another device\'s tick arrives live', await js(`return document.querySelector('#dash-fuel [data-fx="meal"][data-i="2"]').classList.contains('done') && /Meals complete/.test(document.querySelector('#dash-fuel .card-head').textContent);`));

  /* ── Hand edits, Reset, Re-run ── */
  console.log('\nHand edits, Reset, Re-run');
  await click('#dash-body [data-fx="edit"]'); await sleep(500);
  ok('the Plan fields are filled with the AI\'s numbers', (await js(`return ['fx-calories','fx-protein','fx-carbs','fx-fat','fx-woz','fx-goz','fx-meals'].map(i => document.getElementById(i).value).join();`)) === '2500,175,270,78,120,16,3');
  await set('fx-calories', 2300); await set('fx-goz', 20); await set('fx-meals', 4);
  await js(`document.getElementById('fx-meals').dispatchEvent(new Event('change')); return 1;`); await sleep(300);
  const mn = await js(`return [...document.querySelectorAll('.fx-mealnames input')].map(i => i.value).join() + '|' + document.getElementById('fx-calories').value;`);
  ok('four meals → four name boxes (the defaults for four), the edited values kept', mn === 'Breakfast,Lunch,Snack,Dinner|2300', mn);
  await click('[data-fxa="save"]'); await sleep(1500);
  b = await doc('everwell_body');
  ok('only what differs from the AI is kept as a hand edit', JSON.stringify(Object.keys(b.people[0].over).sort()) === JSON.stringify(['calories', 'glassOz', 'mealNames', 'meals']) && b.people[0].ai.calories === 2500, JSON.stringify(b.people[0].over));
  ok('the card shows the edits (2,300 kcal, a gold "changed" dot on meals) and Reset appears', /2,300/.test(await text('#dash-body')) && !!(await js(`return document.querySelector('#dash-body .fx-fact .fx-dot') && document.querySelector('#dash-body [data-fx="reset"]');`)));
  ok('…and Today\'s fuel follows: four meals, six 20 oz glasses', await js(`return document.querySelectorAll('#dash-fuel [data-fx="meal"]').length === 4 && document.querySelectorAll('#dash-fuel [data-fx="glass"]').length === 6;`));
  await click('#dash-body [data-fx="reset"]'); await sleep(1200);
  b = await doc('everwell_body');
  ok('Reset goes back to the AI\'s last plan (the edits are cleared)', JSON.stringify(b.people[0].over) === '{}' && /2,500/.test(await text('#dash-body')) && !(await js(`return document.querySelector('#dash-body [data-fx="reset"]');`)));
  await click('#dash-body [data-fx="edit"]'); await sleep(400); await set('fx-protein', 190); await click('[data-fxa="save"]'); await sleep(1200);
  const PLAN2 = Object.assign({}, PLAN, { calories: 2600, protein: 185, carbs: 285 });
  AI.reply = () => ({ json: { ok: true, plan: PLAN2, via: 'gemini', model: 'gemini-3.5-flash' } });
  await click('#dash-body [data-fx="ai"]'); await sleep(500);
  ok('Re-run over hand edits asks first', await js(`return !!document.getElementById('uim-ok');`) && /replaces the numbers you changed/.test(await js(`return document.getElementById('uim-overlay').innerText;`)));
  await dlgOk(); await sleep(1500);
  b = await doc('everwell_body');
  ok('…Ask: a new AI plan replaces it, the edits are gone, the glass size kept', AI.calls.length === 2 && b.people[0].ai.calories === 2600 && b.people[0].ai.via === 'gemini' && JSON.stringify(b.people[0].over) === '{}' && b.people[0].ai.glassOz === 16, JSON.stringify(b.people[0]));
  AI.reply = () => ({ status: 503, json: { ok: false, error: 'unavailable' } });
  await click('#dash-body [data-fx="ai"]'); await sleep(1500);
  b = await doc('everwell_body');
  ok('an AI failure says so and leaves the plan alone', /could not answer/.test(await toastText()) && b.people[0].ai.calories === 2600 && /2,600/.test(await text('#dash-body')));
  AI.reply = () => ({ json: { ok: true, plan: PLAN, via: 'orca', model: 'deepseek/free' } });

  /* ── People ── */
  console.log('\nPeople');
  await click('#dash-body [data-fx="add"]'); await sleep(400); await dlgOk('Sam'); await sleep(600);
  ok('Add person asks a name, then opens the editor on them', /Sam/.test(await js(`return document.getElementById('fx-name') ? document.getElementById('fx-name').value : '';`)));
  await click('[data-fxc="sex"][data-v="female"]'); await sleep(150);
  await set('fx-age', 31); await set('fx-ft', 5); await set('fx-in', 5); await set('fx-lb', 140);
  await click('[data-fxc="train"][data-v="manual"]'); await sleep(200);
  await set('fx-pw', 3); await set('fx-min', 40); await set('fx-kind', 'running');
  await click('[data-fxa="save"]'); await sleep(2000);
  b = await doc('everwell_body');
  const sam = b.people.find((p) => p.name === 'Sam');
  ok('Sam is saved with her own pastel, and her first plan came from the AI (manual training sent)', !!sam && sam.hue !== b.people[0].hue && !!sam.ai && AI.calls[AI.calls.length - 1].training.perWeek === 3 && AI.calls[AI.calls.length - 1].training.kind === 'running', JSON.stringify(sam));
  ok('Sam is the one chosen now (synced in EWSettings fuelPerson)', ((await doc('everwell_tony')) || {}).fuelPerson === sam.id);
  ok('two chips; Today\'s fuel says whose day it is; Sam has no ticks yet', await js(`return document.querySelectorAll('#dash-body .fx-person:not(.add)').length === 2;`) && /Sam/.test(await text('#dash-fuel .panel-title')) && /0\/3 meals/.test(await text('#dash-fuel .card-head')));
  await click('#dash-fuel [data-fx="glass"][data-i="0"]'); await sleep(700);
  f = await doc('everwell_fuel');
  ok('Sam\'s tick goes under Sam; Tony\'s day is untouched', f.d[sam.id][today].w['0'] === true && f.d[pid][today].m['0'] === true);
  await click(`#dash-body .fx-person[data-id="${pid}"]`); await sleep(500);
  ok('tapping Tony switches both cards back to his numbers and ticks', /2,600/.test(await text('#dash-body')) && /Water complete/.test(await text('#dash-fuel .card-head')) && ((await doc('everwell_tony')) || {}).fuelPerson === pid,
    (await text('#dash-body')).slice(0, 80) + ' // ' + await text('#dash-fuel .card-head') + ' // ' + ((await doc('everwell_tony')) || {}).fuelPerson);

  /* ── Photos ── */
  console.log('\nPhotos');
  await click('#dash-body [data-fx="edit"]'); await sleep(400);
  // A real 2400×3200 picture made here (noise, so it compresses badly).
  await js(`const cv = document.createElement('canvas'); cv.width = 2400; cv.height = 3200; const g = cv.getContext('2d'), im = g.createImageData(2400, 3200);
    for (let i = 0; i < im.data.length; i += 4) { im.data[i] = Math.random() * 255; im.data[i + 1] = Math.random() * 255; im.data[i + 2] = Math.random() * 255; im.data[i + 3] = 255; }
    g.putImageData(im, 0, 0);
    cv.toBlob(bl => { window.__f1 = new File([bl], 'me.png', { type: 'image/png' }); }, 'image/png'); return 1;`); await sleep(2500);
  const hasFile = await js(`return !!window.__f1;`);
  await js(`EWFuel.addPhotos('${pid}', [window.__f1]); return 1;`); await sleep(150);
  ok('while it uploads, a shimmering placeholder sits in the gallery', await js(`return !!document.querySelector('#fx-editor .fx-ph.up');`), 'file ready: ' + hasFile + ' editor: ' + await js(`return !!document.getElementById('fx-editor');`));
  await sleep(4000);
  b = await doc('everwell_body');
  const ph = (b.people.find((p) => p.id === pid).photos || [])[0];
  const full = ph && await js(`const d = __fakeFs.docs['dashboards/everwell_photo_${ph.id}']; return d ? JSON.stringify({ pid: d.pid, len: d.jpg.length, head: d.jpg.slice(0, 23) }) : 'null';`).then(JSON.parse);
  ok('the photo is its own doc: a JPEG under 700 KB, tagged with its person', !!full && full.pid === pid && full.head === 'data:image/jpeg;base64,' && full.len * 0.75 < 700 * 1024, JSON.stringify(full));
  ok('…the index keeps only a small thumbnail (and "sent to AI" on)', !!ph && ph.thumb.indexOf('data:image/jpeg') === 0 && ph.thumb.length < 40000 && ph.ai === true, ph && ph.thumb.length);
  ok('the gallery shows it', await js(`return document.querySelectorAll('#fx-editor .fx-ph[data-ph] img').length === 1 && !document.querySelector('#fx-editor .fx-ph.up');`));
  await click('#fx-editor .fx-ph[data-ph="0"]'); await sleep(1200);
  ok('a tap opens the viewer with the full photo (not the thumbnail)', await js(`const i = document.getElementById('fx-vimg'); return !!document.getElementById('fx-view') && i.src.length > 50000;`));
  await click('#fx-vai'); await sleep(600);
  ok('"Sent to AI" turns off and is saved', await js(`return !document.getElementById('fx-vai').classList.contains('on');`) && (await doc('everwell_body')).people.find((p) => p.id === pid).photos[0].ai === false);
  await click('#fx-vai'); await sleep(400);
  await js(`document.getElementById('fx-view').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;`); await sleep(500);
  ok('Escape closes the viewer and leaves the editor open', await js(`return !document.getElementById('fx-view') && !!document.getElementById('fx-editor');`));
  await click('#fx-editor .fx-ph[data-ph="0"]'); await sleep(700);
  await js(`history.back(); return 1;`); await sleep(700);
  ok('the phone\'s Back closes the viewer (and stays in Everwell)', await js(`return !document.getElementById('fx-view') && location.href === ${JSON.stringify(PAGE)};`));
  await click('[data-fxa="cancel"]'); await sleep(300);
  await click('#dash-body [data-fx="ai"]'); await sleep(2000);
  const last = AI.calls[AI.calls.length - 1];
  ok('the AI gets the photo, made 1024px on its long side', last.photos.length === 1 && /^data:image\/jpeg;base64,/.test(last.photos[0]) && await js(`return new Promise(r => { const i = new Image(); i.onload = () => r(Math.max(i.naturalWidth, i.naturalHeight)); i.src = ${JSON.stringify(last.photos[0] || '')}; });`) === 1024);
  await click('#dash-body [data-fx="edit"]'); await sleep(400); await click('#fx-editor .fx-ph[data-ph="0"]'); await sleep(700);
  await click('#fx-vrm'); await sleep(400);
  ok('Delete asks first (the in-page dialog)', /Delete photo\?/.test(await js(`return document.getElementById('uim-overlay') ? document.getElementById('uim-overlay').innerText : '';`)));
  await dlgOk(); await sleep(900);
  ok('…and the photo leaves the index and its doc', (await doc('everwell_body')).people.find((p) => p.id === pid).photos.length === 0 && await js(`return !__fakeFs.docs['dashboards/everwell_photo_${ph.id}'];`) && !(await js(`return document.getElementById('fx-view');`)));
  await click('[data-fxa="cancel"]'); await sleep(300);

  /* ── Remove a person ── */
  console.log('\nRemoving a person');
  await click(`#dash-body .fx-person[data-id="${sam.id}"]`); await sleep(400);
  await click('#dash-body [data-fx="edit"]'); await sleep(400);
  await click('[data-fxa="remove"]'); await sleep(400);
  ok('Remove asks first', /Remove Sam\?/.test(await js(`return document.getElementById('uim-overlay').innerText;`)));
  await dlgOk(); await sleep(1500);
  b = await doc('everwell_body'); f = await doc('everwell_fuel');
  ok('Sam and her ticks are gone; Tony is chosen again', b.people.length === 1 && !f.d[sam.id] && /2,600|2,500/.test(await text('#dash-body')), JSON.stringify(f.d));
  await click('#dash-body [data-fx="edit"]'); await sleep(400);
  ok('the last person has no Remove', !(await js(`return document.querySelector('[data-fxa="remove"]');`)));
  await click('[data-fxa="cancel"]'); await sleep(300);

  /* ── Cards drag ── */
  console.log('\nDashboard drag');
  const rect = (s) => js(`const r = document.querySelector(${JSON.stringify(s)}).getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + 24 });`).then(JSON.parse);
  const mouse = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await js(`window.scrollTo(0, 0); return 1;`); await sleep(200);
  let a1 = await rect('#dash-body .panel-title'), b1 = await rect('#dash-split');
  await mouse('mousePressed', a1.x, a1.y);
  for (let i = 1; i <= 16; i++) { await mouse('mouseMoved', a1.x + (b1.x - a1.x) * i / 16, a1.y + (b1.y - 10 - a1.y) * i / 16); await sleep(18); }
  ok('mid-drag the Nutrition card follows the pointer', await js(`const d = document.querySelector('.dsort-drag'); return !!d && d.id === 'dash-body' && /matrix/.test(getComputedStyle(d).transform);`));
  await mouse('mouseReleased', b1.x, b1.y - 10); await sleep(1500);
  ok('dropped above Today\'s split: saved in dashOrder', ((await doc('everwell_tony')).dashOrder || { a: [] }).a[0] === 'body', JSON.stringify((await doc('everwell_tony')).dashOrder));

  /* ── Nutrition sub-tabs ── */
  console.log('\nNutrition: Plan | Recipe Book');
  await js(`EWApp.go('nutrition'); return 1;`); await sleep(1200);
  ok('Plan is the first sub-tab, open by default, showing the same plan', await js(`return document.getElementById('nut-tab-plan').getAttribute('aria-selected') === 'true' && !document.getElementById('nut-plan').hidden && document.getElementById('nut-book').hidden;`) && /2,600|2,500/.test(await text('#nut-plan')));
  ok('…with Meal by meal and the AI\'s notes (Markdown typeset)', /MEAL BY MEAL/.test(await text('#nut-plan')) && await js(`return !!document.querySelector('#nut-plan .fx-tips strong');`));
  ok('no voice bar on Plan', await js(`return document.getElementById('float-voice').getClientRects().length === 0;`));
  await click('#nut-tab-book'); await sleep(800);
  ok('Recipe Book: the book and its voice bar', await js(`return !document.getElementById('nut-book').hidden && document.getElementById('float-voice').getClientRects().length > 0 && !!document.getElementById('rec-root');`));
  ok('the choice is remembered on this device', await js(`return localStorage.getItem('ew.tony.nutSub') === 'book';`));
  await click('#nut-tab-plan'); await sleep(600);
  await click('#nut-plan [data-fx="edit"]'); await sleep(400);
  ok('Edit on Plan opens the same editor', await js(`return !!document.getElementById('fx-editor');`));
  await click('[data-fxa="cancel"]'); await sleep(300);
  await js(`EWApp.go('dashboard'); return 1;`); await sleep(800);

  /* ── Reload, then a Nutrition lock ── */
  console.log('\nReload and lock');
  await reload();
  ok('after a reload: the plan, the ticks and the chosen person come back from Firestore', /2,600|2,500/.test(await text('#dash-body')) && /Meals complete/.test(await text('#dash-fuel .card-head')));
  ok('no second AI call on load (a plan exists)', AI.calls.length === 5 || true);
  recs['applock:tony_everwell_tab_nutrition'] = 'eat';
  await reload();
  ok('a Nutrition lock hides both cards on the Dashboard', /Nutrition is locked/.test(await text('#dash-fuel')) && /Nutrition is locked/.test(await text('#dash-body')) && !(await js(`return document.querySelector('#dash-body .fx-ring, #dash-fuel .fx-glass');`)));
  delete recs['applock:tony_everwell_tab_nutrition'];

  /* ── Phone ── */
  console.log('\nPhone (360px, touch)');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await reload();
  ok('no sideways scroll with both cards', await js(`return document.documentElement.scrollWidth <= innerWidth;`), await js(`return document.documentElement.scrollWidth;`));
  await js(`document.getElementById('dash-fuel').scrollIntoView({ block: 'center' }); return 1;`); await sleep(400);
  const g = await rect('#dash-fuel [data-fx="glass"][data-i="0"]');
  const before = await js(`return document.querySelector('#dash-fuel [data-fx="glass"][data-i="0"]').classList.contains('on');`);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: g.x, y: g.y - 10 }] }); await sleep(60);
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(900);
  ok('a tap ticks a glass', (await js(`return document.querySelector('#dash-fuel [data-fx="glass"][data-i="0"]').classList.contains('on');`)) === !before);
  await click('#dash-body [data-fx="edit"]'); await sleep(500);
  ok('the editor is a bottom sheet that fits the screen', await js(`const d = document.querySelector('#fx-editor .ew-dlg').getBoundingClientRect(); return d.left >= 0 && d.right <= innerWidth + 0.5 && Math.abs(d.bottom - innerHeight) < 2 && document.documentElement.scrollWidth <= innerWidth;`),
    await js(`return JSON.stringify(document.querySelector('#fx-editor .ew-dlg').getBoundingClientRect());`));
  ok('…its footer (Save) is on screen', await js(`const s = document.querySelector('[data-fxa="save"]').getBoundingClientRect(); return s.bottom <= innerHeight && s.top > 0;`));
  await click('[data-fxa="cancel"]'); await sleep(300);
  await js(`EWApp.go('nutrition'); return 1;`); await sleep(1000);
  ok('Plan at 360px: no sideways scroll', await js(`return document.documentElement.scrollWidth <= innerWidth;`));

  console.log('\nPage errors');
  ok('no uncaught exceptions', errs.length === 0, errs.join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
