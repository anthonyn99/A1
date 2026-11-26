// Neo Cortex's bot worker (workers3/quant-bot; A1-Priv docs/TradeHub/quant/n4-03.md). N3: who may
// call it (Tony's key by hash; probes also by PROBE_KEY), the lab runs, the strategies (the Gate runs
// again on receipt; a version never changes), "Research now" requests. On a REAL SQLite D1 with every
// migration. Order hosts: only Alpaca's paper and data hosts appear in the worker (rule 2).
//
// Run: node tests/quant-bot.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('crypto');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const WDIR = path.join(__dirname, '..', 'workers3', 'quant-bot');
function realD1() {
  const sql = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(path.join(WDIR, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) sql.exec(fs.readFileSync(path.join(WDIR, 'migrations', f), 'utf8'));
  const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a.map(norm)),
    async first() { const r = sql.prepare(q).get(...args); return r ? { ...r } : null; },
    async all() { return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = sql.prepare(q).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { sql, prepare: (q) => stmt(q) };
}
const KEY = 'orca_sk_test_tony_key_123456';
const env = () => ({ DB: realD1(), ALLOWED_KEYS: createHash('sha256').update(KEY).digest('hex'), PROBE_KEY: 'probe-secret' });
const call = (W, e, method, p, body, key = KEY) => W.default.fetch(new Request('https://quant-bot.test' + p, { method, headers: key ? { authorization: 'Bearer ' + key } : {}, body: body ? JSON.stringify(body) : undefined }), e);
const j = async (r) => ({ status: r.status, ...(await r.json()) });

(async () => {
  const W = await import(pathToFileURL(path.join(WDIR, 'worker.js')).href);
  const G = await import(pathToFileURL(path.join(WDIR, 'core', 'gate.js')).href);

  console.log('\nWho may call');
  const e = env();
  ok('/health needs no key', (await j(await call(W, e, 'GET', '/health', null, null))).ok === true);
  ok('no key → 401 on the lab', (await call(W, e, 'GET', '/lab/runs', null, null)).status === 401);
  ok('another Orca key → 401', (await call(W, e, 'GET', '/lab/runs', null, 'orca_sk_someone_else_999')).status === 401);
  ok("Tony's key → the lab answers", (await j(await call(W, e, 'GET', '/lab/runs'))).ok === true);
  ok('the probe key opens the probes only, never the lab', (await call(W, e, 'GET', '/lab/runs', null, 'probe-secret')).status === 401 && (await call(W, e, 'GET', '/probe/d1', null, 'probe-secret')).status === 200);
  ok('no ALLOWED_KEYS set → nobody gets in', (await call(W, { ...e, ALLOWED_KEYS: '' }, 'GET', '/lab/runs')).status === 401);

  console.log('\nLab runs');
  const run = { id: 'run-2026-11-27-pre', session: 'premarket', day: '2026-11-27', model: 'claude-opus-5-5', started: 1, outcome: 'running' };
  ok('a run starts', (await j(await call(W, e, 'POST', '/lab/runs', run))).ok);
  ok('the same id completes it', (await j(await call(W, e, 'POST', '/lab/runs', { ...run, ended: 9, outcome: 'ok', summary: 'two specs passed', trials: 14, results: [{ id: 'a', pass: true }, { id: 'b', pass: false }] }))).ok);
  const runs = (await j(await call(W, e, 'GET', '/lab/runs?day=2026-11-27&session=premarket'))).runs;
  ok('one run, completed, results counted (not dumped)', runs.length === 1 && runs[0].outcome === 'ok' && runs[0].trials === 14 && runs[0].count === 2 && !runs[0].results);
  ok('&full=1 gives the results', (await j(await call(W, e, 'GET', '/lab/runs?full=1'))).runs[0].results.length === 2);
  for (const [b, why] of [[{ ...run, session: 'noon' }, 'session'], [{ ...run, day: '27/11' }, 'day'], [{ ...run, outcome: 'great' }, 'outcome'], [{ ...run, id: 'x' }, 'id']]) {
    ok(`a bad run is refused (${why})`, (await call(W, e, 'POST', '/lab/runs', b)).status === 400);
  }

  console.log('\nStrategies: the Gate runs again on receipt');
  const raw = { name: 'Semis VWAP trend', id: 'semis-vwap', version: 1, horizon: 'day', timeframe: '5m', side: 'long', universe: { symbols: ['NVDA', 'AMD'] },
    entry: { all: [{ ind: 'close', op: 'crossesAbove', than: { ind: 'vwap' } }] }, exit: { any: [{ stop: 'atr', value: 1.5 }, { target: 'r', value: 2 }] }, maxPositions: 3 };
  const clamped = G.clampSpec(raw, undefined, { today: '2026-11-27' }).spec;
  const post = (spec, gate = { pass: true, reasons: [] }) => call(W, e, 'POST', '/strategies', { id: spec.id, version: spec.version, spec, gate, edits: [], report: { trades: 40 }, run_id: run.id });
  const r1 = await j(await post(clamped));
  ok('a clamped spec that passed its gate is stored as gated', r1.ok && r1.stage === 'gated' && r1.hash.length === 8, JSON.stringify(r1));
  ok('posting the same version again is fine (same rules)', (await j(await post(clamped))).same === true);
  const changed = { ...clamped, exit: { any: [{ stop: 'atr', value: 2 }, { target: 'r', value: 2 }] } };
  const r2 = await j(await post(changed));
  ok('the same version with other rules is refused: publish version + 1', r2.status === 409 && /version 2/.test(r2.error), JSON.stringify(r2));
  ok('version 2 with the new rules is stored', (await j(await post({ ...changed, version: 2 }))).ok);
  const list = (await j(await call(W, e, 'GET', '/strategies'))).strategies;
  ok('/strategies lists the newest version of each', list.length === 1 && list[0].version === 2 && list[0].spec.exit.any[0].value === 2);
  const loose = await j(await post({ ...clamped, id: 'loose-one', version: 1, maxPositions: 9 }));
  ok('a spec outside the limits is refused on receipt, with the reason', loose.status === 422 && loose.reasons.some((x) => /maxPositions|positions/.test(x)), JSON.stringify(loose));
  const failed = await j(await post({ ...clamped, id: 'failed-gate', version: 1 }, { pass: false, reasons: ['22 trades'] }));
  ok('a spec whose gate failed is refused', failed.status === 422 && failed.reasons.includes('its gate did not pass'));
  ok('a spec with no stop is refused (the bot check)', (await j(await post({ ...clamped, id: 'no-stop', version: 1, exit: { any: [{ target: 'r', value: 2 }] } }))).status === 422);
  ok('id and version must match the spec', (await call(W, e, 'POST', '/strategies', { id: 'semis-vwap', version: 5, spec: clamped, gate: { pass: true } })).status === 400);

  console.log('\nResearch now');
  ok('nothing pending at first', (await j(await call(W, e, 'GET', '/research/request'))).request === null);
  const q1 = await j(await call(W, e, 'POST', '/research/request', { note: 'CPI tomorrow' }));
  ok('a request is stored', q1.ok && Number.isInteger(q1.id));
  ok('a second press while one waits is the same request', (await j(await call(W, e, 'POST', '/research/request', {}))).already === true);
  ok('the runner sees it', (await j(await call(W, e, 'GET', '/research/request'))).request.note === 'CPI tomorrow');
  ok('it is claimed once only', (await j(await call(W, e, 'POST', '/research/claim', { id: q1.id, run_id: 'r1' }))).claimed === true && (await j(await call(W, e, 'POST', '/research/claim', { id: q1.id, run_id: 'r2' }))).claimed === false);
  ok('then nothing is pending', (await j(await call(W, e, 'GET', '/research/request'))).request === null);

  console.log('\nOrder hosts (rule 2)');
  const src = fs.readFileSync(path.join(WDIR, 'worker.js'), 'utf8') + fs.readFileSync(path.join(WDIR, 'lib', 'alpaca.js'), 'utf8');
  const hosts = [...new Set((src.match(/https:\/\/[a-z0-9.-]+/g) || []))];
  ok('only Alpaca paper and data hosts, never a live trading host', hosts.every((h) => ['https://paper-api.alpaca.markets', 'https://data.alpaca.markets'].includes(h)) && !/api\.alpaca\.markets(?!\.)/.test(src.replace(/paper-api\.alpaca|data\.alpaca/g, '')), hosts.join(' '));
  ok('the public Worker API has no submit-order route', !/\/v2\/orders['"`]\s*,\s*\{\s*method:\s*['"]POST/.test(src) && !/method:\s*['"](POST|DELETE)['"][^\n]*alpaca/i.test(src));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
