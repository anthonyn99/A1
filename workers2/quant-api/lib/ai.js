// Neo Quant's fast lane (A1-Priv docs/TradeHub/quant/phase-09.md).
//
//   POST /ai/chat { system, facts, messages, max_tokens?, temperature?, stream?, provider? }
//        facts: [{ id: 'F1', text, private? }]   messages: [{ role: 'user'|'assistant', content }]
//        Streams (lib/sse.js) unless stream is false, which answers { ok, text, provider, model, tried }.
//   GET  /ai/models        the model table, the providers with a key, the last eval of each
//   GET  /ai/evals         the graded question set's scores, newest first
//   POST /ai/evals { provider, model, n, numeric, verdict, detail? }
//
// The worker calls the free API providers itself, OpenAI-shaped, with keys held
// as secrets, fastest healthy one first (the median of its last times to a
// first token). Per provider: 8 s to a first sign of life, one retry on a 429
// whose Retry-After is at most 2 s, then the next. A stream that ends empty or
// is cut mid-way is a failed provider and the chain moves on. Each call passes
// the ledger. Every provider failing is said so (`fail`, with what was tried):
// never a made-up answer.
//
// A provider's model is not fixed here: its /models list is read (at most once
// a week, or when its model is refused) and the first match of `prefer` kept in
// D1 `models`; `model` is only what is asked for when that list cannot be read.
import { fail, json } from './http.js';
import { bodyOf } from './charts.js';
import { Ledger, median } from './ledger.js';
import { sseEvent, sseResponse, peek, pipeRest } from './sse.js';

const DAY = 86_400_000;
export const FIRST_SIGN_MS = 8000, FIRST_TEXT_MS = 25_000, STREAM_MS = 60_000, ONCE_MS = 30_000;
export const BODY_MAX = 80_000, MAX_TOKENS = 1500, MODELS_TTL = 7 * DAY, FACTS_MAX = 200;
// A provider under either bar on the graded question set is not used for answers.
export const EVAL_BAR = { numeric: 0.85, verdict: 0.80 };
// Fact packs that hold account figures: never sent to Gemini, whatever the page says.
export const PRIVATE_PACKS = new Set(['portfolio', 'journal']);

