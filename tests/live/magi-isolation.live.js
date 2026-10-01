// LIVE test -- Phase 15's isolation checks, run ON VEDA'S PC against HER
// engine (not run by run-all.js; sends no question). The whole procedure,
// including the guard test and the one manual look, is in
// docs/veda-isolation-check.md.
//
// Run: node tests/live/magi-isolation.live.js
//      MAGI_BASE=http://127.0.0.1:8001 if her engine is on 8001.
//
//   1. Each console reaches only its own engine: the engine here answers as
//      "veda" and is not Tony's; the console opened as Veda talks to it; the
//      console opened as Tony on this PC never does (offline, or Tony's own
//      engine over his tunnel).
//   2. History is separate: Veda's console keeps its history in
//      dashboards/magi_veda (Tony's is dashboards/magi), and her engine's
//      run list holds none of Tony's runs.
//   3. A locked profile fetches nothing: Veda's console, locked, sends no
//      request to the engine and none to Firestore -- only the lock check.
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');

const URL0 = require('./cdp.js').PAGES_URL;
const BASE = (process.env.MAGI_BASE || 'http://127.0.0.1:8000').replace(/\/+$/, '');
// Tony's engine, and runs only Tony ever made (2026-10-01): none of these may
// turn up on Veda's side.
const TONY_ENGINE = 'eng_68bec3b7a7ff';
const TONY_RUNS = ['6724ac392d6a', '9d22f1e8835e', 'a247e1b21c35', '8d27651dddec'];
const UNLOCKED = `(()=>{if(window.top!==window)return;const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 return real(u,o);};})();`;

let pass = 0, fail = 0, skip = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 200) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 300) + ']' : '')); }
};
const note = (n) => { skip++; console.log('  NOTE  ' + n); };
const waitFor = async (c, expr, ms = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await evalJs(c, expr)) return true; } catch {} await sleep(300); }
  return false;
};
const page = (p) => URL0 + (URL0.includes('?') ? '&' : '?') + 'profile=' + p;

(async () => {
  // ── 1a. the engine here is Veda's ──────────────────────────────────────
  console.log(`\n1. Each console reaches only its own engine  (engine: ${BASE})`);
  let mine = null;
  try { mine = await (await fetch(BASE + '/api/health')).json(); } catch (e) {
    ok('her engine answers', false, `${BASE}: ${e.message}. Is it running? Try MAGI_BASE=http://127.0.0.1:8001`);
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(1);
  }
  ok('the engine on this PC answers as "veda"', mine.profile === 'veda', `profile=${mine.profile}`);
  ok('...and is not Tony\'s engine', mine.engine && mine.engine.id && mine.engine.id !== TONY_ENGINE,
     mine.engine && `${mine.engine.id} "${mine.engine.label}"`);

  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  const reqs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url);
  });
  try {
    // ── 1b/2. the console opened as Veda ──────────────────────────────────
    const s1 = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: UNLOCKED });
    await c.send('Page.navigate', { url: page('veda') });
    ok('the console opens as Veda', await waitFor(c, 'PROFILE.id === "veda"', 10000));
    const reached = await waitFor(c, 'online()', 30000);
    ok('Veda\'s console finds an engine', reached);
    if (reached) {
      const h = JSON.parse(await evalJs(c, 'return fetch(link.api + "/api/health", authed()).then(r => r.json()).then(j => JSON.stringify(j));'));
      ok('...and it is hers (profile veda, this engine)', h.profile === 'veda' && h.engine && h.engine.id === mine.engine.id,
         `${h.profile} ${h.engine && h.engine.id}`);
    }
    console.log('\n2. History is separate');
    const doc = await evalJs(c, 'prof().doc');
    ok('Veda\'s console keeps its history in dashboards/magi_veda', doc === 'magi_veda', `dashboards/${doc}`);
    ok('...and Tony\'s profile is a different document', (await evalJs(c, 'MAGI_PROFILES.tony.doc')) === 'magi');
    let runs = [];
    try { runs = await (await fetch(BASE + '/api/runs?limit=500')).json(); } catch {}
    const ids = new Set((Array.isArray(runs) ? runs : []).map((r) => r.id));
    ok('her engine\'s run list holds none of Tony\'s runs', TONY_RUNS.every((id) => !ids.has(id)),
       `${ids.size} runs on her engine`);

    // ── 1c. the console opened as Tony on her PC ──────────────────────────
    await c.send('Page.navigate', { url: page('tony') });
    await waitFor(c, 'PROFILE.id === "tony"', 10000);
    await sleep(12000);   // discovery: same origin, this PC, then Tony's tunnel
    const tonyOnline = await evalJs(c, 'online()');
    if (!tonyOnline) {
      ok('Tony\'s console on her PC does not reach her engine (it finds none)', true, 'offline');
    } else {
      const th = JSON.parse(await evalJs(c, 'return fetch(link.api + "/api/health", authed()).then(r => r.json()).then(j => JSON.stringify(j));'));
      ok('Tony\'s console on her PC reaches only Tony\'s engine, never hers',
         th.profile === 'tony' && (!th.engine || th.engine.id !== mine.engine.id), `${th.profile} ${th.engine && th.engine.id}`);
    }
    await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s1.result.identifier });

    // ── 3. locked: nothing fetched ─────────────────────────────────────────
    console.log('\n3. A locked profile fetches nothing');
    // The REAL lock service this time (no stub), in a fresh tab state.
    await c.send('Network.clearBrowserCookies');
    await c.send('Page.navigate', { url: 'about:blank' });
    await evalJs(c, 'return 1;');
    await c.send('Page.navigate', { url: page('veda') });
    await sleep(1500);
    await evalJs(c, 'try { localStorage.clear(); sessionStorage.clear(); } catch {} return 1;');
    reqs.length = 0;
    await c.send('Page.navigate', { url: page('veda') });
    const decided = await waitFor(c, 'LOCK.booted === true', 20000);
    const hasLock = decided && await evalJs(c, 'LOCK.hasLock');
    if (!hasLock) {
      note('Veda has no MAGI password set, so there is nothing to lock: check 3 needs one (the lock button, top right). Set one and run again.');
    } else {
      ok('Veda\'s profile opens LOCKED on a fresh browser', await evalJs(c, '!LOCK.session'));
      await sleep(15000);
      const host = new URL(BASE).host;
      const engineCalls = reqs.filter((u) => u.includes(host) || u.includes('trycloudflare.com') || u.includes('/api/'));
      const fsCalls = reqs.filter((u) => /firestore\.googleapis\.com|firebaseio|magi_veda/.test(u));
      ok('locked: no request to the engine', engineCalls.length === 0, engineCalls.slice(0, 3).join(' '));
      ok('locked: no request to Firestore', fsCalls.length === 0, fsCalls.slice(0, 3).join(' '));
      ok('...only the lock check went out', reqs.some((u) => u.includes('/auth/journal/status')),
         `${reqs.length} requests`);
    }
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e.stack || e));
  } finally {
    try { c.close && c.close(); } catch {}
    console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} note(s)` : ''}`);
    process.exit(fail ? 1 : 0);
  }
})();
