// Verifies the Practice view and its drills in a real browser (engagement Phase 3).
//
// Served over http://127.0.0.1 (not file://) because the offline check needs
// the service worker, and service workers do not run on file:// pages.
//
//   - the hub lists every drill; each one mounts without an exception
//   - SQL: a right query is graded ✓, a wrong one ✗ with a reason
//   - a sitting is logged as ONE 'drill' session carrying XP
//   - visualizers step; predict mode offers choices
//   - OFFLINE: after one online visit, the page reloads with the network off
//     and a SQL challenge still grades (sql.js WASM comes from the cache)
import { launch, connect } from './cdp.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, normalize } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
if (!existsSync(resolve(dist, 'studyos/index.html'))) { console.error('Build first:  npm run build'); process.exit(2); }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(resolve(dist, '.' + p));
    if (!file.startsWith(dist)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch (e) { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${server.address().port}/studyos/`;

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name, extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400)); }
};
const done = (code) => { server.close(); process.exit(code); };

try { await launch(); }
catch (e) { if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); done(0); } throw e; }
const { send, evalJs, events } = await connect();
await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.navigate', { url: PAGE });
await wait(4000);
await evalJs(`window._fbSaveStudyOs = function(){}; window._fbSaveCards = function(){}; window._fbSaveDoc = function(){};
  window._fbSaveSessions = function(){}; true;`);

console.log('\nthe hub');
await evalJs(`switchView('practice'); true;`);
await wait(800);
const hub = await evalJs(`({
  active: (document.querySelector('.view.active')||{}).id,
  drills: Array.from(document.querySelectorAll('#sos-practice-root [data-drill]')).map(function(b){ return b.dataset.drill; }),
  nav: !!document.getElementById('nav-practice') && !!document.getElementById('sos-bn-practice'),
  level: (document.querySelector('#sos-practice-root .sp-score')||{}).textContent || '',
})`);
t('Practice is a view with nav entries', hub.active === 'view-practice' && hub.nav, hub);
t('every drill is listed', hub.drills.length >= 16, hub.drills);
t('the level line shows', /Level \d+/.test(hub.level), hub.level);

console.log('\nSQL challenges');
await evalJs(`window.SOS.practice.openDrill('sql'); true;`);
await wait(2500);
const list = await evalJs(`document.querySelectorAll('[data-ch]').length`);
t('27 challenges listed', list === 27, list);
await evalJs(`document.querySelector('[data-ch="sql04"]').click(); true;`);
await wait(800);
const grade = async (sql) => {
  await evalJs(`(function(){ var ta = document.querySelector('[data-sql]'); ta.value = ${JSON.stringify(sql)}; document.querySelector('[data-check]').click(); return true; })()`);
  await wait(900);
  return evalJs(`(document.querySelector('[data-feedback]')||{}).textContent || ''`);
};
const wrong = await grade("SELECT * FROM SKU_DATA WHERE Department = 'Camping'");
t('a wrong query is ✗ with a reason', /✗/.test(wrong) && /row/.test(wrong), wrong);
t('...and unlocks a hint', await evalJs(`/Hint 1/.test((document.querySelector('[data-hints]')||{}).textContent||'')`));
const right = await grade("SELECT * FROM SKU_DATA WHERE Department = 'Water Sports';");
t('the right query is ✓', /✓/.test(right), right);
t('the result table is shown', await evalJs(`document.querySelectorAll('[data-out] table tr').length === 5`));
t('the score line counts the sitting', /1\/2/.test(await evalJs(`(document.querySelector('[data-score]')||{}).textContent||''`)));
const miss = await evalJs(`window.SOS.progress.topicStats().find(function(s){ return /SQL: WHERE/.test(s.topic); })`);
t('the miss is in the weak-spot log', miss && miss.misses >= 1, miss);

console.log('\na sitting is one session');
await evalJs(`window.SOS.practice.render(); true;`);  // back to the hub ends the sitting — under 60 s here
const short = await evalJs(`window.SOS.sessions.all().filter(function(s){ return s.kind === 'drill'; }).length`);
t('a sitting under a minute is not logged (the 60s floor)', short === 0, short);
const sess = await evalJs(`(async function(){
  var p = window.SOS.practice;
  await p.openDrill('trace');
  await new Promise(function(r){ setTimeout(r, 500); });
  var inp = document.querySelector('[data-a]'); inp.value = 'x'; document.querySelector('[data-check]').click();
  // Backdate the sitting so it clears the 60 s floor.
  var real = Date.now; Date.now = function(){ return real() + 3 * 60000; };
  p.render();
  Date.now = real;
  var list = window.SOS.sessions.all().filter(function(s){ return s.kind === 'drill'; });
  return list[list.length - 1] || null;
})()`);
t('leaving a drill logs ONE drill session', sess && sess.kind === 'drill' && sess.items === 1, sess);
t('...carrying XP', sess && sess.xp >= 1, sess);

console.log('\nevery drill mounts');
const ids = hub.drills;
for (const id of ids) {
  const r = await evalJs(`(async function(){
    try {
      await window.SOS.practice.openDrill(${JSON.stringify(id)});
      await new Promise(function(r){ setTimeout(r, 400); });
      var host = document.querySelector('[data-drill-host]');
      return { ok: !!host && host.innerHTML.length > 50 };
    } catch (e) { return { error: String(e && e.message || e) }; }
  })()`);
  t(`${id} mounts`, r && r.ok, r);
}

console.log('\nvisualizers');
{
  await evalJs(`window.SOS.practice.openDrill('viz-avl'); true;`);
  await wait(500);
  await evalJs(`document.querySelector('[data-preset="0"]').click(); true;`);  // RR: 10 20 30
  for (let i = 0; i < 12; i++) await evalJs(`document.querySelector('[data-step]').click(); true;`);
  const note = await evalJs(`(document.querySelector('[data-note]')||{}).textContent||''`);
  const svgNodes = await evalJs(`document.querySelectorAll('[data-stage] svg circle').length`);
  t('AVL RR preset ends balanced with 3 nodes', svgNodes === 3 && /Balanced|No rotation/.test(note), { svgNodes, note });
  await evalJs(`document.querySelector('[data-reset]').click(); document.querySelector('[data-predict]').checked = true;
    document.querySelector('[data-preset="0"]').click(); true;`);
  let asked = false;
  for (let i = 0; i < 12 && !asked; i++) {
    await evalJs(`document.querySelector('[data-step]').click(); true;`);
    asked = await evalJs(`document.querySelectorAll('[data-pick]').length >= 2`);
  }
  t('predict mode asks before the rotation', asked);
  if (asked) {
    await evalJs(`document.querySelector('[data-pick]').click(); true;`);
    t('...and scores the pick', /✓|✗/.test(await evalJs(`(document.querySelector('[data-predict-area]')||{}).textContent||''`)));
  }
  await evalJs(`window.SOS.practice.openDrill('viz-graph'); true;`);
  await wait(500);
  await evalJs(`document.querySelector('[data-run]').click(); true;`);
  for (let i = 0; i < 10; i++) await evalJs(`document.querySelector('[data-step]').click(); true;`);
  t('BFS runs to the hand-traced order', /A → B → D → C → E → G → F/.test(await evalJs(`(document.querySelector('[data-note]')||{}).textContent||''`)));
}

console.log('\noffline');
{
  const sw = await evalJs(`(async function(){
    if (!navigator.serviceWorker) return 'none';
    var reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return 'unregistered';
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller ? 'controlling' : 'registered';
  })()`);
  t('the service worker is installed', sw === 'controlling' || sw === 'registered', sw);
  // One more online load so the page itself is fetched THROUGH the worker.
  await send('Page.reload', {});
  await wait(4000);
  await evalJs(`switchView('practice'); window.SOS.practice.openDrill('sql'); true;`);
  await wait(2500);
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send('Page.reload', {});
  await wait(5000);
  const off = await evalJs(`(async function(){
    try {
      window._fbSaveStudyOs = function(){};
      switchView('practice');
      await window.SOS.practice.openDrill('sql');
      await new Promise(function(r){ setTimeout(r, 1500); });
      document.querySelector('[data-ch="sql05"]').click();
      await new Promise(function(r){ setTimeout(r, 800); });
      document.querySelector('[data-sql]').value = 'SELECT SKU, SKU_Description FROM SKU_DATA WHERE SKU > 200000';
      document.querySelector('[data-check]').click();
      await new Promise(function(r){ setTimeout(r, 2000); });
      return (document.querySelector('[data-feedback]')||{}).textContent || 'no feedback';
    } catch (e) { return 'error: ' + (e && e.message); }
  })()`);
  t('offline: the page loads and a SQL challenge still grades', /✓/.test(off), off);
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}

const errs = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails?.exception?.description || '?')
  .filter((e) => !/firebase|firestore|net::|Failed to load|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_|Failed to fetch|NetworkError/i.test(e));
console.log('\noverall');
t('no uncaught exceptions', errs.length === 0, errs.slice(0, 5));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
done(fail ? 1 : 0);
