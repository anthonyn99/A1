// The scanner's ledger (A1-Priv docs/TradeHub/quant/phase-05.md): every
// signal TradeHub Quant made, taken or not, and its grade. All in D1 table
// `signals` (migrations/0005_signals.sql).
//
//   GET  /signals?since=ms&status=open|done|all&symbol=X&limit=N
//        → { signals }, newest first (default: the last 30 days, all, 500)
//   POST /signals { signals: [Signal] }     at most 100 a call; a signal whose id
//        is already stored is left exactly as it is (no write); at most 600 NEW
//        signals stored in any 24 hours
//   POST /grades  { grades: [{ id, status, done, r, taken, triggeredAt, closedAt, mfe, mae, bars }] }
//        at most 200 a call; a finished grade is never changed again
//
// The page sends at most one batch a minute and only what is new, so a full
// trading day stays far under its budget (phase-05: under 400 rows written).
import { fail, json } from './http.js';
import { symOf, bodyOf } from './charts.js';

export const SIGNALS_PER_CALL = 100, GRADES_PER_CALL = 200, SIGNALS_PER_DAY = 600, LIST_MAX = 1000;
export const SIGNAL_BYTES = 4000;
const DAY = 86400_000;
const ID_RE = /^s[0-9a-z]{4,16}$/, SETUP_RE = /^[a-z][a-z-]{1,23}$/;
const HORIZONS = ['day', 'swing', 'invest'], DIRS = ['long', 'short'], VERDICTS = ['GO', 'WATCH', 'NO-GO'];
const STATUSES = ['open', 'triggered', 'target1', 'target2', 'stopped', 'expired'];
const fin = (x) => (Number.isFinite(x) ? x : null);

/** A row → the signal the page knows: its body, the stored columns and the grade. */
function rowOut(r) {
  let body = {}, grade = {};
  try { body = JSON.parse(r.body) || {}; } catch (e) {}
  try { grade = r.grade ? JSON.parse(r.grade) || {} : {}; } catch (e) {}
  return {
    ...body, ...grade,
    id: r.id, symbol: r.symbol, setup: r.setup, horizon: r.horizon, dir: r.dir, at: r.at, expires: r.expires,
    verdict: r.verdict, score: r.score, regime: r.regime, by: r.by, created: r.created,
    status: r.status, done: !!r.done, r: r.r, taken: r.taken, gradedAt: r.graded_at,
  };
}

/** GET /signals: one read. */
export async function getSignals(env, url) {
  const q = url.searchParams, now = Date.now();
  const since = Number(q.get('since')) || now - 30 * DAY;
  const status = q.get('status') || 'all';
  if (!['open', 'done', 'all'].includes(status)) throw fail(400, 'status must be open, done or all');
  const limit = Math.max(1, Math.min(LIST_MAX, Number(q.get('limit')) || 500));
  let sql = 'SELECT * FROM signals WHERE at >= ?';
  const args = [since];
  if (status !== 'all') { sql += ' AND done = ?'; args.push(status === 'done' ? 1 : 0); }
  if (q.get('symbol')) { sql += ' AND symbol = ?'; args.push(symOf(q.get('symbol'))); }
  sql += ' ORDER BY at DESC LIMIT ?';
  args.push(limit);
  const rows = (await env.DB.prepare(sql).bind(...args).all()).results || [];
  return json({ ok: true, signals: rows.map(rowOut) });
}

/** One signal from the page, checked → the row's values, or a thrown 400. */
export function checkSignal(s) {
  if (!s || typeof s !== 'object') throw fail(400, 'a signal must be an object');
  if (!ID_RE.test(String(s.id || ''))) throw fail(400, 'signal id is not valid');
  const symbol = symOf(s.symbol);
  if (!SETUP_RE.test(String(s.setup || ''))) throw fail(400, 'signal setup is not valid');
  if (!HORIZONS.includes(s.horizon) || !DIRS.includes(s.dir) || !VERDICTS.includes(s.verdict)) throw fail(400, 'signal horizon, dir or verdict is not valid');
  if (!Number.isFinite(s.at) || !Number.isFinite(s.expires) || s.expires <= s.at) throw fail(400, 'signal at and expires must be times, expires after at');
  for (const k of ['entry', 'stop']) if (!(s[k] > 0)) throw fail(400, 'signal ' + k + ' must be a price');
  if (!Array.isArray(s.zone) || s.zone.length !== 2 || !Array.isArray(s.targets) || s.targets.length !== 2) throw fail(400, 'signal needs zone and two targets');
  const { id, symbol: _s, setup, horizon, dir, at, expires, verdict, score, regime, status, done, r, taken, created, ...rest } = s;
  const body = JSON.stringify(rest);
  if (body.length > SIGNAL_BYTES) throw fail(413, 'a signal may be at most ' + SIGNAL_BYTES + ' bytes');
  return { id, symbol, setup, horizon, dir, at, expires, verdict, score: fin(score), regime: regime ? String(regime).slice(0, 40) : null, body };
}

