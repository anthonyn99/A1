// quant-api: TradeHub Quant's worker (A1-Priv docs/TradeHub/quant-plan.md).
// One door for market data, the budget ledger, and (later phases) signals,
// history, alerts and Drive. Everything it stores is in D1; it uses no KV.
//
// Who may call it: Tony's Orca key, sent as `Authorization: Bearer orca_sk_…`.
// The worker holds only the SHA-256 of the keys it accepts (secret
// ALLOWED_KEYS), so the key itself is never stored here, and with no
// ALLOWED_KEYS set every route but /health is refused.
//
// Routes
//   GET  /health                   { ok, db, time }                        no key needed
//   GET  /whoami                   { ok }
//   GET  /usage                    today's calls per service with caps, provider health, which keys are set
//   GET  /quotes?symbols=A,B       { quotes: {SYM: Quote}, asOf, missing, tried }   max 60; 503 when nobody answered
//   GET  /bars?symbol&tf&from&to&adj=1   { symbol, tf, bars, provider, complete, known, tried }
//   GET  /stream-keys              { alpaca: {key, secret}, finnhub: {key} }   the page's two live streams
//   GET  /corrections?limit=50     the data doctor's log, newest first
//   POST /corrections              { items: [{kind, symbol, field, old_v, new_v, source, note}] }  max 50
//   GET  /snapshot?day[&slot]      { snapshot, watchlist }  the newest market snapshot up to that New York day
//   POST /snapshot                 { snapshot }  kept under its (day, slot); from the runner or the page
//   POST /snapshot/claim           { day, slot } → { granted }  one device builds a slot the runner missed
//   POST /watchlist                { symbols }   the watchlist the runner builds the snapshot for
//                                  (it also marks the drawings of symbols that left it; 30 days gone = deleted)
//   GET  /drawings?symbol=X        { symbol, drawings, at }   Tony's drawings on that chart
//   PUT  /drawings                 { symbol, drawings }       replace them (at most 200, 64 KB)
//   GET  /alerts[?symbol=X]        { alerts }                 the alert rules made from charts
//   POST /alerts                   { alert }                  add or change one (at most 200)
//   DELETE /alerts?id=             remove one
//   GET  /signals?since&status&symbol&limit   { signals }   the scanner's ledger, newest first (lib/signals.js)
//   POST /signals                  { signals }   new signals; one already stored is left as it is
//   POST /grades                   { grades }    what happened to open signals
//
// Quote and Bar are exactly A1-Priv TradeHub/core/contracts.js. The worker
// never sends a freshness label: the page works it out from provider, t,
// heard, realtime and delayMs, so it can turn STALE by time alone.
import { CAPS, Ledger, day, readLatency, median } from './lib/ledger.js';
import { getQuotes, getBars, parseSymbols } from './lib/data.js';
import { TFS, INTRADAY } from './lib/bars.js';
import { marketHours, nyMonthStart, nyMidnight } from './lib/time.js';
import * as alpaca from './providers/alpaca.js';
import { finnhub, publicCom, tiingo } from './providers/others.js';
import { fail, json } from './lib/http.js';
import { getSignals, postSignals, postGrades } from './lib/signals.js';

export { CAPS, spend, noteHealth, day } from './lib/ledger.js';

const ORIGINS = [
  /^https:\/\/a1-priv\.av1\.workers\.dev$/,
  /^https:\/\/anthonyn99\.github\.io$/,
  /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/,
];
const DAY = 86400_000;
// The widest span one /bars request may ask for, per timeframe.
export const MAX_SPAN = { '1m': 45 * DAY, '5m': 400 * DAY, '15m': 400 * DAY, '30m': 400 * DAY, '1h': 2200 * DAY, '4h': 2200 * DAY };

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const r = await route(req, env, new URL(req.url), ctx);
      const out = new Response(r.body, r);   // a cached response's headers are immutable
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    } catch (e) {
      return json({ ok: false, error: e.message || String(e), ...(e.extra || {}) }, e.status || 500, cors);
    }
  },
};

