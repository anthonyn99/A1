// View ↔ edit on BOTH TaskHubs: snappy, and nothing moves once it is done.
//
// Tony, 2026-11-04: "stuff in daily habits and short/long term goals shifts UI
// after animation is done". The row ✎ ✕ controls (ThPop) used to mount on edit
// and unmount ~260 ms after view; a habit or goal row holding the 20 px buttons
// was taller than the empty one, so rows jumped a beat after the toggle. ThPop
// now stays mounted (faded, inert), so:
//
//   • every habit row and goal row has the same rect in view and in edit;
//   • from 60 ms after a toggle until 1 s, no row moves (beyond the closing
//     "New habit" / "New goal" bar, which settles within its transition);
//   • hidden row controls are inert (not focusable, not clickable) in view mode;
//   • the transitions are short (≤ 200 ms);
//   • a day row's category pill fades out while its ✎ ✕ fade in (one
//     cross-fade, Tony 2026-11-04), and fades back on view.
//
// Run: node tests/live/taskhub-edit-toggle.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const pad = (n) => ('0' + n).slice(-2);
const now = new Date();
const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
const WEEK = monday.getFullYear() + '-' + pad(monday.getMonth() + 1) + '-' + pad(monday.getDate());
const habits = [{ id: 'h1', title: 'Breakfast for parents' }, { id: 'h2', title: 'Replace patches every 48 hours' }, { id: 'h3', title: 'Morning face wash' }];
const goals = [{ id: 'g1', title: 'Wash sheets', done: false }, { id: 'g2', title: 'Tell Mom about CVS extracare', done: false }, { id: 'g3', title: 'Done one', done: true }];
const TODAY = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
const DOC = { data: { [TODAY]: [{ id: 't1', type: 'task', title: 'Pill task', category: 'work', done: false }] }, habits, hc: {}, goals, monthlyGoals: goals.map((g) => ({ ...g, id: 'm' + g.id })), weekKey: WEEK, savedAt: Date.now() - 60000 };

// Rects of every habit row, goal row and their cells in the visible TaskHub.
const SNAP = `(() => {
  const vis = (e) => e && e.offsetParent !== null;
  const out = {};
  const r = (e) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 10) / 10).join(','); };
  [...document.querySelectorAll('tr[data-kind="habit"]')].filter(vis).forEach((tr) => { out['h:' + tr.dataset.dkey] = r(tr); });
  [...document.querySelectorAll('[data-kind="goal"]')].filter(vis).forEach((g) => { out['g:' + g.dataset.dkey] = r(g); });
  return out;
})()`;

async function side(c, who) {
  const js = (e) => evalJs(c, e);
  console.log('\n' + (who === 'tony' ? "Tony's" : "Veda's") + ' TaskHub');
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  const docs = who === 'tony' ? { 'dashboards/main': DOC } : { 'dashboards/vedasdash': DOC };
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','${who}'); localStorage.setItem('a1b_disabled','1');
    sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(docs))}); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  await sleep(10000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
  await sleep(1500);
  const bridge = who === 'tony' ? '_thVoice' : '_vdVoice';
  const set = (on) => js(`window.${bridge}.setEdit(${on}); 1`);
  const view = await js(`return ${SNAP};`);
  const n = Object.keys(view).length;
  ok('habit and goal rows rendered', Object.keys(view).filter((k) => k[0] === 'h').length >= 3 && Object.keys(view).filter((k) => k[0] === 'g').length >= 2, JSON.stringify(view));
  ok('row controls in view mode are inert (not focusable or clickable)', await js(`const p = [...document.querySelectorAll('.th-pop')].filter(e => e.offsetParent !== null && e.closest('[data-kind]'));
    return p.length > 0 && p.every(e => !e.classList.contains('in') && e.hasAttribute('inert') && getComputedStyle(e).pointerEvents === 'none');`));

  // Record every frame from the toggle on, both directions.
  for (const on of [true, false, true, false]) {
    await js(`window.__fr = []; const t0 = performance.now(); (function f(){ window.__fr.push([performance.now() - t0, ${SNAP}]); if (performance.now() - t0 < 1000) requestAnimationFrame(f); })(); window.${bridge}.setEdit(${on}); 1`);
    await sleep(1300);
    const fr = await js('return window.__fr;');
    const end = fr[fr.length - 1][1];
    // Rows move only while the bar above them opens or closes (≤ its 160 ms
    // transition + a frame); after that, never again.
    const late = fr.filter(([t, s]) => t > 260 && Object.keys(end).some((k) => s[k] !== end[k]));
    ok((on ? 'view → edit' : 'edit → view') + ': nothing moves after the animation', late.length === 0, late.length && JSON.stringify(late[0]));
    const lastMove = fr.reduce((m, [t, s], i) => (i && Object.keys(s).some((k) => s[k] !== fr[i - 1][1][k]) ? t : m), 0);
    ok((on ? 'view → edit' : 'edit → view') + ': settles fast (' + Math.round(lastMove) + ' ms)', lastMove < 260, lastMove);
    // Each row keeps its own size; only the bar above can push them down.
    const sizes = (s) => Object.keys(s).sort().map((k) => k + '=' + s[k].split(',').slice(2).join('x')).join(' ');
    ok((on ? 'edit' : 'view') + ' rows are exactly the size they are in view mode', sizes(end) === sizes(view) && Object.keys(end).length === n, sizes(end) + ' vs ' + sizes(view));
  }
  // The pill and the ✎ ✕ cross-fade: mid-way both are part-visible, at the
  // end the pill is gone and the buttons are in; back in view, the reverse.
  const PILL = `(() => { const r = document.querySelector('[data-dkey="t1"]'); if (!r || r.offsetParent === null) return null;
    const side = r.querySelector('.th-side'); const pill = [...side.children].find(e => !e.classList.contains('th-pop') && /work/i.test(e.textContent));
    const pop = side.querySelector('.th-pop'); return pill && pop ? [+getComputedStyle(pill).opacity, +getComputedStyle(pop).opacity] : 'missing'; })()`;
  for (const on of [true, false]) {
    const mid = await js(`window.${bridge}.setEdit(${on}); await new Promise(r => setTimeout(r, 50)); return ${PILL};`);
    await sleep(300);
    const end = await js(`return ${PILL};`);
    ok((on ? 'view → edit' : 'edit → view') + ': pill and ✎ ✕ cross-fade', Array.isArray(mid) && mid[0] > 0.05 && mid[0] < 0.95 && mid[1] > 0.05 && mid[1] < 0.95, JSON.stringify(mid));
    ok((on ? 'edit: pill hidden, ✎ ✕ shown' : 'view: pill shown, ✎ ✕ hidden'), Array.isArray(end) && (on ? end[0] === 0 && end[1] === 1 : end[0] === 1 && end[1] === 0), JSON.stringify(end));
  }
  ok('back in view, every row is exactly where it started', JSON.stringify(await js(`return ${SNAP};`)) === JSON.stringify(view));
  ok('pop transitions are short (≤ 200 ms)', await js(`const d = (s) => Math.max(...s.split(',').map(x => parseFloat(x) * (x.includes('ms') ? 1 : 1000)));
    const e = document.querySelector('.th-pop'); const cs = getComputedStyle(e); return d(cs.transitionDuration) <= 200;`));
  await set(false);
}

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1666, height: 1300, deviceScaleFactor: 1, mobile: false });
  await side(c, 'tony');
  await side(c, 'veda');
  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
