// The Charts tab's routes (A1-Priv docs/TradeHub/quant/phase-04.md): Tony's
// drawings per symbol, in D1. The alert rules made from a chart live in
// lib/alerts.js since Phase 14 (every kind of alert).
import { fail, json } from './http.js';

const DAY = 86400_000;
export const DRAWINGS_MAX = 200, DRAWINGS_BYTES = 64_000;
export const DRAWINGS_KEEP_MS = 30 * DAY;
const SYM_RE = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/;
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
