#!/usr/bin/env node
/**
 * The self-cleanup system: cleanup-rules.json, sweep.js and their callers.
 *
 * WHY THIS FILE EXISTS
 * A cleanup that deletes the wrong thing destroys data, and one that runs too
 * often spends quota. Both look fine until they don't. These are the hard rules
 * from docs/myjournal-strip-plan.md Phase 4, checked where the code allows:
 *
 *   - no Firestore reads, at most 25 deletes per sweep, once a day, never
 *     before the boot write guard clears
 *   - KV deletes only on a request that already happens (no list, no cron)
 *   - fail closed on bad rules or unusable storage
 *   - "delete": false really is a dry run
 *   - a key or doc on the dead list is not used by any live code
 *
 * The behavioural half runs the SHIPPED sweep.js in jsdom.
 * magi/tests/test_sweep.py covers the MAGI disk half.
 *
 * Run: node tests/cleanup-rules.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const RULES = JSON.parse(read('cleanup-rules.json'));
const SWEEP = read('sweep.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

// ── The registry ──────────────────────────────────────────────────────────
console.log('\nThe registry');
const L = RULES.limits;
ok('at most 25 Firestore deletes per sweep', L.firestoreDeletesPerSweep > 0 && L.firestoreDeletesPerSweep <= 25);
ok('zero Firestore reads per sweep', L.firestoreReadsPerSweep === 0);
ok('KV deletes capped at 20/day/account (2% of 1000)', L.kvDeletesPerDayPerAccount <= 20);
ok('one sweep per program per day', L.sweepsPerProgramPerDay === 1);
ok('age caps: screenshots/dumps 7, error logs 14, failed jobs/dead queues 30',
  JSON.stringify(RULES.ageDays) === JSON.stringify({ screenshot: 7, debugDump: 7, errorLog: 14, failedJob: 30, deadQueue: 30 }));

const ids = new Set();
for (const it of RULES.items) {
  const tag = it.id || '(no id)';
  ok(`${tag}: has an owner, a reason, a category, a cap and a delete flag`,
    it.id && it.owner && it.reason && ['failed', 'unused', 'outdated', 'corrupt'].includes(it.category) &&
    typeof it.capDays === 'number' && typeof it.delete === 'boolean' && it.program);
  ok(`${tag}: unique id`, !ids.has(it.id)); ids.add(it.id);
  if (it.kind) ok(`${tag}: its cap matches ageDays.${it.kind}`, RULES.ageDays[it.kind] === it.capDays);
  if (it.delete) ok(`${tag}: deletion on only with a recorded approval`, typeof it.approved === 'string' && it.approved.length > 10);
}

// ── Dead keys and docs are dead ───────────────────────────────────────────
// A key on the list must not be read or written by anything live. Same origin
// means every page shares localStorage, so the whole repo is checked (V1 too).
console.log('\nNothing live uses what the registry calls trash');
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.venv', 'profiles', 'data', 'artifacts', 'tests', 'docs', 'Index Backups'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html|js|mjs|py)$/.test(e.name) && e.name !== 'sweep.js') out.push(p);
  }
  return out;
}
const live = walk(ROOT, []).map((p) => [path.relative(ROOT, p), fs.readFileSync(p, 'utf8')]);
const usedBy = (needle) => live.filter(([, src]) => src.includes(needle)).map(([p]) => p);
for (const it of RULES.items.filter((i) => i.store === 'localStorage')) {
  for (const k of [...(it.exact || []), ...(it.prefix || [])]) {
    const hits = usedBy(k);
    ok(`${it.id}: '${k}' is not used by live code`, hits.length === 0, hits.join(', '));
  }
}
for (const it of RULES.items.filter((i) => i.store === 'firestore')) {
  const id = it.doc.split('/').pop();
  const hits = usedBy(id);
  ok(`${it.id}: '${it.doc}' is not used by live code`, hits.length === 0, hits.join(', '));
}

// ── Wiring ────────────────────────────────────────────────────────────────
console.log('\nWiring');
const browserPrograms = new Set(RULES.items.filter((i) => ['localStorage', 'firestore'].includes(i.store)).map((i) => i.program));
for (const prog of browserPrograms) {
  const page = prog + '.html';
  const html = fs.existsSync(path.join(ROOT, page)) ? read(page) : '';
  ok(`${page} loads sweep.js as data-program="${prog}"`,
    new RegExp(`<script src="sweep\\.js" data-program="${prog}" defer></script>`).test(html));
}
const index = read('index.html');
ok('index.html: the Firestore adapter waits for the MyJournal write guard',
  /window\._a1SweepFirestore = \{\s*ready: \(\) => _tjServerSeen,\s*del: \(path\) => deleteDoc\(doc\(db, path\)\),\s*\};/.test(index));
ok('index.html: the old per-load mjd purge is gone (the registry owns it)', !/purgeLeftovers/.test(index));

ok('sweep.js makes no Firestore read of any kind',
  !/\b(getDoc|getDocs|getDocFromServer|getDocFromCache|onSnapshot|collection|query)\s*\(/.test(SWEEP));
ok('sweep.js only accepts fixed dashboards/<id> paths', /DOC_RE = \/\^dashboards\\\/\[A-Za-z0-9_-\]\+\$\//.test(SWEEP));
ok('sweep.js first-run delay matches the registry', SWEEP.includes('setTimeout(later, ' + L.firstRunDelayMs + ')'));
ok('sweep.js stamps the day BEFORE fetching the rules',
  SWEEP.indexOf('set(STAMP, today())') > 0 && SWEEP.indexOf('set(STAMP, today())') < SWEEP.indexOf('fetch(RULES_URL'));

for (const it of RULES.items.filter((i) => i.store === 'kv')) {
  const src = read(it.program + '/worker.js');
  const flag = /const SWEEP_STALE_TOKENS = (true|false);/.exec(src);
  ok(`${it.id}: the worker's switch matches "delete": ${it.delete}`, flag && flag[1] === String(it.delete));
  ok(`${it.id}: deletes only a token whose lock version is stale`,
    /if \(cur && rec\.v !== cur\) await dropStaleToken\(env, token\);/.test(src));
  ok(`${it.id}: no KV list (no discovery pass)`, !/\.list\(/.test(src.slice(src.indexOf('async function dropStaleToken'), src.indexOf('async function dropStaleToken') + 400)));
}

const launch = read('trading-auto-launch/launch.py');
for (const it of RULES.items.filter((i) => i.program === 'trading-auto-launch')) {
  ok(`${it.id}: launch.py keeps the same ${it.capDays} days`, new RegExp(`^LOG_KEEP_DAYS = ${it.capDays}$`, 'm').test(launch));
  ok(`${it.id}: launch.py trims on every run`, /args = parser\.parse_args\(\)\n\s+trim_logs\(\)/.test(launch));
}

// ── Behaviour: the shipped sweep.js ───────────────────────────────────────
function boot({ rules = RULES, storage = true, adapter, seed = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/A1/index.html',
    runScripts: 'outside-only',
    beforeParse(w) {
      if (!storage) Object.defineProperty(w, 'localStorage', { get() { throw new Error('SecurityError'); } });
      else for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, v);
      w.fetch = async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(rules)) });
      if (adapter) w._a1SweepFirestore = adapter;
    },
  });
  const w = dom.window;
  const s = w.document.createElement('script');
  s.setAttribute('data-program', 'index');
  Object.defineProperty(w.document, 'currentScript', { configurable: true, get: () => s });
  w.eval(SWEEP);
  return w;
}
const clone = () => JSON.parse(JSON.stringify(RULES));

(async () => {
  console.log('\nBehaviour');

  // The shipped rules: every listed key goes, nothing else does.
  {
    const w = boot({ seed: { mjd_cache: '1', mjd_tok_x: '1', warden_kc_colmap: '1', fcm_pv_purge_v1: '1',
      pv_cfg_v1: '1', pv_sched_v1: '1', keep_me: '1' } });
    const rep = await w.A1Sweep.run();
    ok('every listed key is deleted', ['mjd_cache', 'mjd_tok_x', 'warden_kc_colmap', 'fcm_pv_purge_v1']
      .every((k) => w.localStorage.getItem(k) === null), rep.deleted);
    ok('an unlisted key is untouched', w.localStorage.getItem('keep_me') === '1');
    ok("RiftIQ's live ProView keys are untouched", w.localStorage.getItem('pv_cfg_v1') === '1' && w.localStorage.getItem('pv_sched_v1') === '1');
    const again = await w.A1Sweep.run();
    ok('once a day: a second run the same day does nothing', again.skipped.includes('already swept today'));
  }

  // "delete": false is a dry run: listed, left alone, and no Firestore call.
  {
    const r = clone();
    r.items.forEach((i) => { if (i.id === 'warden-leftovers' || i.store === 'firestore') i.delete = false; });
    const calls = [];
    const w = boot({ rules: r, seed: { mjd_cache: '1', warden_kc_colmap: '1' },
      adapter: { ready: () => true, del: async (p) => { calls.push(p); } } });
    const rep = await w.A1Sweep.run();
    ok('an approved item is deleted', w.localStorage.getItem('mjd_cache') === null);
    ok('a dry-run item is only listed', w.localStorage.getItem('warden_kc_colmap') === '1' &&
      rep.wouldDelete.some((x) => x.includes('warden_kc_colmap')));
    ok('a dry-run Firestore item is listed, not run', calls.length === 0 && rep.wouldDelete.some((x) => x.includes('myjournal_docs')));
  }

  // Storage that throws (Veda's Brave): nothing happens, no crash.
  {
    const w = boot({ storage: false });
    const rep = await w.A1Sweep.run();
    ok('unusable storage stops the sweep', rep.error && /unavailable/.test(rep.error));
  }

  // Bad rules: nothing deleted.
  {
    const r = clone(); r.items.push({ id: 'x', store: 'localStorage', program: 'index', category: 'unused', capDays: 3,
      exact: ['keep_me'], owner: 'o', reason: 'r', delete: true });
    const w = boot({ rules: r, seed: { mjd_cache: '1', keep_me: '1' } });
    const rep = await w.A1Sweep.run();
    ok('a bad rule fails the whole run closed', rep.error && w.localStorage.getItem('mjd_cache') === '1' && w.localStorage.getItem('keep_me') === '1');
  }
  {
    const r = clone(); r.limits.firestoreDeletesPerSweep = 500;
    const w = boot({ rules: r, seed: { mjd_cache: '1' } });
    const rep = await w.A1Sweep.run();
    ok('a delete cap over 25 in the rules fails closed', rep.error && w.localStorage.getItem('mjd_cache') === '1');
  }
  {
    const r = clone(); r.items.push({ id: 'y', store: 'firestore', program: 'index', category: 'unused', capDays: 0,
      doc: 'dashboards/main/../x', owner: 'o', reason: 'r', delete: true });
    const w = boot({ rules: r });
    ok('a doc path that is not a fixed dashboards id fails closed', (await w.A1Sweep.run()).error);
  }

  // Firestore: the cap, the write guard, no repeats.
  {
    const r = clone();
    r.items = r.items.filter((i) => i.store !== 'firestore');
    for (let i = 0; i < 30; i++) r.items.push({ id: 'd' + i, store: 'firestore', program: 'index', category: 'unused',
      capDays: 0, doc: 'dashboards/dead_' + i, owner: 'o', reason: 'r', delete: true, approved: 'test fixture only' });
    const calls = [];
    const adapter = { ready: () => true, del: async (p) => { calls.push(p); } };
    const w = boot({ rules: r, adapter });
    await w.A1Sweep.run();
    ok('at most 25 Firestore deletes in one sweep', calls.length === 25, calls.length);
    await w.A1Sweep.run({ force: true });
    ok('a doc already deleted is never deleted again', calls.length === 30 && new Set(calls).size === 30, calls.length);

    const blocked = [];
    const w2 = boot({ rules: r, adapter: { ready: () => false, del: async (p) => { blocked.push(p); } } });
    const rep = await w2.A1Sweep.run();
    ok('nothing is deleted while the write guard is up', blocked.length === 0 && rep.skipped.some((x) => /write guard/.test(x)));
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
