// Phase 6's routes (A1-Priv docs/TradeHub/quant/phase-06.md): the setups'
// calibration table, paper trades, and saved strategy backtests. All in D1
// (migrations/0006_backtest.sql). Before that migration is applied, every
// read answers empty and every write 503 with what is missing.
//
//   GET  /calibration             { calibration }  the newest table (or null)
//   PUT  /calibration             { calibration }  the weekly backtest's table; the last 12 are kept
//   GET  /paper                   { paper }        followed signals, with their grades from the ledger
//   POST /paper                   { signal }       follow one on paper (its id is the signal's)
//   DELETE /paper?id=             stop following one
//   GET  /backtests               { backtests }    saved runs, newest first, without their curves
//   GET  /backtests/:id           { backtest }     one run, with its curve
//   POST /backtests               { name, spec, summary, curve }  save a run (one write)
//   DELETE /backtests/:id         remove one
import { fail, json } from './http.js';
import { checkSignal } from './signals.js';
import { bodyOf } from './charts.js';

export const CAL_BYTES = 400_000, CAL_KEEP = 12, PAPER_MAX = 500, BACKTESTS_MAX = 200;
export const SPEC_BYTES = 8_000, SUMMARY_BYTES = 24_000, CURVE_POINTS = 500;
const RUN_ID_RE = /^b[0-9a-z]{6,20}$/, SIG_ID_RE = /^s[0-9a-z]{4,16}$/;

/** A D1 error that means "this table is not there yet" (the migration is not applied). */
const noTable = (e) => /no such table/i.test(String((e && e.message) || e));
const notYet = () => fail(503, 'the backtest tables are not there yet (D1 migration 0006_backtest.sql)');
async function guarded(p, empty) {
  try { return await p; } catch (e) { if (noTable(e)) { if (empty !== undefined) return empty; throw notYet(); } throw e; }
}

/** GET /calibration: one read. */
export async function getCalibration(env) {
  const row = await guarded(env.DB.prepare('SELECT at, body FROM calibration ORDER BY at DESC, id DESC LIMIT 1').first(), null);
  let calibration = null;
  if (row) { try { calibration = JSON.parse(row.body); } catch (e) {} }
  return json({ ok: true, calibration, at: row ? row.at : null });
}
/** PUT /calibration { calibration }: one insert, and anything past the newest 12 removed (one batch). */
export async function putCalibration(env, req) {
  const b = await bodyOf(req, CAL_BYTES + 200);
  const c = b && b.calibration;
  if (!c || typeof c !== 'object' || Array.isArray(c) || c.v !== 1 || !c.setups || typeof c.setups !== 'object') throw fail(400, 'calibration needs v 1 and setups');
  const body = JSON.stringify(c), now = Date.now();
  if (body.length > CAL_BYTES) throw fail(413, 'a calibration may be at most ' + CAL_BYTES + ' bytes');
  const stmts = [
    env.DB.prepare('INSERT INTO calibration (at, by, body) VALUES (?, ?, ?)').bind(now, b.by === 'runner' ? 'runner' : 'page', body),
    env.DB.prepare('DELETE FROM calibration WHERE id NOT IN (SELECT id FROM calibration ORDER BY at DESC, id DESC LIMIT ?)').bind(CAL_KEEP),
  ];
  await guarded(env.DB.batch ? env.DB.batch(stmts) : (async () => { for (const s of stmts) await s.run(); })());
  return json({ ok: true, at: now });
}

