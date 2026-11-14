// Gemini, Neo Quant's specialist (A1-Priv docs/TradeHub/quant/phase-09.md).
//
//   POST /ai/gemini { job, system, facts, messages, images?, max_tokens?, stream? }
//        job: search (grounded in Google Search) | image | long (the weekly read)
//             | hear (audio, Phase 10's fallback) | route (small jobs, Flash-Lite first)
//   POST /ai/gemini/discover     read Google's model list again
//
// No model is named here. `discover` reads GET /v1beta/models and keeps the
// ladder in D1 `models`: the newest Flash, the Flashes before it, the Flash-
// Lites, the newest Gemma. A job walks it, skipping a model that lacks what
// the job needs (a capability is learned the first time it is refused):
//   429 / quota      that model is spent for that kind of request until the
//                    Pacific midnight reset (a week, when it refused the very
//                    first request of its day: it has no free allowance), next
//   5xx / timeout    one retry, then next
//   404              the model is dropped and the list is read again
//   a safety block, an empty answer   next
// Each model has its own daily budget (`limits.rpd`, counted in the ledger as
// gemini:<model>). Every rung out: `long` and `route` fall back to the fast
// lane; `search`, `image` and `hear` say so (their fallbacks are the page's:
// the browser units on a press, Phase 10's hearing chain).
//
// Account figures never reach Gemini: facts marked private, and every fact of
// the portfolio and journal packs, are left out of the request (buildPrompt).
import { fail, json } from './http.js';
import { bodyOf } from './charts.js';
import { Ledger } from './ledger.js';
import { sseEvent, sseResponse, peek, pipeRest } from './sse.js';
import { buildPrompt, runChain, BODY_MAX } from './ai.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const DAY = 86_400_000;
export const JOBS = { search: { need: 'search', from: 'flash' }, image: { need: 'image', from: 'flash' }, long: { need: null, from: 'flash' }, hear: { need: 'audio', from: 'flash' }, route: { need: null, from: 'flash-lite' } };
// Daily requests a model may take until Google's own number is known (a 429 always ends its day anyway).
export const BUDGET = { flash: 100, 'flash-lite': 200, gemma: 500 };
export const LADDER_KEEP = { flash: 4, 'flash-lite': 2, gemma: 1 };
export const GEMINI_FIRST_MS = 15_000, GEMINI_STREAM_MS = 90_000, IMAGE_MAX = 4_000_000, DISCOVER_TTL = 7 * DAY, NO_ALLOWANCE_MS = 7 * DAY;
const FALLBACK = { long: 'fast', route: 'fast', search: 'units', image: 'units', hear: 'hearing' };

const noTable = (e) => /no such table/i.test(String((e && e.message) || e));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const batch = (env, stmts) => (env.DB.batch ? env.DB.batch(stmts) : (async () => { for (const s of stmts) await s.run(); })());
const service = (id) => 'gemini:' + id;

/** When Google's daily quota next resets: midnight in Los Angeles. */
export function nextPacificMidnight(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now)).map((x) => [x.type, Number(x.value)]));
  return now + (86_400 - (p.hour * 3600 + p.minute * 60 + p.second)) * 1000;
}