/** POST /signals: one read (today's count) and one batch of inserts. */
export async function postSignals(env, req) {
  const b = await bodyOf(req, SIGNALS_PER_CALL * (SIGNAL_BYTES + 400));
  const list = Array.isArray(b && b.signals) ? b.signals : null;
  if (!list || !list.length) throw fail(400, 'signals is empty');
  if (list.length > SIGNALS_PER_CALL) throw fail(400, 'at most ' + SIGNALS_PER_CALL + ' signals a call');
  const rows = list.map(checkSignal), by = b.by === 'runner' ? 'runner' : 'page', now = Date.now();
  // Only rows not stored yet count against the cap (a stored id is ignored and writes nothing).
  const have = new Set(((await env.DB.prepare('SELECT id FROM signals WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(rows.map((x) => x.id))).all()).results || []).map((x) => x.id));
  const fresh = rows.filter((x) => !have.has(x.id));
  if (!fresh.length) return json({ ok: true, sent: rows.length, added: 0 });
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM signals WHERE created >= ?').bind(now - DAY).first();
  if (n && n.n + fresh.length > SIGNALS_PER_DAY) throw fail(429, 'at most ' + SIGNALS_PER_DAY + ' signals a day');
  const stmts = fresh.map((x) => env.DB.prepare('INSERT INTO signals (id, symbol, setup, horizon, dir, at, expires, verdict, score, regime, by, created, body) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING')
    .bind(x.id, x.symbol, x.setup, x.horizon, x.dir, x.at, x.expires, x.verdict, x.score, x.regime, by, now, x.body));
  if (env.DB.batch) await env.DB.batch(stmts); else for (const st of stmts) await st.run();
  return json({ ok: true, sent: rows.length, added: fresh.length });
}

/** POST /grades: one batch of updates; a row already done is not touched. */
export async function postGrades(env, req) {
  const b = await bodyOf(req, GRADES_PER_CALL * 600);
  const list = Array.isArray(b && b.grades) ? b.grades : null;
  if (!list || !list.length) throw fail(400, 'grades is empty');
  if (list.length > GRADES_PER_CALL) throw fail(400, 'at most ' + GRADES_PER_CALL + ' grades a call');
  const now = Date.now();
  const stmts = list.map((g) => {
    if (!g || !ID_RE.test(String(g.id || '')) || !STATUSES.includes(g.status)) throw fail(400, 'a grade needs an id and a known status');
    // An invest signal (Phase 7) also carries its return at 1, 3 and 6 months.
    const grade = JSON.stringify({ triggeredAt: fin(g.triggeredAt), closedAt: fin(g.closedAt), mfe: fin(g.mfe), mae: fin(g.mae), bars: fin(g.bars),
      ...(g.m1 != null || g.m3 != null || g.m6 != null ? { m1: fin(g.m1), m3: fin(g.m3), m6: fin(g.m6) } : {}) });
    const taken = g.taken == null ? null : String(g.taken).slice(0, 64);
    return env.DB.prepare('UPDATE signals SET status = ?, done = ?, r = ?, taken = COALESCE(?, taken), graded_at = ?, grade = ? WHERE id = ? AND done = 0')
      .bind(g.status, g.done ? 1 : 0, fin(g.r), taken, now, grade, g.id);
  });
  if (env.DB.batch) await env.DB.batch(stmts); else for (const st of stmts) await st.run();
  return json({ ok: true, graded: list.length });
}