/** GET /paper: one read, each followed signal with its grade from the ledger. */
export async function getPaper(env) {
  const rows = await guarded(env.DB.prepare('SELECT p.id AS pid, p.created AS followed, p.signal AS psig, s.status, s.done, s.r, s.grade FROM paper p LEFT JOIN signals s ON s.id = p.id ORDER BY p.created DESC LIMIT ?').bind(PAPER_MAX).all(), { results: [] });
  const paper = (rows.results || []).map((r) => {
    let sig = {}, grade = {};
    try { sig = JSON.parse(r.psig) || {}; } catch (e) {}
    try { grade = r.grade ? JSON.parse(r.grade) || {} : {}; } catch (e) {}
    return { ...sig, ...grade, id: r.pid, followed: r.followed, status: r.status || sig.status || 'open', done: !!r.done, r: r.r == null ? null : r.r, paper: true };
  });
  return json({ ok: true, paper });
}
/** POST /paper { signal }: one write; following the same signal again changes nothing. */
export async function postPaper(env, req) {
  const b = await bodyOf(req, 6000);
  const s = b && b.signal;
  const row = checkSignal(s);   // the same checks as the ledger
  const n = await guarded(env.DB.prepare('SELECT COUNT(*) AS n FROM paper').first());
  if (n && n.n >= PAPER_MAX) throw fail(429, 'at most ' + PAPER_MAX + ' paper trades');
  const keep = { ...JSON.parse(row.body), symbol: row.symbol, setup: row.setup, horizon: row.horizon, dir: row.dir, at: row.at, expires: row.expires, verdict: row.verdict, score: row.score, regime: row.regime };
  await guarded(env.DB.prepare('INSERT INTO paper (id, signal, created) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').bind(row.id, JSON.stringify(keep), Date.now()).run());
  return json({ ok: true, id: row.id });
}
/** DELETE /paper?id=: one write. */
export async function deletePaper(env, url) {
  const id = String(url.searchParams.get('id') || '');
  if (!SIG_ID_RE.test(id)) throw fail(400, 'id is needed');
  await guarded(env.DB.prepare('DELETE FROM paper WHERE id = ?').bind(id).run());
  return json({ ok: true });
}

const runOut = (r, withCurve) => {
  const out = { id: r.id, name: r.name, created: r.created };
  for (const k of ['spec', 'summary', ...(withCurve ? ['curve'] : [])]) { try { out[k] = JSON.parse(r[k]); } catch (e) { out[k] = null; } }
  return out;
};
/** GET /backtests: one read, no curves. */
export async function listBacktests(env) {
  const rows = await guarded(env.DB.prepare('SELECT id, name, created, spec, summary FROM backtests ORDER BY created DESC LIMIT ?').bind(BACKTESTS_MAX).all(), { results: [] });
  return json({ ok: true, backtests: (rows.results || []).map((r) => runOut(r, false)) });
}
/** GET /backtests/:id: one read. */
export async function getBacktest(env, id) {
  if (!RUN_ID_RE.test(id)) throw fail(400, 'not a run id');
  const r = await guarded(env.DB.prepare('SELECT * FROM backtests WHERE id = ?').bind(id).first(), null);
  if (!r) throw fail(404, 'no such run');
  return json({ ok: true, backtest: runOut(r, true) });
}
/** POST /backtests { name, spec, summary, curve: [[t, v]] ≤ 500, bench?: [[t, v]] ≤ 500 }: one write. */
export async function postBacktest(env, req) {
  const b = await bodyOf(req, SPEC_BYTES + SUMMARY_BYTES + 60_000);
  const name = String((b && b.name) || '').trim().slice(0, 80);
  if (!name) throw fail(400, 'a name is needed');
  const spec = JSON.stringify((b && b.spec) || null), summary = JSON.stringify((b && b.summary) || null);
  if (!b || !b.spec || typeof b.spec !== 'object') throw fail(400, 'spec is needed');
  if (!b.summary || typeof b.summary !== 'object') throw fail(400, 'summary is needed');
  if (spec.length > SPEC_BYTES) throw fail(413, 'a spec may be at most ' + SPEC_BYTES + ' bytes');
  if (summary.length > SUMMARY_BYTES) throw fail(413, 'a summary may be at most ' + SUMMARY_BYTES + ' bytes');
  const okCurve = (c) => Array.isArray(c) && c.length <= CURVE_POINTS && c.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
  if (!okCurve(b.curve) || (b.bench != null && !okCurve(b.bench))) throw fail(400, 'curve (and bench) must be up to ' + CURVE_POINTS + ' [time, value] points');
  const n = await guarded(env.DB.prepare('SELECT COUNT(*) AS n FROM backtests').first());
  if (n && n.n >= BACKTESTS_MAX) throw fail(429, 'at most ' + BACKTESTS_MAX + ' saved runs: delete one first');
  const now = Date.now(), id = 'b' + now.toString(36) + Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
  await guarded(env.DB.prepare('INSERT INTO backtests (id, name, created, spec, summary, curve) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, name, now, spec, summary, JSON.stringify({ equity: b.curve, bench: b.bench || null })).run());
  return json({ ok: true, id, created: now });
}
/** DELETE /backtests/:id: one write. */
export async function deleteBacktest(env, id) {
  if (!RUN_ID_RE.test(id)) throw fail(400, 'not a run id');
  await guarded(env.DB.prepare('DELETE FROM backtests WHERE id = ?').bind(id).run());
  return json({ ok: true });
}