/* ── discovery ───────────────────────────────────────────────────────────── */
const VER = (s) => s.split('.').map(Number);
const newer = (a, b) => { const x = VER(a.ver), y = VER(b.ver); return (y[0] - x[0]) || ((y[1] || 0) - (x[1] || 0)) || (b.size || 0) - (a.size || 0); };
/** Google's list → the ladder's models, best first within each family. */
export function classify(models) {
  const out = { flash: [], 'flash-lite': [], gemma: [] }, preview = { flash: [], 'flash-lite': [] };
  for (const m of models || []) {
    if (!m || !(m.supportedGenerationMethods || []).includes('generateContent')) continue;
    const id = String(m.name || '').replace(/^models\//, ''), base = { id, in: m.inputTokenLimit || null, out: m.outputTokenLimit || null };
    let x;
    if ((x = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?(-preview)?$/.exec(id))) (x[3] ? preview : out)[x[2] ? 'flash-lite' : 'flash'].push({ ...base, ver: x[1] });
    else if ((x = /^gemma-(\d+)[a-z]?-(\d+)b(?:-[a-z0-9]+)*-it$/.exec(id))) out.gemma.push({ ...base, ver: x[1], size: Number(x[2]) });
  }
  for (const f of ['flash', 'flash-lite']) if (!out[f].length) out[f] = preview[f];   // a preview only when nothing stable is listed
  for (const f of Object.keys(out)) out[f] = out[f].sort(newer).slice(0, LADDER_KEEP[f]);
  return out;
}
/** Read the list and write the ladder; what a model taught us (caps, spent) is kept. */
export async function discover(env, now = Date.now()) {
  if (!env.GEMINI_KEY) throw fail(503, 'GEMINI_KEY is not set');
  const r = await fetch(API + '/models?pageSize=1000', { headers: { 'x-goog-api-key': env.GEMINI_KEY }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw fail(502, 'Google\'s model list answered HTTP ' + r.status);
  const fam = classify((await r.json()).models);
  const old = new Map((await rowsOf(env)).map((x) => [x.id, x]));
  const stmts = [env.DB.prepare("DELETE FROM models WHERE provider = 'gemini'")];
  const rows = [];
  for (const [family, list] of Object.entries(fam)) list.forEach((m, rank) => {
    const was = old.get(m.id), caps = was ? was.caps : { search: family === 'gemma' ? false : null, image: null, audio: null };
    const limits = { rpd: (was && was.limits && was.limits.rpd) || BUDGET[family], in: m.in, out: m.out };
    rows.push({ id: m.id, family, rank, caps, limits, spent: was ? was.spent : {}, state: 'ok', at: now });
    stmts.push(env.DB.prepare("INSERT INTO models (provider, id, family, rank, caps, limits, spent, state, at) VALUES ('gemini', ?, ?, ?, ?, ?, ?, 'ok', ?)")
      .bind(m.id, family, rank, JSON.stringify(caps), JSON.stringify(limits), JSON.stringify(was ? was.spent : {}), now));
  });
  if (!rows.length) throw fail(502, 'Google lists no Flash, Flash-Lite or Gemma model');
  await batch(env, stmts);
  return rows;
}
async function rowsOf(env) {
  let rows;
  try { rows = (await env.DB.prepare("SELECT * FROM models WHERE provider = 'gemini' ORDER BY rank").all()).results || []; }
  catch (e) { if (noTable(e)) throw fail(503, 'the AI tables are not there yet (D1 migration 0009_ai.sql)'); throw e; }
  return rows.map((r) => ({ id: r.id, family: r.family, rank: r.rank, caps: parse(r.caps, {}), limits: parse(r.limits, {}), spent: parse(r.spent, {}), state: r.state, at: r.at }));
}
/** The rungs a job walks, in order: Flash (newest first), Flash-Lite, Gemma; `route` starts at Flash-Lite. */
export function ladder(rows, job) {
  const J = JOBS[job], fams = J.from === 'flash-lite' ? ['flash-lite', 'gemma'] : ['flash', 'flash-lite', 'gemma'];
  return fams.flatMap((f) => rows.filter((r) => r.family === f && r.state === 'ok').sort((a, b) => a.rank - b.rank));
}

/* ── the request ─────────────────────────────────────────────────────────── */
function geminiBody(p, job, images) {
  const contents = p.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  if (images.length) contents[contents.length - 1].parts.push(...images.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } })));
  return JSON.stringify({
    ...(p.system ? { systemInstruction: { parts: [{ text: p.system }] } } : {}),
    contents,
    ...(job === 'search' ? { tools: [{ google_search: {} }] } : {}),
    // Thinking counts against the output, so the ceiling is well above what the answer needs.
    generationConfig: { maxOutputTokens: p.maxTokens + 2048, temperature: p.temperature },
  });
}
const partsText = (j) => { const c = j && j.candidates && j.candidates[0]; return ((c && c.content && c.content.parts) || []).filter((x) => x && !x.thought && typeof x.text === 'string').map((x) => x.text).join(''); };
function blockOf(j) {
  if (j && j.error) return String(j.error.message || j.error.status || 'error').slice(0, 160);
  if (j && j.promptFeedback && j.promptFeedback.blockReason) return 'blocked: ' + j.promptFeedback.blockReason;
  const c = j && j.candidates && j.candidates[0], fr = c && c.finishReason;
  if (fr && !/^(STOP|MAX_TOKENS|FINISH_REASON_UNSPECIFIED)$/.test(fr) && !partsText(j)) return 'blocked: ' + fr;
  return '';
}
function images(b) {
  const list = Array.isArray(b.images) ? b.images.slice(0, 4) : [];
  for (const im of list) {
    if (!im || !/^(image\/(png|jpeg|webp)|audio\/[\w.+-]+)$/.test(String(im.mime)) || typeof im.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(im.data)) throw fail(400, 'each image needs mime and base64 data');
    if (im.data.length > IMAGE_MAX) throw fail(413, 'an image is at most ' + Math.round(IMAGE_MAX / 1.37 / 1e6) + ' MB');
  }
  return list;
}