export const PROVIDERS = [
  { id: 'groq', key: 'GROQ_KEY', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', prefer: [/^llama-3\.3-70b-versatile$/, /^openai\/gpt-oss-120b$/, /^meta-llama\/llama-4.*$/, /llama.*70b/, /gpt-oss/] },
  { id: 'cerebras', key: 'CEREBRAS_KEY', base: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b', prefer: [/^llama-?3\.3-70b$/, /^gpt-oss-120b$/, /llama.*70b/, /qwen/] },
  { id: 'openrouter', key: 'OPENROUTER_KEY', base: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', only: /:free$/, prefer: [/llama-3\.3-70b-instruct:free$/, /gpt-oss-120b:free$/, /deepseek.*:free$/, /:free$/] },
  { id: 'mistral', key: 'MISTRAL_KEY', base: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', prefer: [/^mistral-medium-latest$/, /^mistral-small-latest$/] },
  { id: 'github', key: 'GITHUB_MODELS_KEY', base: 'https://models.github.ai/inference', list: 'https://models.github.ai/catalog/models', model: 'openai/gpt-4o-mini', prefer: [/^openai\/gpt-4\.1-mini$/, /^openai\/gpt-4o-mini$/, /^meta\/.*llama-3\.3-70b/i] },
  { id: 'nvidia', key: 'NVIDIA_KEY', base: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.3-70b-instruct', prefer: [/^meta\/llama-3\.3-70b-instruct$/, /^openai\/gpt-oss-120b$/] },
  // Workers AI through its binding (wrangler.toml [ai]); no key, a small free daily allowance.
  { id: 'workersai', binding: 'AI', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', prefer: [] },
];
const has = (env, P) => (P.binding ? !!env[P.binding] : !!env[P.key]);
export const keysSet = (env) => Object.fromEntries(PROVIDERS.map((P) => [P.id, has(env, P)]));

const noTable = (e) => /no such table/i.test(String((e && e.message) || e));
const batch = (env, stmts) => (env.DB.batch ? env.DB.batch(stmts) : (async () => { for (const s of stmts) await s.run(); })());
const openaiText = (j) => { const c = j && j.choices && j.choices[0]; return (c && c.delta && c.delta.content) || ''; };
const workersText = (j) => (j && typeof j.response === 'string' ? j.response : '');
const errorOf = (j) => (j && j.error ? String(j.error.message || j.error.code || j.error).slice(0, 160) : '');

/* ── the prompt ──────────────────────────────────────────────────────────── */
/**
 * The request as chat messages. Facts go under the system text as `[F3] text`
 * lines. `stripPrivate` leaves out the facts that hold account figures.
 */
export function buildPrompt(b, { stripPrivate = false } = {}) {
  if (!b || typeof b !== 'object') throw fail(400, 'a JSON body is needed');
  const msgs = Array.isArray(b.messages) ? b.messages : [];
  if (!msgs.length) throw fail(400, 'messages is needed');
  if (msgs.length > 40) throw fail(400, 'at most 40 messages');
  const messages = msgs.map((m) => {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) throw fail(400, 'each message needs role (user or assistant) and content');
    return { role: m.role, content: m.content };
  });
  if (messages[messages.length - 1].role !== 'user') throw fail(400, 'the last message must be the user\'s');
  const all = Array.isArray(b.facts) ? b.facts.slice(0, FACTS_MAX) : [];
  const facts = all.filter((f) => f && typeof f.text === 'string' && /^F\d{1,4}$/.test(String(f.id)) && !(stripPrivate && (f.private || PRIVATE_PACKS.has(f.pack))));
  let system = String(b.system || '').trim();
  if (facts.length) system += (system ? '\n\n' : '') + 'FACT SHEET\n' + facts.map((f) => `[${f.id}] ${f.text}`).join('\n');
  else if (all.length) system += (system ? '\n\n' : '') + 'FACT SHEET\n(no facts may be shared with this model)';
  return {
    system, messages, stripped: all.length - facts.length,
    maxTokens: Math.max(16, Math.min(MAX_TOKENS, Number(b.max_tokens) || 700)),
    temperature: Number.isFinite(Number(b.temperature)) ? Math.max(0, Math.min(1, Number(b.temperature))) : 0.2,
  };
}
const openaiBody = (p, model, stream) => JSON.stringify({ model, stream, max_tokens: p.maxTokens, temperature: p.temperature,
  messages: [...(p.system ? [{ role: 'system', content: p.system }] : []), ...p.messages] });

/* ── which model, which order ────────────────────────────────────────────── */
export async function modelRows(env) {
  try { return (await env.DB.prepare('SELECT * FROM models ORDER BY provider, rank').all()).results || []; }
  catch (e) { if (noTable(e)) return []; throw e; }
}
/** The providers whose newest eval is under the bar: { provider: 'numeric 82%' }. */
export async function failedEvals(env) {
  let rows;
  try { rows = (await env.DB.prepare('SELECT e.* FROM evals e JOIN (SELECT provider, MAX(at) AS at FROM evals GROUP BY provider) m ON m.provider = e.provider AND m.at = e.at').all()).results || []; }
  catch (e) { if (noTable(e)) return {}; throw e; }
  const out = {};
  for (const r of rows) {
    const why = [];
    if (r.numeric < EVAL_BAR.numeric) why.push('numeric ' + Math.round(r.numeric * 100) + '%');
    if (r.verdict < EVAL_BAR.verdict) why.push('verdict ' + Math.round(r.verdict * 100) + '%');
    if (why.length) out[r.provider] = 'under the bar on the question set (' + why.join(', ') + ')';
  }
  return out;
}
/** The providers to try, fastest measured first; never-measured ones after, in the table's order. */
export function order(env, L, forced = null) {
  const list = PROVIDERS.filter((P) => has(env, P) && (!forced || P.id === forced));
  const at = (P) => { const m = median(L.lat[P.id]); return m == null ? 1e9 + PROVIDERS.indexOf(P) : m; };
  return list.sort((a, b) => at(a) - at(b));
}
/** Read a provider's model list and keep its best three in D1 → their ids, best first ([] when it has no list). */
export async function discover(env, L, P, now = Date.now()) {
  if (!P.base || !P.prefer.length) return [];
  if (!L.spend(P.id)) return [];
  let ids = [];
  try {
    const r = await fetch(P.list || P.base + '/models', { headers: { authorization: 'Bearer ' + env[P.key] }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return [];
    const j = await r.json();
    ids = (Array.isArray(j) ? j : j.data || []).map((m) => String((m && m.id) || '')).filter(Boolean);
  } catch (e) { return []; }
  if (P.only) ids = ids.filter((id) => P.only.test(id));
  const ranked = [];
  for (const re of P.prefer) for (const id of ids.filter((x) => re.test(x)).sort()) if (!ranked.includes(id)) ranked.push(id);
  const top = ranked.slice(0, 3);
  if (top.length) {
    try {
      await batch(env, [env.DB.prepare('DELETE FROM models WHERE provider = ?').bind(P.id),
        ...top.map((id, i) => env.DB.prepare("INSERT INTO models (provider, id, family, rank, caps, limits, spent, state, at) VALUES (?, ?, 'chat', ?, NULL, NULL, NULL, 'ok', ?)").bind(P.id, id, i, now))]);
    } catch (e) { if (!noTable(e)) console.warn('models:', e.message || e); }
  }
  return top;
}
async function modelFor(env, L, P, rows, now) {
  const mine = rows.filter((r) => r.provider === P.id && r.state === 'ok').sort((a, b) => a.rank - b.rank);
  if (mine.length && now - mine[0].at < MODELS_TTL) return mine[0].id;
  const found = await discover(env, L, P, now);
  return found[0] || (mine[0] && mine[0].id) || P.model;
}
async function dropModel(env, P, model) {
  try { await env.DB.prepare("UPDATE models SET state = 'dropped' WHERE provider = ? AND id = ?").bind(P.id, model).run(); } catch (e) {}
}

/* ── one provider ────────────────────────────────────────────────────────── */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Ask `P` → a fetch-like answer { ok, status, body, json(), text() }. One retry on a 429 with Retry-After ≤ 2 s. */
async function send(env, P, model, p, stream, signal) {
  if (P.binding) {
    const out = await env[P.binding].run(model, { messages: [...(p.system ? [{ role: 'system', content: p.system }] : []), ...p.messages], stream, max_tokens: p.maxTokens, temperature: p.temperature });
    return stream ? { ok: true, status: 200, body: out } : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: (out && out.response) || '' } }] }) };
  }
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(P.base + '/chat/completions', { method: 'POST', signal, headers: { authorization: 'Bearer ' + env[P.key], 'content-type': 'application/json' }, body: openaiBody(p, model, stream) });
    if (r.status !== 429 || attempt) return r;
    const ra = Number(r.headers.get('retry-after'));
    if (!(ra >= 0 && ra <= 2)) return r;
    await wait(ra * 1000);
  }
}
async function refusal(env, P, model, r) {
  let t = '';
  try { t = (await r.text()).slice(0, 300); } catch (e) {}
  // A model the provider no longer serves: forget it, so the next question reads the list again.
  if (r.status === 404 || (r.status === 400 && /model/i.test(t) && /(not found|does not exist|decommission|deprecat|unknown)/i.test(t))) { await dropModel(env, P, model); return { status: r.status, why: 'model ' + model + ' is gone (HTTP ' + r.status + ')' }; }
  return { status: r.status, why: 'HTTP ' + r.status };
}
/** One provider, streamed to `write` → { ok, firstMs, ms } or { ok: false, why }. */
async function tryStream(env, L, P, model, p, write) {
  const blocked = L.blocked(P.id);
  if (blocked) return { ok: false, why: blocked };
  if (!L.spend(P.id)) return { ok: false, why: 'at its daily cap' };
  const t0 = Date.now(), ac = new AbortController();
  let why = '', status = null, timer = null;
  const arm = (ms, msg) => { clearTimeout(timer); timer = setTimeout(() => { why = msg; ac.abort(); }, ms); };
  try {
    arm(FIRST_SIGN_MS, 'no first token in ' + FIRST_SIGN_MS / 1000 + ' s');
    const r = await send(env, P, model, p, true, ac.signal);
    status = r.status;
    if (!r.ok) { const x = await refusal(env, P, model, r); throw new Error(x.why); }
    const pk = await peek(r.body, { textOf: P.binding ? workersText : openaiText, badOf: errorOf, onAlive: () => arm(FIRST_TEXT_MS, 'no text in ' + FIRST_TEXT_MS / 1000 + ' s') });
    if (!pk.ok) throw new Error(why || pk.why);
    const firstMs = Date.now() - t0;
    arm(STREAM_MS, 'the answer ran past ' + STREAM_MS / 1000 + ' s');
    await write(sseEvent('meta', { provider: P.id, model }));
    for (const c of pk.head) await write(c);
    const cut = await pipeRest(pk.reader, write);
    if (cut) {
      L.note(P.id, false, status, null, 'cut mid-stream: ' + (why || cut));
      await write(sseEvent('reset', { provider: P.id, why: why || 'the stream was cut' }));
      return { ok: false, why: why || 'the stream was cut mid-way' };
    }
    L.note(P.id, true, status, firstMs);
    return { ok: true, firstMs, ms: Date.now() - t0 };
  } catch (e) {
    const msg = why || (e && e.message) || String(e);
    L.note(P.id, false, status, null, msg);
    return { ok: false, why: msg };
  } finally { clearTimeout(timer); }
}
/** One provider, the whole answer at once → { ok, text } or { ok: false, why }. */
async function tryOnce(env, L, P, model, p) {
  const blocked = L.blocked(P.id);
  if (blocked) return { ok: false, why: blocked };
  if (!L.spend(P.id)) return { ok: false, why: 'at its daily cap' };
  const t0 = Date.now();
  let status = null;
  try {
    const r = await send(env, P, model, p, false, AbortSignal.timeout(ONCE_MS));
    status = r.status;
    if (!r.ok) { const x = await refusal(env, P, model, r); throw new Error(x.why); }
    const j = await r.json(), c = j && j.choices && j.choices[0];
    const text = String((c && c.message && c.message.content) || '').trim();
    if (!text) throw new Error('an empty answer');
    L.note(P.id, true, status, Date.now() - t0);
    return { ok: true, text };
  } catch (e) {
    const msg = e && e.name === 'TimeoutError' ? 'timed out after ' + ONCE_MS / 1000 + ' s' : (e && e.message) || String(e);
    L.note(P.id, false, status, null, msg);
    return { ok: false, why: msg };
  }
}

