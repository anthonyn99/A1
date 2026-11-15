// quant-api, Phase 11 (A1-Priv docs/TradeHub/quant/phase-11.md, "Guarantees"):
// Neo Quant's "wanted" list, GET / POST / DELETE /wanted. One row per thing
// wanted (asking again counts it and keeps the newest words), newest first,
// capped; one row or all deleted; before migration 0011 is applied GET answers
// an empty list marked missing and a write answers 503; the Orca key required.
// A REAL SQLite D1 with every migration.
//
// Run: node tests/quant-wanted-api.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const QA = path.join(__dirname, '..', 'workers2', 'quant-api');
const MIG = path.join(QA, 'migrations');

function realD1({ skip = [] } = {}) {
  const sql = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql') && !skip.includes(x)).sort()) sql.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a.map(norm)),
    async first() { const r = sql.prepare(q).get(...args); return r ? { ...r } : null; },
    async all() { return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = sql.prepare(q).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { sql, prepare: (q) => stmt(q), async batch(list) { for (const s of list) await s.run(); return []; } };
}

(async () => {
  const W = (await import(pathToFileURL(path.join(QA, 'worker.js')).href)).default;
  const WA = await import(pathToFileURL(path.join(QA, 'lib', 'wanted.js')).href);
  const KEY = 'orca_sk_test_wanted_0123456789';
  const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');
  const call = async (env, method, p, body, { key = KEY } = {}) => {
    const r = await W.fetch(new Request('https://quant-api.test' + p, { method, headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
    let j = null; try { j = JSON.parse(await r.text()); } catch (e) {}
    return { status: r.status, body: j };
  };
  const env = { DB: realD1(), ALLOWED_KEYS: hash(KEY) };

  console.log('\n/wanted');
  let r = await call(env, 'GET', '/wanted');
  ok('an empty list to begin with', r.status === 200 && Array.isArray(r.body.wanted) && !r.body.wanted.length && !r.body.missing);
  r = await call(env, 'POST', '/wanted', { what: 'options chains', words: 'show me the options chain for NVDA', kind: 'control' });
  ok('an ask is stored', r.status === 200 && r.body.what === 'options chains');
  await new Promise((res) => setTimeout(res, 3));
  await call(env, 'POST', '/wanted', { what: 'crypto', words: 'trade bitcoin', kind: 'lab' });
  await new Promise((res) => setTimeout(res, 3));
  await call(env, 'POST', '/wanted', { what: 'options chains', words: 'options for AMD please', kind: 'control' });
  r = await call(env, 'GET', '/wanted');
  ok('asking again counts it and keeps the newest words; newest first', r.body.wanted.length === 2 && r.body.wanted[0].what === 'options chains' && r.body.wanted[0].count === 2 && r.body.wanted[0].words === 'options for AMD please' && r.body.wanted[1].kind === 'lab', JSON.stringify(r.body));
  r = await call(env, 'POST', '/wanted', { what: '   ', words: 'x' });
  ok('a blank "what" is refused', r.status === 400);
  r = await call(env, 'POST', '/wanted', { what: 'x'.repeat(500), words: 'y'.repeat(900), kind: 'weird' });
  const long = (await call(env, 'GET', '/wanted')).body.wanted.find((x) => x.what.startsWith('xxx'));
  ok('long text is clipped and an unknown kind becomes control', long && long.what.length === WA.WHAT_MAX && long.words.length === WA.WORDS_MAX && long.kind === 'control');
  for (let i = 0; i < WA.WANTED_MAX + 5; i++) await call(env, 'POST', '/wanted', { what: 'thing ' + i, words: 'w' });
  r = await call(env, 'GET', '/wanted');
  ok('kept small: at most ' + WA.WANTED_MAX + ' rows (the oldest go)', r.body.wanted.length === WA.WANTED_MAX && !r.body.wanted.some((x) => x.what === 'crypto'));
  r = await call(env, 'DELETE', '/wanted?what=' + encodeURIComponent('thing 50'));
  ok('one row deleted by its what', r.status === 200 && r.body.deleted === 1);
  r = await call(env, 'DELETE', '/wanted');
  ok('a DELETE that names nothing is refused (no accidental clear)', r.status === 400);
  r = await call(env, 'DELETE', '/wanted?confirm=clear');
  ok('confirm=clear empties it', r.status === 200 && !(await call(env, 'GET', '/wanted')).body.wanted.length);
  r = await call(env, 'GET', '/wanted', null, { key: '' });
  ok('the Orca key is required', r.status === 401 || r.status === 403, r.status);

  console.log('\nBefore the migration is applied');
  const env0 = { DB: realD1({ skip: ['0011_wanted.sql'] }), ALLOWED_KEYS: hash(KEY) };
  r = await call(env0, 'GET', '/wanted');
  ok('GET answers an empty list marked missing (the page keeps its own copy)', r.status === 200 && r.body.missing === true && !r.body.wanted.length);
  r = await call(env0, 'POST', '/wanted', { what: 'crypto', words: 'w' });
  ok('a write answers 503, naming the migration', r.status === 503 && /0011_wanted\.sql/.test(r.body.error), JSON.stringify(r.body));
  const sqlText = fs.readFileSync(path.join(MIG, '0011_wanted.sql'), 'utf8');
  ok('the migration only adds (CREATE … IF NOT EXISTS; no DROP, ALTER or DELETE)', /CREATE TABLE IF NOT EXISTS wanted/.test(sqlText) && !/\b(DROP|ALTER|DELETE)\b/i.test(sqlText.replace(/--.*$/gm, '')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
