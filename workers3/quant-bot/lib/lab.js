// Neo Cortex N3 (A1-Priv docs/TradeHub/quant/n4-03.md): the strategist's lab runs, the strategies it
// proposed that passed the Neo Gate, and "Research now" requests. D1 `quantbot`, migration 0001_lab.
//
//   GET  /lab/runs?day&session&limit    newest first (results left out unless &full=1)
//   POST /lab/runs                      one run (insert, or complete the same id)
//   GET  /strategies?stage              the newest version of each strategy (all stages unless asked)
//   POST /strategies                    a gated spec: the Gate runs AGAIN here (clamp must change nothing, the bot
//                                       check must pass, its gate must say pass); a stored version never changes
//   GET  /research/request              the oldest unclaimed request, or null
//   POST /research/request { note }     ask for a run now (Control's "Research now", N6)
//   POST /research/claim { id, run_id } the runner took it
import { clampSpec } from '../core/gate.js';
import { checkStrategy, specHash } from '../core/strategy.js';
import { LIMITS } from '../core/risk-book.js';

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const bad = (message, status = 400) => json({ ok: false, error: message }, status);
const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/, RUN_RE = /^[A-Za-z0-9_-]{6,64}$/, DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const SESSIONS = ['premarket', 'postclose', 'now'], OUTCOMES = ['ok', 'no-edge', 'refused', 'failed', 'running'];

function runRow(r, full) {
  return { id: r.id, session: r.session, day: r.day, model: r.model, started: r.started, ended: r.ended, outcome: r.outcome, summary: r.summary,
    trials: r.trials, usage: parse(r.usage), ...(full ? { results: parse(r.results, []) } : { count: (parse(r.results, []) || []).length }) };
}
function stratRow(r) {
  return { id: r.id, version: r.version, hash: r.hash, name: r.name, stage: r.stage, spec: parse(r.spec), gate: parse(r.gate), edits: parse(r.edits, []), report: parse(r.report), run_id: r.run_id, created: r.created, updated: r.updated };
}

export async function getRuns(env, url) {
  const day = url.searchParams.get('day'), session = url.searchParams.get('session'), full = url.searchParams.get('full') === '1';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);
  const where = [], args = [];
  if (day) { if (!DAY_RE.test(day)) return bad('day is YYYY-MM-DD'); where.push('day = ?'); args.push(day); }
  if (session) { if (!SESSIONS.includes(session)) return bad('session is ' + SESSIONS.join(', ')); where.push('session = ?'); args.push(session); }
  const q = `SELECT * FROM lab_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started DESC LIMIT ?`;
  const { results } = await env.DB.prepare(q).bind(...args, limit).all();
  return json({ ok: true, runs: results.map((r) => runRow(r, full)) });
}

export async function postRun(env, b) {
  if (!b || !RUN_RE.test(String(b.id || ''))) return bad('a run needs an id');
  if (!SESSIONS.includes(b.session)) return bad('session is ' + SESSIONS.join(', '));
  if (!DAY_RE.test(String(b.day || ''))) return bad('day is YYYY-MM-DD');
  if (!OUTCOMES.includes(b.outcome)) return bad('outcome is ' + OUTCOMES.join(', '));
  const results = JSON.stringify(Array.isArray(b.results) ? b.results.slice(0, 40) : []);
  if (results.length > 400_000) return bad('results are over 400 KB');
  await env.DB.prepare(`INSERT INTO lab_runs (id, session, day, model, started, ended, outcome, summary, results, trials, usage) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET ended = excluded.ended, outcome = excluded.outcome, summary = excluded.summary, results = excluded.results, trials = excluded.trials, usage = excluded.usage, model = excluded.model`)
    .bind(b.id, b.session, b.day, b.model || null, Number(b.started) || Date.now(), b.ended || null, b.outcome, String(b.summary || '').slice(0, 4000), results,
      Number.isFinite(b.trials) ? b.trials : null, b.usage ? JSON.stringify(b.usage) : null).run();
  return json({ ok: true, id: b.id });
}