async function route(req, env, url, ctx) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  if (m === 'GET' && (p === '/' || p === '/health')) {
    let db = false;
    try { db = !!(await env.DB.prepare('SELECT 1 AS one').first()); } catch (e) {}
    return json({ ok: true, db, time: Date.now() });
  }
  await auth(req, env);
  if (m === 'GET' && p === '/whoami') return json({ ok: true });
  if (m === 'GET' && p === '/usage') return usage(env);
  if (m === 'GET' && p === '/quotes') return quotes(env, url, ctx);
  if (m === 'GET' && p === '/bars') return bars(env, url, ctx);
  if (m === 'GET' && p === '/stream-keys') {
    return json({
      ok: true,
      alpaca: alpaca.has(env) ? { key: env.ALPACA_KEY, secret: env.ALPACA_SECRET } : null,
      finnhub: finnhub.has(env) ? { key: env.FINNHUB_KEY } : null,
    });
  }
  if (p === '/corrections' && m === 'GET') {
    const n = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
    const rows = (await env.DB.prepare('SELECT * FROM corrections ORDER BY at DESC, id DESC LIMIT ?').bind(n).all()).results || [];
    return json({ ok: true, corrections: rows });
  }
  if (p === '/corrections' && m === 'POST') return addCorrections(env, req);
  if (p === '/snapshot' && m === 'GET') return getSnapshot(env, url);
  if (p === '/snapshot' && m === 'POST') return putSnapshot(env, req);
  if (p === '/snapshot/claim' && m === 'POST') return claimSnapshot(env, req);
  if (p === '/watchlist' && m === 'POST') return putWatchlist(env, req);
  if (p === '/drawings' && m === 'GET') return getDrawings(env, url);
  if (p === '/drawings' && m === 'PUT') return putDrawings(env, req);
  if (p === '/alerts' && m === 'GET') return getAlerts(env, url);
  if (p === '/alerts' && m === 'POST') return putAlert(env, req);
  if (p === '/alerts' && m === 'DELETE') return deleteAlert(env, url);
  if (p === '/signals' && m === 'GET') return getSignals(env, url);
  if (p === '/signals' && m === 'POST') return postSignals(env, req);
  if (p === '/grades' && m === 'POST') return postGrades(env, req);
  throw fail(404, 'no such route');
}

/* ── /snapshot, /watchlist ──────────────────────────────────────────────── */
export const SLOT_NAMES = ['premarket', 'open30', 'midday', 'close', 'nightly'];
// Minutes after New York midnight each slot is due (A1-Priv TradeHub/core/slots.js SLOTS).
export const SLOT_MIN = { premarket: 510, open30: 600, midday: 750, close: 970, nightly: 1230 };
export const CLAIM_MS = 10 * 60_000;   // how long a device's claim to build a slot holds
/** When `slot` of New York day `day` is due (ms). */
export const slotDue = (day, slot) => nyMidnight(day) + SLOT_MIN[slot] * 60_000;
export const SNAPSHOT_MAX = 300_000;   // bytes of JSON one snapshot may be
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The watchlist the page last sent (meta row `watchlist`), or null. */
async function readWatchlist(env) {
  const row = await env.DB.prepare("SELECT v, at FROM meta WHERE k = 'watchlist'").first();
  if (!row) return null;
  try { const a = JSON.parse(row.v); return Array.isArray(a) ? { symbols: a, at: row.at } : null; } catch (e) { return null; }
}
/** GET /snapshot?day=YYYY-MM-DD[&slot=]: the newest snapshot of that New York
 *  day or any day before it (so a morning with no build yet still shows last
 *  night's); with slot=, exactly that one or null. No day = the newest of all. */
