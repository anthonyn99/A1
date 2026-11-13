// The Charts tab's routes (A1-Priv docs/TradeHub/quant/phase-04.md): Tony's
// drawings per symbol and the alert rules made from a chart. All in D1.
import { fail, json } from './http.js';

const DAY = 86400_000;
export const DRAWINGS_MAX = 200, DRAWINGS_BYTES = 64_000, ALERTS_MAX = 200;
export const DRAWINGS_KEEP_MS = 30 * DAY;
const SYM_RE = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/, ID_RE = /^[\w-]{1,64}$/;
export function symOf(v) {
  const s = String(v || '').toUpperCase().trim();
  if (!SYM_RE.test(s)) throw fail(400, 'a symbol is needed');
  return s;
}
export async function bodyOf(req, max) {
  let text;
  try { text = await req.text(); } catch (e) { throw fail(400, 'a JSON body is needed'); }
  if (text.length > max) throw fail(413, 'at most ' + max + ' bytes');
  try { return JSON.parse(text); } catch (e) { throw fail(400, 'a JSON body is needed'); }
}
/** GET /drawings?symbol=X: one read. */
export async function getDrawings(env, url) {
  const symbol = symOf(url.searchParams.get('symbol'));
  const row = await env.DB.prepare('SELECT body, at FROM drawings WHERE symbol = ?').bind(symbol).first();
  let drawings = [];
  if (row) { try { const a = JSON.parse(row.body); if (Array.isArray(a)) drawings = a; } catch (e) {} }
  return json({ ok: true, symbol, drawings, at: row ? row.at : null });
}
/** PUT /drawings { symbol, drawings }: replace that chart's drawings. One write. */
export async function putDrawings(env, req) {
  const body = await bodyOf(req, DRAWINGS_BYTES + 200);
  const symbol = symOf(body && body.symbol), list = body && body.drawings;
  if (!Array.isArray(list)) throw fail(400, 'drawings must be a list');
  if (list.length > DRAWINGS_MAX) throw fail(400, 'at most ' + DRAWINGS_MAX + ' drawings a chart');
  if (!list.every((d) => d && typeof d === 'object' && !Array.isArray(d) && typeof d.kind === 'string' && Array.isArray(d.pts))) throw fail(400, 'each drawing needs kind and pts');
  const out = JSON.stringify(list), now = Date.now();
  if (out.length > DRAWINGS_BYTES) throw fail(413, 'at most ' + DRAWINGS_BYTES + ' bytes of drawings a chart');
  await env.DB.prepare('INSERT INTO drawings (symbol, body, at, gone_at) VALUES (?, ?, ?, NULL) '
    // A save clears gone_at: a chart still being drawn on (a ticker-panel symbol off the
    // watchlist, say) is swept only 30 days after the next watchlist change that follows it.
    + 'ON CONFLICT (symbol) DO UPDATE SET body = excluded.body, at = excluded.at, gone_at = NULL').bind(symbol, out, now).run();
  return json({ ok: true, symbol, n: list.length, at: now });
}
/** GET /alerts[?symbol=X]: the rules, newest first. */
export async function getAlerts(env, url) {
  const s = url.searchParams.get('symbol');
  const rows = s ? (await env.DB.prepare('SELECT * FROM alerts WHERE symbol = ? ORDER BY created DESC').bind(symOf(s)).all()).results
    : (await env.DB.prepare('SELECT * FROM alerts ORDER BY created DESC LIMIT ?').bind(ALERTS_MAX).all()).results;
  return json({ ok: true, alerts: rows || [] });
}
/** POST /alerts { alert }: add one, or change it (same id; its created time stays). */
export async function putAlert(env, req) {
  const body = await bodyOf(req, 4000), a = body && body.alert;
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw fail(400, 'alert is needed');
  const symbol = symOf(a.symbol), kind = a.kind === 'level' ? 'level' : 'price';
  const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);
  const price = num(a.price), lo = num(a.lo), hi = num(a.hi);
  if ([price, lo, hi].some(Number.isNaN)) throw fail(400, 'price, lo and hi must be numbers');
  if (price == null && (lo == null || hi == null)) throw fail(400, 'a price, or lo and hi, is needed');
  const id = a.id == null ? crypto.randomUUID() : String(a.id);
  if (!ID_RE.test(id)) throw fail(400, 'a bad id');
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM alerts WHERE id != ?').bind(id).first();
  if (n && n.n >= ALERTS_MAX) throw fail(400, 'at most ' + ALERTS_MAX + ' alerts');
  const s = (v, k) => (v == null ? null : String(v).slice(0, k)), now = Date.now();
  await env.DB.prepare('INSERT INTO alerts (id, symbol, kind, price, lo, hi, level, note, active, created, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT (id) DO UPDATE SET symbol = excluded.symbol, kind = excluded.kind, price = excluded.price, lo = excluded.lo, hi = excluded.hi, '
    + 'level = excluded.level, note = excluded.note, active = excluded.active, at = excluded.at')
    .bind(id, symbol, kind, price, lo, hi, s(a.level, 40), s(a.note, 200), a.active === false ? 0 : 1, now, now).run();
  return json({ ok: true, id });
}
/** DELETE /alerts?id=: remove one. */
export async function deleteAlert(env, url) {
  const id = String(url.searchParams.get('id') || '');
  if (!ID_RE.test(id)) throw fail(400, 'id= is needed');
  await env.DB.prepare('DELETE FROM alerts WHERE id = ?').bind(id).run();
  return json({ ok: true, id });
}