/* ── the chain ───────────────────────────────────────────────────────────── */
/**
 * The fast lane over prompt `p` → streams to `write` and resolves
 * { ok, provider, model, tried } (stream), or { ok, text, … } (write = null).
 */
export async function runChain(env, L, p, { write = null, forced = null, now = Date.now() } = {}) {
  const [rows, bad] = await Promise.all([modelRows(env), failedEvals(env)]);
  const tried = [];
  for (const P of order(env, L, forced)) {
    // A provider under the bar is left out of answers; asking for it by name (the eval run itself) still reaches it.
    if (bad[P.id] && !forced) { tried.push({ provider: P.id, why: bad[P.id] }); continue; }
    const model = await modelFor(env, L, P, rows, now);
    const r = write ? await tryStream(env, L, P, model, p, write) : await tryOnce(env, L, P, model, p);
    if (r.ok) return { ok: true, provider: P.id, model, tried, ...r };
    tried.push({ provider: P.id, model, why: r.why });
  }
  if (!tried.length) tried.push({ provider: forced || 'fast lane', why: forced ? 'no key is set for it' : 'no provider has a key set' });
  return { ok: false, tried };
}
export async function chat(env, req, ctx) {
  const b = await bodyOf(req, BODY_MAX), p = buildPrompt(b);
  const forced = b.provider ? String(b.provider) : null;
  if (forced && !PROVIDERS.some((P) => P.id === forced)) throw fail(400, 'no such provider: ' + forced.slice(0, 20));
  const L = await Ledger.load(env);
  if (b.stream === false) {
    let r;
    try { r = await runChain(env, L, p, { forced }); } finally { await L.flush(); }
    if (!r.ok) throw fail(503, 'no AI provider answered', { tried: r.tried });
    return json({ ok: true, text: r.text, provider: r.provider, model: r.model, tried: r.tried });
  }
  return sseResponse(ctx, async (write) => {
    const r = await runChain(env, L, p, { write, forced });
    await write(r.ok ? sseEvent('done', { provider: r.provider, model: r.model, firstMs: r.firstMs, ms: r.ms, tried: r.tried }) : sseEvent('fail', { tried: r.tried }));
  }, () => L.flush());
}