async function getSnapshot(env, url) {
  const day = url.searchParams.get('day') || '', slot = url.searchParams.get('slot') || '';
  if (day && !DAY_RE.test(day)) throw fail(400, 'day must be YYYY-MM-DD');
  if (slot && !SLOT_NAMES.includes(slot)) throw fail(400, 'slot must be one of ' + SLOT_NAMES.join(' '));
  if (slot && !day) throw fail(400, 'slot= needs day=');
  const row = slot ? await env.DB.prepare('SELECT * FROM snapshots WHERE day = ? AND slot = ?').bind(day, slot).first()
    : day ? await env.DB.prepare('SELECT * FROM snapshots WHERE day <= ? ORDER BY due DESC LIMIT 1').bind(day).first()
      : await env.DB.prepare('SELECT * FROM snapshots ORDER BY due DESC LIMIT 1').first();
  let snapshot = null;
  if (row) { try { snapshot = JSON.parse(row.body); } catch (e) {} }
  const wl = await readWatchlist(env);
  return json({ ok: true, snapshot, watchlist: wl ? wl.symbols : null, watchlistAt: wl ? wl.at : null });
}
/** POST /snapshot { snapshot }: keep it under its (day, slot). One write. */
async function putSnapshot(env, req) {
  let text;
  try { text = await req.text(); } catch (e) { throw fail(400, 'a JSON body is needed'); }
  if (text.length > SNAPSHOT_MAX + 100) throw fail(413, 'a snapshot may be at most ' + SNAPSHOT_MAX + ' bytes');
  let body;
  try { body = JSON.parse(text); } catch (e) { throw fail(400, 'a JSON body is needed'); }
  const s = body && body.snapshot;
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw fail(400, 'snapshot is needed');
  if (!DAY_RE.test(s.day || '')) throw fail(400, 'snapshot.day must be YYYY-MM-DD');
  if (!SLOT_NAMES.includes(s.slot)) throw fail(400, 'snapshot.slot must be one of ' + SLOT_NAMES.join(' '));
  if (!Number.isFinite(s.at) || !s.rows || typeof s.rows !== 'object' || !s.regime) throw fail(400, 'snapshot needs at, rows and regime');
  const now = Date.now();
  // `due` orders the snapshots, so it is worked out here, never taken from the sender.
  s.due = slotDue(s.day, s.slot);
  if (s.due > now + 60_000) throw fail(400, 'that slot is not due yet');
  const out = JSON.stringify(s);
  if (out.length > SNAPSHOT_MAX) throw fail(413, 'a snapshot may be at most ' + SNAPSHOT_MAX + ' bytes');
  await env.DB.prepare('INSERT INTO snapshots (day, slot, due, at, by, body) VALUES (?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT (day, slot) DO UPDATE SET due = excluded.due, at = excluded.at, by = excluded.by, body = excluded.body')
    .bind(s.day, s.slot, Math.round(s.due), now, s.by === 'runner' ? 'runner' : 'page', out).run();
  return json({ ok: true, day: s.day, slot: s.slot });
}
/** POST /snapshot/claim { day, slot }: may the caller build this slot? Granted
 *  when nobody claimed it in the last CLAIM_MS (meta row `claim:day:slot`), so
 *  several devices that find it missing do not all build it. One read, one write. */