export async function getStrategies(env, url) {
  const stage = url.searchParams.get('stage');
  const q = `SELECT s.* FROM strategies s JOIN (SELECT id, MAX(version) v FROM strategies GROUP BY id) m ON m.id = s.id AND m.v = s.version ${stage ? 'WHERE s.stage = ?' : ''} ORDER BY s.updated DESC LIMIT 200`;
  const { results } = await (stage ? env.DB.prepare(q).bind(stage) : env.DB.prepare(q)).all();
  return json({ ok: true, strategies: results.map(stratRow) });
}

/** The Gate's second run, on receipt: the stored spec must already be inside the limits and pass the bot check. */
export function regate(spec, gate, limits = LIMITS) {
  const why = [];
  const chk = checkStrategy(spec, { bot: true });
  if (!chk.ok) why.push(...chk.errors);
  const c = clampSpec(spec, limits, {});
  const real = c.edits.filter((e) => e.field !== 'v');
  if (real.length) why.push('not inside the limits: ' + real.map((e) => `${e.field} (${e.why})`).join('; '));
  if (!gate || gate.pass !== true) why.push('its gate did not pass');
  return why;
}

export async function postStrategy(env, b, now = Date.now()) {
  if (!b || !ID_RE.test(String(b.id || '')) || !(Number.isInteger(b.version) && b.version >= 1)) return bad('a strategy needs an id and a whole version from 1');
  if (!b.spec || typeof b.spec !== 'object') return bad('a strategy needs its spec');
  if (b.spec.id !== b.id || b.spec.version !== b.version) return bad('the spec\'s id and version must match');
  const hash = specHash(b.spec);
  if (b.hash && b.hash !== hash) return bad('the hash does not match the spec');
  const why = regate(b.spec, b.gate);
  if (why.length) return json({ ok: false, error: 'refused by the Gate on receipt', reasons: why }, 422);
  const have = await env.DB.prepare('SELECT hash FROM strategies WHERE id = ? AND version = ?').bind(b.id, b.version).first();
  if (have) return have.hash === hash ? json({ ok: true, id: b.id, version: b.version, same: true }) : bad(`version ${b.version} of ${b.id} is already stored with other rules: publish version ${b.version + 1}`, 409);
  await env.DB.prepare('INSERT INTO strategies (id, version, hash, name, stage, spec, gate, edits, report, run_id, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(b.id, b.version, hash, String(b.spec.name || b.id).slice(0, 80), 'gated', JSON.stringify(b.spec), JSON.stringify(b.gate), JSON.stringify(b.edits || []),
      b.report ? JSON.stringify(b.report) : null, b.run_id || null, now, now).run();
  return json({ ok: true, id: b.id, version: b.version, hash, stage: 'gated' });
}

export async function getRequest(env) {
  const r = await env.DB.prepare('SELECT * FROM research_requests WHERE claimed_at IS NULL ORDER BY at LIMIT 1').first();
  return json({ ok: true, request: r || null });
}
export async function postRequest(env, b, now = Date.now()) {
  const open = await env.DB.prepare('SELECT id FROM research_requests WHERE claimed_at IS NULL LIMIT 1').first();
  if (open) return json({ ok: true, id: open.id, already: true });
  await env.DB.prepare('INSERT INTO research_requests (at, note) VALUES (?, ?)').bind(now, String((b && b.note) || '').slice(0, 500)).run();
  const r = await env.DB.prepare('SELECT id FROM research_requests WHERE claimed_at IS NULL ORDER BY id DESC LIMIT 1').first();
  return json({ ok: true, id: r.id });
}
export async function claimRequest(env, b, now = Date.now()) {
  if (!b || !Number.isInteger(b.id)) return bad('claim needs the request id');
  const r = await env.DB.prepare('UPDATE research_requests SET claimed_at = ?, run_id = ? WHERE id = ? AND claimed_at IS NULL').bind(now, String(b.run_id || ''), b.id).run();
  return json({ ok: true, claimed: (r.meta && r.meta.changes) === 1 });
}