/* ── the table, the evals ────────────────────────────────────────────────── */
export async function getModels(env) {
  const rows = await modelRows(env), parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
  let evals = [];
  try { evals = (await env.DB.prepare('SELECT e.* FROM evals e JOIN (SELECT provider, MAX(at) AS at FROM evals GROUP BY provider) m ON m.provider = e.provider AND m.at = e.at').all()).results || []; } catch (e) { if (!noTable(e)) throw e; }
  return json({ ok: true, keys: { ...keysSet(env), gemini: !!env.GEMINI_KEY }, bar: EVAL_BAR, evals,
    models: rows.map((r) => ({ provider: r.provider, id: r.id, family: r.family, rank: r.rank, caps: parse(r.caps), limits: parse(r.limits), spent: parse(r.spent), state: r.state, at: r.at })) });
}
export async function getEvals(env, url) {
  const n = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
  let rows = [];
  try { rows = (await env.DB.prepare('SELECT * FROM evals ORDER BY at DESC, id DESC LIMIT ?').bind(n).all()).results || []; } catch (e) { if (!noTable(e)) throw e; }
  return json({ ok: true, evals: rows, bar: EVAL_BAR });
}
export async function postEval(env, req) {
  const b = await bodyOf(req, 20_000);
  const frac = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1 ? Number(v) : NaN);
  const numeric = frac(b && b.numeric), verdict = frac(b && b.verdict), n = Math.round(Number(b && b.n));
  if (!b || !b.provider || !(n > 0) || Number.isNaN(numeric) || Number.isNaN(verdict)) throw fail(400, 'provider, n, numeric (0 to 1) and verdict (0 to 1) are needed');
  try {
    await env.DB.prepare('INSERT INTO evals (at, provider, model, n, numeric, verdict, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(Date.now(), String(b.provider).slice(0, 40), b.model ? String(b.model).slice(0, 80) : null, n, numeric, verdict, b.detail ? JSON.stringify(b.detail).slice(0, 4000) : null).run();
  } catch (e) { if (noTable(e)) throw fail(503, 'the AI tables are not there yet (D1 migration 0009_ai.sql)'); throw e; }
  return json({ ok: true, used: numeric >= EVAL_BAR.numeric && verdict >= EVAL_BAR.verdict });
}