/* ── one rung ────────────────────────────────────────────────────────────── */
/** What a failed answer means for the model → a patch of its row, and why. */
export function verdictOf(status, text, need, usedToday, now) {
  const t = String(text || '');
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(t)) {
    const m = /"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"/.exec(t), secs = m ? Number(m[1]) : null;
    // A short retryDelay is the per-minute limit; otherwise the day is spent (or there never was an allowance).
    const until = secs != null && secs <= 90 ? now + (secs + 1) * 1000 : usedToday ? nextPacificMidnight(now) : now + NO_ALLOWANCE_MS;
    return { why: secs != null && secs <= 90 ? 'at its per-minute limit' : usedToday ? 'its daily allowance is spent' : 'no free allowance for this kind of request', spent: until, retry: false };
  }
  if (status === 404) return { why: 'the model is gone', drop: true, retry: false };
  if (status === 400 && need && /(not supported|unsupported|not enabled|tool|modalit|grounding|search)/i.test(t)) return { why: 'it cannot do ' + need, nocap: true, retry: false };
  if (status >= 500 || status == null) return { why: status ? 'HTTP ' + status : 'timed out', retry: true };
  return { why: 'HTTP ' + status, retry: false };
}
async function rung(env, L, row, job, body, write, now) {
  const need = JOBS[job].need, kind = need || 'text', svc = service(row.id);
  if (need && row.caps[need] === false) return { ok: false, why: 'it cannot do ' + need, skip: true };
  if ((row.spent[kind] || 0) > now) return { ok: false, why: 'spent until ' + new Date(row.spent[kind]).toISOString(), skip: true };
  L.caps[svc] = row.limits.rpd || BUDGET[row.family];
  const blocked = L.blocked(svc);
  if (blocked) return { ok: false, why: blocked, skip: true };
  const usedToday = L.used[svc] || 0;
  for (let attempt = 0; ; attempt++) {
    if (!L.spend(svc)) return { ok: false, why: 'at its daily budget', skip: true };
    const t0 = Date.now(), ac = new AbortController();
    let why = '', status = null, timer = setTimeout(() => { why = 'no first words in ' + GEMINI_FIRST_MS / 1000 + ' s'; ac.abort(); }, GEMINI_FIRST_MS), errText = '';
    try {
      const r = await fetch(`${API}/models/${row.id}:${write ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, { method: 'POST', signal: ac.signal, headers: { 'x-goog-api-key': env.GEMINI_KEY, 'content-type': 'application/json' }, body });
      status = r.status;
      if (!r.ok) { errText = (await r.text().catch(() => '')).slice(0, 2000); throw new Error('HTTP ' + status); }
      if (!write) {
        const j = await r.json(), bad = blockOf(j), text = partsText(j).trim();
        if (bad || !text) { status = 200; errText = ''; L.note(svc, false, 200, null, bad || 'an empty answer'); return { ok: false, why: bad || 'an empty answer' }; }
        L.note(svc, true, 200, Date.now() - t0);
        return { ok: true, text };
      }
      const pk = await peek(r.body, { textOf: partsText, badOf: blockOf });
      if (!pk.ok) { L.note(svc, false, 200, null, why || pk.why); if (why) { status = null; throw new Error(why); } return { ok: false, why: pk.why }; }
      clearTimeout(timer);
      timer = setTimeout(() => { why = 'the answer ran past ' + GEMINI_STREAM_MS / 1000 + ' s'; ac.abort(); }, GEMINI_STREAM_MS);
      const firstMs = Date.now() - t0;
      await write(sseEvent('meta', { provider: 'gemini', model: row.id, job }));
      for (const c of pk.head) await write(c);
      const cut = await pipeRest(pk.reader, write);
      if (cut) { L.note(svc, false, 200, null, 'cut mid-stream'); await write(sseEvent('reset', { provider: 'gemini', why: why || 'the stream was cut' })); return { ok: false, why: why || 'the stream was cut mid-way' }; }
      L.note(svc, true, 200, firstMs);
      if (need && row.caps[need] == null) { row.caps[need] = true; row.dirty = true; }
      return { ok: true, firstMs, ms: Date.now() - t0 };
    } catch (e) {
      const v = verdictOf(why ? null : status, errText, need, usedToday, now);
      if (v.spent) { row.spent[kind] = v.spent; row.dirty = true; } else L.note(svc, false, status, null, why || v.why);
      if (v.nocap) { row.caps[need] = false; row.dirty = true; }
      if (v.drop) { row.state = 'dropped'; row.dirty = true; }
      if (v.retry && !attempt) continue;
      return { ok: false, why: why || v.why, drop: !!v.drop };
    } finally { clearTimeout(timer); }
  }
}
async function saveRows(env, rows) {
  const dirty = rows.filter((r) => r.dirty);
  if (!dirty.length) return;
  await batch(env, dirty.map((r) => env.DB.prepare("UPDATE models SET caps = ?, spent = ?, state = ? WHERE provider = 'gemini' AND id = ?").bind(JSON.stringify(r.caps), JSON.stringify(r.spent), r.state, r.id)));
}

/* ── the job ─────────────────────────────────────────────────────────────── */
export async function gemini(env, req, ctx) {
  const b = await bodyOf(req, BODY_MAX + 4 * IMAGE_MAX), job = String((b && b.job) || '');
  if (!JOBS[job]) throw fail(400, 'job must be one of ' + Object.keys(JOBS).join(', '));
  if (!env.GEMINI_KEY) throw fail(503, 'GEMINI_KEY is not set');
  // Account figures never leave for Gemini.
  const p = buildPrompt(b, { stripPrivate: true }), pics = images(b), body = geminiBody(p, job, pics);
  const now = Date.now(), L = await Ledger.load(env, now);
  let rows = await rowsOf(env);
  if (!rows.some((r) => r.state === 'ok') || now - Math.max(0, ...rows.map((r) => r.at)) > DISCOVER_TTL) rows = await discover(env, now);
  const run = async (write) => {
    const tried = [];
    let dropped = false;
    for (const row of ladder(rows, job)) {
      const r = await rung(env, L, row, job, body, write, now);
      if (r.ok) return { ok: true, provider: 'gemini', model: row.id, tried, ...r };
      tried.push({ provider: 'gemini', model: row.id, why: r.why });
      dropped = dropped || !!r.drop;
    }
    if (dropped) { try { await saveRows(env, rows); rows = await discover(env, now); } catch (e) {} }
    // Every rung out: the job's fallback outside Gemini.
    if (FALLBACK[job] === 'fast') {
      const f = await runChain(env, L, buildPrompt(b), { write, now });
      return { ...f, tried: tried.concat(f.tried || []) };
    }
    return { ok: false, tried, fallback: FALLBACK[job] };
  };
  const after = async () => { await saveRows(env, rows).catch((e) => console.warn('gemini rows:', e.message || e)); await L.flush(); };
  if (b.stream === false) {
    let r;
    try { r = await run(null); } finally { await after(); }
    if (!r.ok) throw fail(503, 'no Gemini model could take the job', { tried: r.tried, fallback: r.fallback });
    return json({ ok: true, text: r.text, provider: r.provider, model: r.model, tried: r.tried, stripped: p.stripped });
  }
  return sseResponse(ctx, async (write) => {
    const r = await run(write);
    await write(r.ok ? sseEvent('done', { provider: r.provider, model: r.model, firstMs: r.firstMs, ms: r.ms, tried: r.tried, stripped: p.stripped }) : sseEvent('fail', { tried: r.tried, fallback: r.fallback }));
  }, after);
}
export async function discoverRoute(env) {
  const rows = await discover(env);
  return json({ ok: true, models: rows.map((r) => ({ id: r.id, family: r.family, rank: r.rank })) });
}