async function claimSnapshot(env, req) {
  let body;
  try { body = await req.json(); } catch (e) { throw fail(400, 'a JSON body is needed'); }
  const day = body && body.day, slot = body && body.slot;
  if (!DAY_RE.test(day || '') || !SLOT_NAMES.includes(slot)) throw fail(400, 'day and slot are needed');
  const k = 'claim:' + day + ':' + slot, now = Date.now();
  const row = await env.DB.prepare('SELECT at FROM meta WHERE k = ?').bind(k).first();
  if (row && now - row.at < CLAIM_MS) return json({ ok: true, granted: false, until: row.at + CLAIM_MS });
  await env.DB.prepare('INSERT INTO meta (k, v, at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, at = excluded.at').bind(k, '1', now).run();
  return json({ ok: true, granted: true });
}
/** POST /watchlist { symbols }: what the runner should include (meta row `watchlist`). */
async function putWatchlist(env, req) {
  let body;
  try { body = await req.json(); } catch (e) { throw fail(400, 'a JSON body is needed'); }
  if (!Array.isArray(body && body.symbols)) throw fail(400, 'symbols is needed');
  const syms = [...new Set(body.symbols.map((x) => String(x).toUpperCase().trim()))].filter((x) => /^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/.test(x)).slice(0, 200);
  const now = Date.now(), list = JSON.stringify(syms);
  await env.DB.prepare('INSERT INTO meta (k, v, at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, at = excluded.at').bind('watchlist', list, now).run();
  // Drawings follow the watchlist: a symbol that left it is marked, one back
  // in it unmarked, and one gone for DRAWINGS_KEEP_MS deleted. Never fails the
  // watchlist itself (a database without the drawings table, say).
  const stmts = [
    env.DB.prepare('UPDATE drawings SET gone_at = ? WHERE gone_at IS NULL AND symbol NOT IN (SELECT value FROM json_each(?))').bind(now, list),
    env.DB.prepare('UPDATE drawings SET gone_at = NULL WHERE gone_at IS NOT NULL AND symbol IN (SELECT value FROM json_each(?))').bind(list),
    env.DB.prepare('DELETE FROM drawings WHERE gone_at IS NOT NULL AND gone_at < ?').bind(now - DRAWINGS_KEEP_MS),
  ];
  try { if (env.DB.batch) await env.DB.batch(stmts); else for (const st of stmts) await st.run(); }
  catch (e) { console.warn('drawings sweep:', e.message || e); }
  return json({ ok: true, symbols: syms });
}

