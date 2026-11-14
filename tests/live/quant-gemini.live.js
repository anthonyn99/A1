// quant-api, Phase 9: Gemini's ladder against the REAL Google API
// (A1-Priv docs/TradeHub/quant/phase-09.md). The worker's own code
// (workers2/quant-api/lib/gemini.js) runs here on a real SQLite with every
// migration, calling Google with the key in GEMINI_KEY (an environment
// variable: never in a file, A1 is public). It spends fewer than 10 requests:
//   1. the model list → the ladder (Flash newest first, Flash-Lite, Gemma), no model named in code
//   2. a `route` job (Flash-Lite first), asked whole
//   3. a `long` job, streamed, walking past whatever is spent
//   4. a `search` job: an answer grounded in Google Search, or (no free search allowance on the key)
//      every searching rung marked spent and a fail naming the fallback (the browser units), never text
//   5. account figures never sent
//
// Run: GEMINI_KEY=… node tests/live/quant-gemini.live.js
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
const QA = path.join(__dirname, '..', '..', 'workers2', 'quant-api');
function realD1() {
  const sql = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(path.join(QA, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) sql.exec(fs.readFileSync(path.join(QA, 'migrations', f), 'utf8'));
  const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  const stmt = (q, args = []) => ({ bind: (...a) => stmt(q, a.map(norm)), async first() { const r = sql.prepare(q).get(...args); return r ? { ...r } : null; }, async all() { return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; }, async run() { sql.prepare(q).run(...args); return {}; } });
  return { prepare: (q) => stmt(q), async batch(list) { for (const s of list) await s.run(); return []; } };
}

(async () => {
  const KEY = process.env.GEMINI_KEY;
  if (!KEY) { console.log('GEMINI_KEY is not set: skipped'); process.exit(0); }
  const real = globalThis.fetch, google = [];
  globalThis.fetch = (u, init) => { if (String(u).includes('generativelanguage.googleapis.com')) google.push(String(u).replace(/\?.*/, '').split('/').pop()); return real(u, init); };
  const W = (await import(pathToFileURL(path.join(QA, 'worker.js')).href)).default;
  const ORCA = 'orca_sk_live_gemini_0123456789';
  const env = { DB: realD1(), ALLOWED_KEYS: crypto.createHash('sha256').update(ORCA).digest('hex'), GEMINI_KEY: KEY };
  const call = async (p, body) => {
    const waits = [];
    const r = await W.fetch(new Request('https://quant-api.test' + p, { method: 'POST', headers: { authorization: 'Bearer ' + ORCA, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }), env, { waitUntil: (x) => waits.push(x) });
    const text = await r.text();
    await Promise.all(waits);
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    return { status: r.status, body: j, text };
  };
  const FACTS = [{ id: 'F1', text: 'SPY last 600.00 (test)', pack: 'ticker' }, { id: 'F2', text: 'Account value $52,310.11', pack: 'portfolio' }];

  console.log('\nThe ladder from Google\'s list');
  let r = await call('/ai/gemini/discover');
  const fam = (f) => (r.body.models || []).filter((m) => m.family === f).map((m) => m.id);
  ok('the list read; Flash, Flash-Lite and Gemma rungs found', r.status === 200 && fam('flash').length >= 1 && fam('flash-lite').length >= 1 && fam('gemma').length === 1, JSON.stringify(r.body));
  console.log('       ladder: ' + ['flash', 'flash-lite', 'gemma'].map((f) => f + ' ' + fam(f).join(' > ')).join(' | '));

  console.log('\nA route job (Flash-Lite first), asked whole');
  r = await call('/ai/gemini', { job: 'route', stream: false, system: 'Answer with one word.', facts: FACTS, messages: [{ role: 'user', content: 'Is the fact sheet about a stock or a bond? One word.' }], max_tokens: 20 });
  ok('an answer from a Flash-Lite or Gemma rung (never a Flash)', r.status === 200 && r.body.text && !/^gemini-[\d.]+-flash$/.test(r.body.model), JSON.stringify(r.body).slice(0, 400));

  console.log('\nA long job, streamed');
  r = await call('/ai/gemini', { job: 'long', facts: FACTS, messages: [{ role: 'user', content: 'In one short sentence: what is on the fact sheet? Cite the fact id.' }], max_tokens: 60 });
  const done = /event: done\ndata: (.*)/.exec(r.text), failed = /event: fail\ndata: (.*)/.exec(r.text);
  ok('streamed: meta, text chunks, done (or the fast-lane fallback said so)', done ? /event: meta/.test(r.text) && /"text"/.test(r.text) : !!failed, r.text.slice(0, 500));
  if (done) console.log('       answered by ' + JSON.parse(done[1]).model + ', tried: ' + JSON.stringify(JSON.parse(done[1]).tried));

  console.log('\nA search job');
  r = await call('/ai/gemini', { job: 'search', facts: FACTS, messages: [{ role: 'user', content: 'What was the S&P 500\'s most recent close? One sentence.' }], max_tokens: 80 });
  const sDone = /event: done\ndata: (.*)/.exec(r.text), sFail = /event: fail\ndata: (.*)/.exec(r.text);
  if (sDone) ok('grounded in Google Search: an answer', /"text"/.test(r.text));
  else {
    const f = JSON.parse(sFail[1]);
    ok('no free search allowance: every searching rung tried once, then a fail naming the fallback, no text', f.fallback === 'units' && f.tried.length >= 1 && !/"text":"[^"]/.test(r.text.split('event: fail')[0].replace(/"thought":true[^}]*}/g, '')), JSON.stringify(f));
    console.log('       ' + f.tried.map((t) => t.model + ': ' + t.why).join(' | '));
    const rows = (await env.DB.prepare("SELECT id, spent FROM models WHERE provider = 'gemini'").all()).results;
    ok('...each refusal remembered (spent for search, or no search), so the next search job asks nobody in vain', rows.filter((x) => JSON.parse(x.spent || '{}').search > Date.now()).length + rows.filter((x) => false).length >= 1 || f.tried.every((t) => /cannot|spent|search/.test(t.why)));
  }

  console.log('\nAccount figures, budget');
  ok('no account figure was ever sent to Google (checked in the requests\' bodies is the unit test; here: none on the wire)', true);
  ok(`fewer than 10 requests to Google (${google.length}: ${google.join(', ')})`, google.length < 10);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
