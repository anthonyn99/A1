// quant-api, Phase 9 (A1-Priv docs/TradeHub/quant/phase-09.md): Neo Quant's
// fast lane (every provider failing in turn, a mid-stream cut, all failed, the
// order by measured latency, the eval bar, a retired model), Gemini's ladder
// (every status on every rung, the daily budget, a retired model, a capability
// a model lacks, every rung down per job, account figures left out), the model
// table, evals and briefs. The worker runs against a REAL SQLite (node:sqlite)
// with every migration applied, and fake providers.
//
// Run: node tests/quant-ai-api.test.js
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

function realD1() {
  const sql = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) sql.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a.map(norm)),
    async first() { const r = sql.prepare(q).get(...args); return r ? { ...r } : null; },
    async all() { return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = sql.prepare(q).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { sql, prepare: (q) => stmt(q), async batch(list) { sql.exec('BEGIN'); try { for (const s of list) await s.run(); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } return []; } };
}

/* ── fake providers ────────────────────────────────────────────────────────
   P.plan[host] = a list of answers, used in order (the last one repeats):
     { status, headers?, body? }            a plain answer
     { chunks: [...], cut?, hang? }         an SSE stream: strings sent one by one; cut = error after them; hang = never ends */
const P = { calls: [], plan: {}, bodies: [], reset() { this.calls.length = 0; this.bodies.length = 0; this.plan = {}; } };
const enc = new TextEncoder();
const oai = (t) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n';
const gem = (t, extra = {}) => 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: t }], role: 'model' }, ...extra }] }) + '\n\n';
const DONE = 'data: [DONE]\n\n';
function sse(a, signal) {
  return new Response(new ReadableStream({
    async start(c) {
      for (const x of a.chunks) { c.enqueue(enc.encode(x)); await new Promise((r) => setTimeout(r, 1)); }
      if (a.cut) { c.error(new Error('socket hang up')); return; }
      if (a.hang) { if (signal) signal.addEventListener('abort', () => { try { c.error(new Error('aborted')); } catch (e) {} }); return; }
      c.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const LIST = { models: [
  { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536 },
  { name: 'models/gemini-3.7-flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536 },
  { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3-flash-preview', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemma-4-26b-a4b-it', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemma-4-31b-it', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] },
] };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), host = new URL(u).host, m = /models\/([\w.-]+):/.exec(u);
  const key = m ? m[1] : u.endsWith('/models') || u.includes('/models?') || u.includes('/catalog/models') ? host + '/models' : host;
  P.calls.push(key);
  if (init.body) P.bodies.push({ key, body: String(init.body), auth: new Headers(init.headers || {}).get('authorization') || new Headers(init.headers || {}).get('x-goog-api-key') });
  const list = P.plan[key];
  if (!list || !list.length) return new Response('{"error":{"message":"unplanned ' + key + '"}}', { status: 500 });
  const a = list.length > 1 ? list.shift() : list[0];
  if (a.wait) await new Promise((r, no) => { const t = setTimeout(r, a.wait); if (init.signal) init.signal.addEventListener('abort', () => { clearTimeout(t); no(new Error('aborted')); }); });
  if (a.chunks) return sse(a, init.signal);
  return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body || {}), { status: a.status || 200, headers: { 'content-type': 'application/json', ...(a.headers || {}) } });
};
const GROQ = 'api.groq.com', CERE = 'api.cerebras.ai', OPENR = 'openrouter.ai', GOOGLE = 'generativelanguage.googleapis.com';
/** The named events and the text of a streamed answer. */
function readSse(text) {
  const events = [];
  let out = '';
  for (const block of text.split(/\n\n+/)) {
    const ev = /^event: (\w+)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
    if (!data || data[1] === '[DONE]') continue;
    let j; try { j = JSON.parse(data[1]); } catch (e) { continue; }
    if (ev) { events.push([ev[1], j]); if (ev[1] === 'reset') out = ''; continue; }
    const c = j.choices && j.choices[0], g = j.candidates && j.candidates[0];
    out += (c && c.delta && c.delta.content) || (g ? (g.content.parts || []).filter((x) => !x.thought).map((x) => x.text || '').join('') : '') || j.response || '';
  }
  return { events, text: out, ev: (n) => (events.find((e) => e[0] === n) || [])[1] };
}

(async () => {
  const W = (await import(pathToFileURL(path.join(QA, 'worker.js')).href)).default;
  const AI = await import(pathToFileURL(path.join(QA, 'lib', 'ai.js')).href), GM = await import(pathToFileURL(path.join(QA, 'lib', 'gemini.js')).href);
  const KEY = 'orca_sk_test_ai_0123456789abc';
  const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');
  const NOW = Date.now();
  const seed = (env, provider, id, o = {}) => env.DB.prepare('INSERT INTO models (provider, id, family, rank, caps, limits, spent, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(provider, id, o.family || 'chat', o.rank || 0, JSON.stringify(o.caps || {}), JSON.stringify(o.limits || {}), JSON.stringify(o.spent || {}), o.state || 'ok', o.at || NOW).run();
  const mkEnv = async (keys = { GROQ_KEY: 'gk', CEREBRAS_KEY: 'ck', OPENROUTER_KEY: 'ok' }, seeded = true) => {
    const env = { DB: realD1(), ALLOWED_KEYS: hash(KEY), ...keys };
    if (seeded) { await seed(env, 'groq', 'llama-3.3-70b-versatile'); await seed(env, 'cerebras', 'llama-3.3-70b'); await seed(env, 'openrouter', 'meta-llama/llama-3.3-70b-instruct:free'); }
    return env;
  };
  const call = async (env, p, { method = 'GET', body, key = KEY } = {}) => {
    const waits = [], ctx = { waitUntil: (x) => waits.push(x) };
    const r = await W.fetch(new Request('https://quant-api.test' + p, { method, headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
    const text = await r.text();
    await Promise.all(waits);
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    return { status: r.status, body: j, text, type: r.headers.get('content-type') || '', sse: readSse(text) };
  };
  const ASK = { system: 'You are Neo Quant.', facts: [{ id: 'F1', text: 'NVDA last 164.00 (Alpaca, DELAYED)', pack: 'ticker' }, { id: 'F2', text: 'Account value $52,310.11', pack: 'portfolio' }, { id: 'F3', text: 'Win rate 54%', private: true }], messages: [{ role: 'user', content: 'Is NVDA a buy?' }] };
  const usage = async (env) => Object.fromEntries(((await env.DB.prepare('SELECT service, n FROM usage').all()).results || []).map((r) => [r.service, r.n]));
  const health = async (env, p) => env.DB.prepare('SELECT * FROM provider_health WHERE provider = ?').bind(p).first();
  let env, r;

  console.log('\nThe prompt');
  let p = AI.buildPrompt(ASK);
  ok('facts go under the system text as [F1] lines', /^You are Neo Quant\.\n\nFACT SHEET\n\[F1\] NVDA last 164\.00.*\n\[F2\] Account value/.test(p.system) && p.messages.length === 1 && p.maxTokens === 700 && p.temperature === 0.2);
  p = AI.buildPrompt(ASK, { stripPrivate: true });
  ok('for Gemini: a private fact and every portfolio / journal fact are left out', /\[F1\]/.test(p.system) && !/52,310|Win rate/.test(p.system) && p.stripped === 2);
  const bad = (b) => { try { AI.buildPrompt(b); return 0; } catch (e) { return e.status; } };
  ok('a body without messages, with a system-role message, or ending on the assistant is refused', bad({}) === 400 && bad({ messages: [{ role: 'system', content: 'x' }] }) === 400 && bad({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }) === 400);
  ok('max_tokens is capped', AI.buildPrompt({ ...ASK, max_tokens: 99999 }).maxTokens === AI.MAX_TOKENS);

  console.log('\nThe fast lane');
  env = await mkEnv(); P.reset();
  P.plan[GROQ] = [{ chunks: [oai('WATCH: '), oai('the base needs volume [F1].'), DONE] }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('the first provider answers: a stream, its chunks passed through, meta then done', r.status === 200 && /event-stream/.test(r.type) && r.sse.text === 'WATCH: the base needs volume [F1].' && r.sse.ev('meta').provider === 'groq' && r.sse.ev('done').model === 'llama-3.3-70b-versatile' && r.sse.ev('done').firstMs >= 0, r.text);
  ok('...asked with its key, the model from the table, the facts in the system message', P.bodies[0].auth === 'Bearer gk' && JSON.parse(P.bodies[0].body).model === 'llama-3.3-70b-versatile' && JSON.parse(P.bodies[0].body).stream === true && /\[F2\] Account value/.test(JSON.parse(P.bodies[0].body).messages[0].content));
  ok('...counted in the ledger, its health and time to a first token kept', (await usage(env)).groq === 1 && (await health(env, 'groq')).ok === 1 && !!(await env.DB.prepare("SELECT v FROM meta WHERE k = 'lat:groq'").first()));
  ok('no Orca key: refused', (await call(env, '/ai/chat', { method: 'POST', body: ASK, key: null })).status === 401);

  env = await mkEnv(); P.reset();
  P.plan[GROQ] = [{ status: 500 }]; P.plan[CERE] = [{ chunks: [DONE] }]; P.plan[OPENR] = [{ chunks: [oai('NO TRADE.'), DONE] }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('every provider failing in turn: HTTP 500, then an empty stream, then the third answers', r.sse.text === 'NO TRADE.' && r.sse.ev('done').provider === 'openrouter' && JSON.stringify(r.sse.ev('done').tried.map((t) => [t.provider, t.why])) === '[["groq","HTTP 500"],["cerebras","the stream ended empty"]]', r.text);
  ok('...each failure in provider health', (await health(env, 'groq')).ok === 0 && (await health(env, 'cerebras')).detail === 'the stream ended empty');

  env = await mkEnv(); P.reset();
  P.plan[GROQ] = [{ chunks: [oai('GO: buy the '), oai('breakout')], cut: true }]; P.plan[CERE] = [{ chunks: [oai('WAIT.'), DONE] }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('a stream cut mid-way: a reset event, then the next provider; the half answer is not kept', r.sse.events.map((e) => e[0]).join() === 'meta,reset,meta,done' && r.sse.text === 'WAIT.' && r.sse.ev('done').tried[0].provider === 'groq', r.text);

  env = await mkEnv(); P.reset();
  P.plan[GROQ] = [{ status: 429, headers: { 'retry-after': '0' } }, { chunks: [oai('OK'), DONE] }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('a 429 with Retry-After ≤ 2 s: one retry, same provider', r.sse.text === 'OK' && r.sse.ev('done').provider === 'groq' && P.calls.filter((c) => c === GROQ).length === 2);
  P.reset(); P.plan[GROQ] = [{ status: 429, headers: { 'retry-after': '30' } }]; P.plan[CERE] = [{ chunks: [oai('OK2'), DONE] }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('a 429 asking for longer: the next provider at once', r.sse.text === 'OK2' && P.calls.filter((c) => c === GROQ).length === 1 && r.sse.ev('done').tried[0].why === 'HTTP 429');

  env = await mkEnv(); P.reset();
  AI.TIMING.firstSign = 60;
  P.plan[GROQ] = [{ wait: 5000, chunks: [oai('late'), DONE] }]; P.plan[CERE] = [{ chunks: [], hang: true }]; P.plan[OPENR] = [{ chunks: [oai('fast'), DONE] }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('no first token in time (a slow connection, a stream that says nothing): the next provider', r.sse.text === 'fast' && r.sse.ev('done').tried.length === 2 && r.sse.ev('done').tried.every((t) => /no first token/.test(t.why)), r.text);
  AI.TIMING.firstSign = 8000;

  env = await mkEnv(); P.reset();
  P.plan[GROQ] = [{ status: 503 }]; P.plan[CERE] = [{ status: 401 }]; P.plan[OPENR] = [{ chunks: ['data: {"error":{"message":"overloaded"}}\n\n'] }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('all failed: a fail event listing what was tried and why, no text', r.sse.text === '' && !r.sse.ev('done') && JSON.stringify(r.sse.ev('fail').tried.map((t) => t.why)) === '["HTTP 503","HTTP 401","overloaded"]', r.text);
  r = await call(env, '/ai/chat', { method: 'POST', body: { ...ASK, stream: false } });
  ok('...asked whole (the runner): 503 with the same list', r.status === 503 && r.body.tried.length === 3 && /no AI provider answered/.test(r.body.error));

  env = await mkEnv({}); P.reset();
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('no key set at all: said so, nobody called', r.sse.ev('fail').tried[0].why === 'no provider has a key set' && P.calls.length === 0);

  env = await mkEnv(); P.reset();
  await env.DB.prepare("INSERT INTO meta (k, v, at) VALUES ('lat:groq', '[900,950,1000]', 1), ('lat:cerebras', '[200,210,190]', 1)").run();
  P.plan[CERE] = [{ chunks: [oai('C'), DONE] }]; P.plan[GROQ] = [{ chunks: [oai('G'), DONE] }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('the fastest healthy provider goes first (the median of its last first-token times)', r.sse.ev('done').provider === 'cerebras' && P.calls[0] === CERE);
  r = await call(env, '/ai/chat', { method: 'POST', body: { ...ASK, provider: 'groq' } });
  ok('one provider asked for by name (the eval run)', r.sse.ev('done').provider === 'groq' && (await call(env, '/ai/chat', { method: 'POST', body: { ...ASK, provider: 'nope' } })).status === 400);

  r = await call(env, '/ai/evals', { method: 'POST', body: { provider: 'cerebras', model: 'llama-3.3-70b', n: 150, numeric: 0.82, verdict: 0.9, detail: { missed: ['q12'] } } });
  ok('an eval under the bar is stored and reported as not used', r.status === 200 && r.body.used === false);
  await call(env, '/ai/evals', { method: 'POST', body: { provider: 'groq', n: 150, numeric: 0.93, verdict: 0.88 } });
  P.reset(); P.plan[CERE] = [{ chunks: [oai('C'), DONE] }]; P.plan[GROQ] = [{ chunks: [oai('G'), DONE] }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('a provider under 85% numeric (or 80% verdict) is not used for answers, and never called', r.sse.ev('done').provider === 'groq' && !P.calls.includes(CERE) && /under the bar.*numeric 82%/.test(r.sse.ev('done').tried[0].why), r.text);
  r = await call(env, '/ai/chat', { method: 'POST', body: { ...ASK, provider: 'cerebras' } });
  ok('...but the eval run can still reach it by name', r.sse.ev('done').provider === 'cerebras');
  await new Promise((x) => setTimeout(x, 5));
  await call(env, '/ai/evals', { method: 'POST', body: { provider: 'cerebras', n: 150, numeric: 0.9, verdict: 0.85 } });
  P.reset(); P.plan[CERE] = [{ chunks: [oai('C'), DONE] }];
  ok('a newer eval over the bar puts it back', (await call(env, '/ai/chat', { method: 'POST', body: ASK })).sse.ev('done').provider === 'cerebras');
  r = await call(env, '/ai/evals');
  ok('GET /ai/evals: newest first, with the bar', r.body.evals.length === 3 && r.body.evals[0].provider === 'cerebras' && r.body.bar.numeric === 0.85 && r.body.bar.verdict === 0.8);
  ok('a bad eval is refused', (await call(env, '/ai/evals', { method: 'POST', body: { provider: 'x', n: 0, numeric: 2, verdict: 1 } })).status === 400);

  console.log('\nModels are read from the provider, not named');
  env = await mkEnv({ GROQ_KEY: 'gk' }, false); P.reset();
  P.plan[GROQ + '/models'] = [{ body: { data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-120b' }, { id: 'llama-3.3-70b-versatile' }, { id: 'llama-3.1-8b-instant' }] } }];
  P.plan[GROQ] = [{ chunks: [oai('hi'), DONE] }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  let rows = (await env.DB.prepare("SELECT id, rank FROM models WHERE provider = 'groq' ORDER BY rank").all()).results;
  ok('no model known: its /models list is read, the best matches kept in D1', r.sse.ev('done').model === 'llama-3.3-70b-versatile' && rows.map((x) => x.id).join() === 'llama-3.3-70b-versatile,openai/gpt-oss-120b' && (await usage(env)).groq === 2);
  P.reset(); P.plan[GROQ] = [{ chunks: [oai('hi'), DONE] }];
  await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('...and not read again while it is fresh', !P.calls.includes(GROQ + '/models'));
  P.reset(); P.plan[GROQ] = [{ status: 404, body: { error: { message: 'model not found' } } }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  rows = (await env.DB.prepare("SELECT id, state FROM models WHERE provider = 'groq' ORDER BY rank").all()).results;
  ok('a retired model (404): dropped, said so', /is gone/.test(r.sse.ev('fail').tried[0].why) && rows[0].state === 'dropped');
  P.reset(); P.plan[GROQ] = [{ chunks: [oai('again'), DONE] }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('...the next question uses the next one kept', r.sse.ev('done').model === 'openai/gpt-oss-120b');
  env = await mkEnv({ OPENROUTER_KEY: 'ok' }, false); P.reset();
  P.plan[OPENR + '/models'] = [{ body: { data: [{ id: 'openai/gpt-5' }, { id: 'qwen/qwen3:free' }, { id: 'meta-llama/llama-3.3-70b-instruct' }] } }];
  P.plan[OPENR] = [{ chunks: [oai('free'), DONE] }];
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('OpenRouter: only a :free model is ever picked', r.sse.ev('done').model === 'qwen/qwen3:free');
  env = await mkEnv({}, false); env.AI = { run: async (model, o) => (o.stream ? sse({ chunks: ['data: {"response":"from "}\n\n', 'data: {"response":"the edge"}\n\n', DONE] }).body : { response: 'whole' }) }; P.reset();
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('Workers AI through its binding (the last resort)', r.sse.text === 'from the edge' && r.sse.ev('done').provider === 'workersai' && (await call(env, '/ai/chat', { method: 'POST', body: { ...ASK, stream: false } })).body.text === 'whole');

  env = await mkEnv({ GROQ_KEY: 'gk' }); P.reset();
  await env.DB.prepare("INSERT INTO usage (day, service, n) VALUES (?, 'groq', ?)").bind(new Date().toISOString().slice(0, 10), AI.PROVIDERS.length && 800).run();
  r = await call(env, '/ai/chat', { method: 'POST', body: ASK });
  ok('a provider at its daily cap is skipped without a call', P.calls.length === 0 && /cap/.test(r.sse.ev('fail').tried[0].why));
  env = await mkEnv({ GROQ_KEY: 'gk' }); P.reset();
  P.plan[GROQ] = [{ body: { choices: [{ message: { content: ' Whole answer. ' } }] } }];
  r = await call(env, '/ai/chat', { method: 'POST', body: { ...ASK, stream: false } });
  ok('stream: false answers whole', r.status === 200 && r.body.text === 'Whole answer.' && r.body.provider === 'groq' && JSON.parse(P.bodies[0].body).stream === false);

  console.log('\nGemini: the ladder');
  const fam = GM.classify(LIST.models);
  ok('Google\'s list → the ladder: Flash newest first, Flash-Lite, the biggest Gemma; no tts, image, pro, alias or preview', fam.flash.map((m) => m.id).join() === 'gemini-3.8-flash,gemini-3.7-flash,gemini-2.5-flash' && fam['flash-lite'].map((m) => m.id).join() === 'gemini-3.5-flash-lite,gemini-3.1-flash-lite' && fam.gemma.map((m) => m.id).join() === 'gemma-4-31b-it', JSON.stringify(fam));
  ok('a preview only when nothing stable is listed', GM.classify([{ name: 'models/gemini-4-flash-preview', supportedGenerationMethods: ['generateContent'] }]).flash[0].id === 'gemini-4-flash-preview');
  const gemEnv = async () => { const e = await mkEnv({ GEMINI_KEY: 'AQ.test', GROQ_KEY: 'gk' }); P.reset(); P.plan[GOOGLE + '/models'] = [{ body: LIST }]; return e; };
  const G = (job, extra = {}) => ({ method: 'POST', body: { job, ...ASK, ...extra } });
  const mrow = async (e, id) => { const x = await e.DB.prepare("SELECT * FROM models WHERE provider = 'gemini' AND id = ?").bind(id).first(); return x && { ...x, caps: JSON.parse(x.caps), spent: JSON.parse(x.spent), limits: JSON.parse(x.limits) }; };
  env = await gemEnv();
  P.plan['gemini-3.8-flash'] = [{ chunks: [gem('The S&P closed at '), gem('6,012 [F1].', { finishReason: 'STOP' })] }];
  r = await call(env, '/ai/gemini', G('search'));
  ok('the first job reads the list, then the newest Flash answers, streamed', r.sse.text === 'The S&P closed at 6,012 [F1].' && r.sse.ev('done').model === 'gemini-3.8-flash' && P.calls[0] === GOOGLE + '/models', r.text);
  const sent = JSON.parse(P.bodies[0].body);
  ok('...grounded in Google Search, the key in a header, never in the URL', !!sent.tools[0].google_search && P.bodies[0].auth === 'AQ.test');
  ok('...and no account figure went to Google', !/52,310|Win rate/.test(P.bodies[0].body) && /\[F1\] NVDA/.test(sent.systemInstruction.parts[0].text) && r.sse.ev('done').stripped === 2);
  ok('...counted per model, the capability learned', (await usage(env))['gemini:gemini-3.8-flash'] === 1 && (await mrow(env, 'gemini-3.8-flash')).caps.search === true);
  ok('the ladder is in D1 with each family\'s budget; Gemma is known not to search', (await mrow(env, 'gemini-3.8-flash')).limits.rpd === GM.BUDGET.flash && (await mrow(env, 'gemma-4-31b-it')).caps.search === false && (await mrow(env, 'gemini-3.5-flash-lite')).family === 'flash-lite');
  ok('a job that is not one is refused; so is Gemini without its key', (await call(env, '/ai/gemini', G('poem'))).status === 400 && (await call(await mkEnv(), '/ai/gemini', G('long'))).status === 503);

  env = await gemEnv();
  P.plan['gemini-3.8-flash'] = [{ status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } } }];
  P.plan['gemini-3.7-flash'] = [{ status: 503 }, { status: 503 }];
  P.plan['gemini-2.5-flash'] = [{ status: 404 }];
  P.plan['gemini-3.5-flash-lite'] = [{ chunks: ['data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n'] }];
  P.plan['gemini-3.1-flash-lite'] = [{ chunks: [gem('', { finishReason: 'STOP' })] }];
  P.plan['gemma-4-31b-it'] = [{ chunks: ['data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }] } }] }) + '\n\n', gem('Long read done.', { finishReason: 'STOP' })] }];
  r = await call(env, '/ai/gemini', G('long'));
  const whys = r.sse.ev('done').tried.map((t) => t.model + ': ' + t.why);
  ok('every status down the ladder: 429, 5xx twice, 404, a safety block, an empty answer, then Gemma answers', r.sse.ev('done').model === 'gemma-4-31b-it' && r.sse.text === 'Long read done.' && whys.length === 5, JSON.stringify(whys));
  ok('...429 on its first request of the day: no free allowance, spent for a week', /no free allowance/.test(whys[0]) && (await mrow(env, 'gemini-3.8-flash')).spent.text > Date.now() + 6 * 86400000);
  ok('...5xx: one retry, then the next rung', P.calls.filter((c) => c === 'gemini-3.7-flash').length === 2);
  ok('...404: the model is dropped and the list read again', P.calls.filter((c) => c === GOOGLE + '/models').length === 2 && /gone/.test(whys[2]));
  ok('...a safety block and an empty answer each move on', /blocked: SAFETY/.test(whys[3]) && /empty/.test(whys[4]));
  P.calls.length = 0;
  P.plan['gemini-3.7-flash'] = [{ chunks: [gem('second rung', { finishReason: 'STOP' })] }];
  r = await call(env, '/ai/gemini', G('long'));
  ok('a spent model is skipped without a request', r.sse.ev('done').model === 'gemini-3.7-flash' && !P.calls.includes('gemini-3.8-flash') && /spent until/.test(r.sse.ev('done').tried[0].why));

  env = await gemEnv();
  await call(env, '/ai/gemini/discover', { method: 'POST' });
  await env.DB.prepare("INSERT INTO usage (day, service, n) VALUES (?, 'gemini:gemini-3.8-flash', 5)").bind(new Date().toISOString().slice(0, 10)).run();
  P.plan['gemini-3.8-flash'] = [{ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }];
  P.plan['gemini-3.7-flash'] = [{ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '21s' }] } } }];
  P.plan['gemini-2.5-flash'] = [{ chunks: [gem('ok', { finishReason: 'STOP' })] }];
  r = await call(env, '/ai/gemini', G('long'));
  const s1 = (await mrow(env, 'gemini-3.8-flash')).spent.text, s2 = (await mrow(env, 'gemini-3.7-flash')).spent.text;
  ok('429 after requests today: spent until the Pacific midnight reset', s1 > Date.now() && s1 <= Date.now() + 86400000 + 5000 && Math.abs(s1 - GM.nextPacificMidnight()) < 5000);
  ok('429 with a short retryDelay (the per-minute limit): spent for that long only', s2 > Date.now() + 15000 && s2 < Date.now() + 30000);
  await env.DB.prepare("UPDATE usage SET n = ? WHERE service = 'gemini:gemini-2.5-flash'").bind(GM.BUDGET.flash).run();
  P.calls.length = 0; P.plan['gemini-3.5-flash-lite'] = [{ chunks: [gem('lite', { finishReason: 'STOP' })] }];
  r = await call(env, '/ai/gemini', G('long'));
  ok('a model at its own daily budget is skipped without a request', r.sse.ev('done').model === 'gemini-3.5-flash-lite' && !P.calls.includes('gemini-2.5-flash') && /daily cap/.test(r.sse.ev('done').tried.find((t) => t.model === 'gemini-2.5-flash').why));

  env = await gemEnv();
  P.plan['gemini-3.8-flash'] = [{ status: 400, body: { error: { message: 'Search grounding is not supported for this model' } } }];
  for (const m of ['gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']) P.plan[m] = [{ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }];
  P.plan['gemma-4-31b-it'] = [{ chunks: [gem('should never be asked')] }];
  P.plan[GROQ] = [{ chunks: [oai('never for search'), DONE] }];
  r = await call(env, '/ai/gemini', G('search'));
  ok('search: a model that refuses the tool is remembered; Gemma (no search) is never asked', (await mrow(env, 'gemini-3.8-flash')).caps.search === false && !P.calls.includes('gemma-4-31b-it'));
  ok('search, every rung down: a fail event naming the fallback (the browser units, on a press), nothing made up', r.sse.text === '' && r.sse.ev('fail').fallback === 'units' && r.sse.ev('fail').tried.length === 6 && !P.calls.includes(GROQ), r.text);
  ok('...search being spent does not spend plain text on the same model', (await mrow(env, 'gemini-3.7-flash')).spent.search > Date.now() && !(await mrow(env, 'gemini-3.7-flash')).spent.text);
  P.plan['gemini-3.8-flash'] = [{ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }];
  r = await call(env, '/ai/gemini', G('long'));
  ok('long, every rung down: the fast lane answers instead (with every fact: it is not Gemini)', r.sse.text === 'never for search' && r.sse.ev('done').provider === 'groq' && /52,310/.test(P.bodies[P.bodies.length - 1].body), r.text);
  r = await call(env, '/ai/gemini', G('image', { images: [{ mime: 'image/png', data: 'iVBORw0KGgo=' }], stream: false }));
  ok('image, every rung down: 503 with the fallback', r.status === 503 && r.body.fallback === 'units');
  ok('a bad image is refused', (await call(env, '/ai/gemini', G('image', { images: [{ mime: 'text/html', data: 'x' }] }))).status === 400);

  env = await gemEnv();
  P.plan['gemini-3.5-flash-lite'] = [{ body: { candidates: [{ content: { parts: [{ text: 'hmm', thought: true }, { text: 'market' }] }, finishReason: 'STOP' }] } }];
  r = await call(env, '/ai/gemini', G('route', { stream: false }));
  ok('route: starts at Flash-Lite (never a Flash); thoughts are not part of the answer', r.body.text === 'market' && r.body.model === 'gemini-3.5-flash-lite' && !P.calls.some((c) => /^gemini-3\.[78]-flash$/.test(c)));
  P.plan['gemini-3.8-flash'] = [{ chunks: [gem('a chart', { finishReason: 'STOP' })] }];
  r = await call(env, '/ai/gemini', G('image', { images: [{ mime: 'image/png', data: 'iVBORw0KGgo=' }] }));
  ok('image: the picture rides with the last user message', r.sse.text === 'a chart' && JSON.parse(P.bodies[P.bodies.length - 1].body).contents[0].parts[1].inline_data.mime_type === 'image/png');
  AI.TIMING.geminiFirst = 60;
  P.plan['gemini-3.8-flash'] = [{ chunks: [], hang: true }]; P.plan['gemini-3.7-flash'] = [{ chunks: [gem('after a timeout', { finishReason: 'STOP' })] }];
  r = await call(env, '/ai/gemini', G('long'));
  ok('a timeout: one retry, then the next rung', r.sse.text === 'after a timeout' && P.calls.filter((c) => c === 'gemini-3.8-flash').length >= 3);
  AI.TIMING.geminiFirst = 15000;

  console.log('\nThe model table, briefs, the migration');
  r = await call(env, '/ai/models');
  ok('GET /ai/models: which keys are set, the ladder, the bar', r.body.keys.gemini === true && r.body.keys.groq === true && r.body.keys.cerebras === false && r.body.models.some((m) => m.provider === 'gemini' && m.family === 'gemma') && r.body.bar.numeric === 0.85);
  r = await call(env, '/usage');
  ok('/usage tells Control which AI keys are set', r.body.keys.gemini === true && r.body.keys.groq === true && r.body.keys.mistral === false);
  ok('no brief yet: null', (await call(env, '/brief?kind=daily')).body.brief === null);
  r = await call(env, '/brief', { method: 'POST', body: { day: '2026-11-13', kind: 'daily', body: { text: 'VERDICT: Constructive.', facts: ['F1'], model: 'llama', provider: 'groq' } } });
  await call(env, '/brief', { method: 'POST', body: { day: '2026-11-14', kind: 'daily', body: { text: 'VERDICT: Choppy.' } } });
  await call(env, '/brief', { method: 'POST', body: { day: '2026-11-14', kind: 'daily', body: { text: 'VERDICT: Choppy, second build.' } } });
  ok('a brief is kept per day and kind (a rebuild replaces it)', r.status === 200 && (await env.DB.prepare('SELECT COUNT(*) AS n FROM briefs').first()).n === 2);
  ok('GET /brief: the newest, or the newest up to a day', (await call(env, '/brief')).body.brief.text === 'VERDICT: Choppy, second build.' && (await call(env, '/brief?kind=daily&day=2026-11-13')).body.brief.provider === 'groq' && (await call(env, '/brief?kind=changed')).body.brief === null);
  ok('a brief without text, a bad day or kind is refused', (await call(env, '/brief', { method: 'POST', body: { day: '2026-11-14', kind: 'daily', body: {} } })).status === 400 && (await call(env, '/brief', { method: 'POST', body: { day: 'x', kind: 'daily', body: { text: 'a' } } })).status === 400 && (await call(env, '/brief?kind=weekly')).status === 400);
  const noAi = { DB: realD1(), ALLOWED_KEYS: hash(KEY), GROQ_KEY: 'gk' };
  noAi.DB.sql.exec('DROP TABLE models; DROP TABLE evals; DROP TABLE briefs');
  P.reset(); P.plan[GROQ] = [{ chunks: [oai('still answers'), DONE] }]; P.plan[GROQ + '/models'] = [{ status: 500 }];
  r = await call(noAi, '/ai/chat', { method: 'POST', body: ASK });
  ok('before migration 0009 the fast lane still answers (the fallback model), and briefs read as none', r.sse.text === 'still answers' && (await call(noAi, '/brief')).body.brief === null && (await call(noAi, '/ai/evals', { method: 'POST', body: { provider: 'groq', n: 1, numeric: 1, verdict: 1 } })).status === 503);
  const mig = fs.readFileSync(path.join(MIG, '0009_ai.sql'), 'utf8').replace(/--.*$/gm, '');
  ok('migration 0009 only adds', !/\b(DROP|ALTER|DELETE|UPDATE)\b/i.test(mig) && /CREATE TABLE IF NOT EXISTS models/.test(mig) && /CREATE TABLE IF NOT EXISTS evals/.test(mig) && /CREATE TABLE IF NOT EXISTS briefs/.test(mig));
  const src = ['ai.js', 'gemini.js'].map((f) => fs.readFileSync(path.join(QA, 'lib', f), 'utf8')).join('\n');
  ok('no Gemini model is named in the worker', !/gemini-\d|gemma-\d/.test(src.replace(/\/\/.*$/gm, '')));
  ok('the browser units (ORCA) are never called from the worker', !/orca\.vedapatel05|\/v1\/chat\/completions.*orca/i.test(src));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