/* ── /drawings, /alerts (the Charts tab) ────────────────────────────────── */
export const DRAWINGS_MAX = 200, DRAWINGS_BYTES = 64_000, ALERTS_MAX = 200;
export const DRAWINGS_KEEP_MS = 30 * DAY;
const SYM_RE = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/, ID_RE = /^[\w-]{1,64}$/;
function symOf(v) {
  const s = String(v || '').toUpperCase().trim();
  if (!SYM_RE.test(s)) throw fail(400, 'a symbol is needed');
  return s;
}
async function bodyOf(req, max) {
  let text;
  try { text = await req.text(); } catch (e) { throw fail(400, 'a JSON body is needed'); }
  if (text.length > max) throw fail(413, 'at most ' + max + ' bytes');
  try { return JSON.parse(text); } catch (e) { throw fail(400, 'a JSON body is needed'); }
}
/** GET /drawings?symbol=X: one read. */
async function getDrawings(env, url) {
  const symbol = symOf(url.searchParams.get('symbol'));
  const row = await env.DB.prepare('SELECT body, at FROM drawings WHERE symbol = ?').bind(symbol).first();
  let drawings = [];
  if (row) { try { const a = JSON.parse(row.body); if (Array.isArray(a)) drawings = a; } catch (e) {} }
  return json({ ok: true, symbol, drawings, at: row ? row.at : null });
}
/** PUT /drawings { symbol, drawings }: replace that chart's drawings. One write. */
async function putDrawings(env, req) {
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
async function getAlerts(env, url) {
  const s = url.searchParams.get('symbol');
  const rows = s ? (await env.DB.prepare('SELECT * FROM alerts WHERE symbol = ? ORDER BY created DESC').bind(symOf(s)).all()).results
    : (await env.DB.prepare('SELECT * FROM alerts ORDER BY created DESC LIMIT ?').bind(ALERTS_MAX).all()).results;
  return json({ ok: true, alerts: rows || [] });
}
/** POST /alerts { alert }: add one, or change it (same id; its created time stays). */
async function putAlert(env, req) {
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
async function deleteAlert(env, url) {
  const id = String(url.searchParams.get('id') || '');
  if (!ID_RE.test(id)) throw fail(400, 'id= is needed');
  await env.DB.prepare('DELETE FROM alerts WHERE id = ?').bind(id).run();
  return json({ ok: true, id });
}

/* ── /usage ─────────────────────────────────────────────────────────────── */
async function usage(env) {
  const d = day();
  const rows = (await env.DB.prepare('SELECT service, n FROM usage WHERE day = ? ORDER BY service').bind(d).all()).results || [];
  const health = (await env.DB.prepare('SELECT * FROM provider_health ORDER BY provider').all()).results || [];
  const lat = await readLatency(env);
  for (const h of health) h.median_ms = median(lat[h.provider]);
  return json({
    ok: true, day: d, now: Date.now(),
    usage: rows.map((r) => ({ service: r.service, n: r.n, cap: CAPS[r.service.split(':')[0]] || null })),
    health,
    caps: CAPS,
    keys: { alpaca: alpaca.has(env), public: publicCom.has(env), finnhub: finnhub.has(env), yahoo: true, tiingo: tiingo.has(env), groq: !!env.GROQ_KEY },
  });
}

/* ── /quotes ────────────────────────────────────────────────────────────── */
async function quotes(env, url, ctx) {
  const syms = parseSymbols(url.searchParams.get('symbols'));
  if (!syms.length) throw fail(400, 'symbols= is needed');
  const now = Date.now();
  const ttl = marketHours(now) ? 2 : 60;
  const key = 'https://quant-api.cache/quotes?s=' + [...syms].sort().join(',');
  const hit = await cacheGet(key);
  if (hit) return hit;
  const L = await Ledger.load(env, now);
  let out;
  try { out = await getQuotes(L, env, syms, now); }
  finally { await later(ctx, L.flush()); }
  if (!Object.keys(out.quotes).length) throw fail(503, 'no provider answered', { tried: out.tried, missing: out.missing });
  const r = json({ ok: true, quotes: out.quotes, asOf: now, missing: out.missing, tried: out.tried }, 200, { 'cache-control': 'public, max-age=' + ttl });
  await later(ctx, cachePut(key, r.clone()));
  return r;
}

/* ── /bars ──────────────────────────────────────────────────────────────── */
/** A time from the query: ms since 1970, or YYYY-MM-DD (UTC). */
function when(v, d) {
  if (v == null || v === '') return d;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw fail(400, 'not a time: ' + v);
  return t;
}
async function bars(env, url, ctx) {
  const q = url.searchParams;
  const symbol = parseSymbols(q.get('symbol'))[0];
  const tf = q.get('tf') || '1d';
  if (!symbol) throw fail(400, 'symbol= is needed');
  if (!TFS.includes(tf)) throw fail(400, 'tf must be one of ' + TFS.join(' '));
  const now = Date.now();
  const to = Math.min(when(q.get('to'), now), now);
  const from = Math.max(0, when(q.get('from'), to - (INTRADAY.has(tf) ? 5 * DAY : 365 * DAY)));
  if (from > to) throw fail(400, 'from is after to');
  if (MAX_SPAN[tf] && to - from > MAX_SPAN[tf]) throw fail(400, `at most ${Math.round(MAX_SPAN[tf] / DAY)} days of ${tf} bars a request`);
  const adj = q.get('adj') !== '0';
  // A range that ends before this New York month began never changes again,
  // raw. Split-adjusted history changes the day a split happens, so it is
  // kept for a day only.
  const closed = to < nyMonthStart(now);
  const key = `https://quant-api.cache/bars?s=${symbol}&tf=${tf}&from=${from}&to=${to}&adj=${adj ? 1 : 0}`;
  if (closed) { const hit = await cacheGet(key); if (hit) return hit; }
  const L = await Ledger.load(env, now);
  let out;
  try { out = await getBars(L, env, symbol, tf, from, to, adj, now); }
  finally { await later(ctx, L.flush()); }
  if (!out) throw fail(503, 'no provider answered', { tried: [] });
  out.known = await noteHistory(env, symbol, tf, out, now);
  const cc = !(closed && out.complete) ? 'public, max-age=' + (marketHours(now) ? 15 : 300)
    : adj ? 'public, max-age=86400' : 'public, max-age=31536000, immutable';
  const r = json({ ok: true, ...out }, 200, { 'cache-control': cc });
  if (closed && out.complete) await later(ctx, cachePut(key, r.clone()));
  return r;
}
/** bars_meta: widen what is known of this symbol's history; one read, a write only when it grew. */
async function noteHistory(env, symbol, tf, out, now) {
  const row = await env.DB.prepare('SELECT first_t, last_t FROM bars_meta WHERE symbol = ? AND tf = ?').bind(symbol, tf).first();
  if (!out.bars.length) return row || null;
  const first = out.bars[0].t, last = out.bars[out.bars.length - 1].t;
  const next = { first_t: row && row.first_t != null ? Math.min(row.first_t, first) : first, last_t: row && row.last_t != null ? Math.max(row.last_t, last) : last };
  if (!row || next.first_t !== row.first_t || next.last_t !== row.last_t) {
    await env.DB.prepare('INSERT INTO bars_meta (symbol, tf, first_t, last_t, provider, at) VALUES (?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT (symbol, tf) DO UPDATE SET first_t = excluded.first_t, last_t = excluded.last_t, provider = excluded.provider, at = excluded.at')
      .bind(symbol, tf, next.first_t, next.last_t, out.provider, now).run();
  }
  return next;
}

/* ── /corrections ───────────────────────────────────────────────────────── */
async function addCorrections(env, req) {
  let body;
  try { body = await req.json(); } catch (e) { throw fail(400, 'a JSON body is needed'); }
  const items = Array.isArray(body && body.items) ? body.items : [];
  if (!items.length) throw fail(400, 'items is empty');
  if (items.length > 50) throw fail(400, 'at most 50 items a call');
  const s = (v, n) => (v == null ? null : String(v).slice(0, n));
  const now = Date.now();
  const stmts = items.map((it) => env.DB.prepare('INSERT INTO corrections (at, kind, symbol, field, old_v, new_v, source, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(Number.isFinite(it.at) ? it.at : now, s(it.kind, 20) || 'quote', s(it.symbol, 16), s(it.field, 40), s(it.old_v, 80), s(it.new_v, 80), s(it.source, 40), s(it.note, 200)));
  if (env.DB.batch) await env.DB.batch(stmts); else for (const st of stmts) await st.run();
  return json({ ok: true, added: items.length });
}

/* ── who may call ───────────────────────────────────────────────────────── */
export async function sha256Hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function auth(req, env) {
  const allowed = String(env.ALLOWED_KEYS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) throw fail(503, 'this worker has no allowed keys set');
  const key = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^orca_sk_[\w-]{8,}$/.test(key)) throw fail(401, 'an Orca key is needed');
  const h = await sha256Hex(key);
  // Compare against every allowed hash without stopping early.
  let ok = 0;
  for (const a of allowed) ok |= same(h, a) ? 1 : 0;
  if (!ok) throw fail(403, 'this key may not use quant-api');
}
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ── small helpers ──────────────────────────────────────────────────────── */
// The edge cache (absent outside Cloudflare, e.g. in the tests).
const edge = () => (typeof caches !== 'undefined' && caches.default) || null;
async function cacheGet(key) { const c = edge(); return c ? (await c.match(key)) || null : null; }
async function cachePut(key, r) { const c = edge(); if (c) await c.put(key, r); }
/** Run `p` after the answer when the runtime allows it, else wait for it. */
async function later(ctx, p) { if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p; }
function corsHeaders(req) {
  const o = req.headers.get('origin') || '';
  if (!ORIGINS.some((re) => re.test(o))) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': o,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}
