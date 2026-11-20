// Crypto bars and quotes (Refinements Batch 2, B1; A1-Priv docs/TradeHub/quant/r2-01.md).
// Both free, read-only, market data only:
//   Alpaca crypto   data.alpaca.markets/v1beta3/crypto/us  10,000 bars a page, every interval; no SUI
//   Coinbase        api.exchange.coinbase.com               no key; 300 candles a call (CB_PAGES at most a request)
// The live ticks do not come through here: the page streams Coinbase straight from the browser.
import { call, noteBad, BARS_TIMEOUT } from '../lib/net.js';
import { bar, mergeBars } from '../lib/bars.js';
import { alpacaPair, coinbasePair, cryptoDayStamp, baseOf } from '../lib/crypto.js';

const AP = 'https://data.alpaca.markets/v1beta3/crypto/us';
const CB = 'https://api.exchange.coinbase.com';
const AP_TF = { '1m': '1Min', '5m': '5Min', '15m': '15Min', '30m': '30Min', '1h': '1Hour', '1d': '1Day' };
const CB_GRAN = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };
export const CB_PAGES = 12, CB_MAX = 300, AP_PAGES = 10;
/** Alpaca's crypto history starts here (checked 2026-11-20): older daily bars come from Coinbase. */
export const AP_CRYPTO_START = Date.UTC(2021, 0, 1);
// Coins in lib/crypto.js BASES that Coinbase has no X-USD market for (its product list, 2026-11-20; USDC is
// its dollar): never asked, so their 404s can never trip the ledger's three-failures skip for every other coin.
// Keep in step with A1-Priv TradeHub/core/crypto.js CB_NONE.
export const CB_NONE = new Set(['USDC', 'TRX', 'MATIC', 'JUP', 'KAS', 'XMR', 'MKR', 'EOS']);
export const onCoinbase = (sym) => !CB_NONE.has(baseOf(sym));
/** B4 (ask 44): Coinbase answers this span within its page budget (5-minute candles for 30 minutes). */
export function coinbaseFits(sym, tf, from, to) {
  const g = CB_GRAN[tf === '30m' ? '5m' : tf];
  return !!g && onCoinbase(sym) && (to - from) / (g * 1000) <= CB_PAGES * CB_MAX;
}
const H = { 'user-agent': 'TradeHub personal research (quant-api worker)', accept: 'application/json' };
const apHeaders = (env) => (env.ALPACA_KEY && env.ALPACA_SECRET ? { 'APCA-API-KEY-ID': env.ALPACA_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET, accept: 'application/json' } : { accept: 'application/json' });
const stamp = (tf, t) => (tf === '1d' ? cryptoDayStamp(t) : t);

/** Alpaca's crypto bars between `from` and `to` (ms); [] for a coin Alpaca does not list (the next source answers). */
export async function alpacaBars(L, env, sym, tf, from, to) {
  if (!AP_TF[tf]) return null;
  const pair = alpacaPair(sym), out = [];
  let token = '';
  // Newest first: a span longer than 10 pages keeps its NEWEST bars and is marked `clipped`.
  for (let i = 0; i < AP_PAGES; i++) {
    const u = `${AP}/bars?symbols=${encodeURIComponent(pair)}&timeframe=${AP_TF[tf]}&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}&limit=10000&sort=desc${token ? '&page_token=' + encodeURIComponent(token) : ''}`;
    const j = await call(L, 'alpaca', u, { headers: apHeaders(env), timeout: BARS_TIMEOUT });
    if (!j || typeof j.bars !== 'object') throw noteBad(L, 'alpaca', 'crypto bars in an unknown shape');
    for (const b of (j.bars && j.bars[pair]) || []) { const x = bar(stamp(tf, Date.parse(b.t)), b.o, b.h, b.l, b.c, b.v); if (x) out.push(x); }
    token = j.next_page_token;
    if (!token) break;
  }
  const bars = mergeBars(out);
  if (token) bars.clipped = true;
  return bars;
}

/** Coinbase candles between `from` and `to` (ms), newest first, at most CB_PAGES calls: a longer span
 *  comes back `clipped` (its newest part), so the answer is marked incomplete. 30 minutes = 5-minute candles joined. */
export async function coinbaseBars(L, sym, tf, from, to) {
  if (!onCoinbase(sym)) return null;
  if (tf === '30m') {
    const five = await coinbaseBars(L, sym, '5m', from, to);
    if (!five) return null;
    const out = [], step = 30 * 60_000;
    for (const b of five) {
      const k = Math.floor(b.t / step) * step, cur = out[out.length - 1];
      if (!cur || cur.t !== k) out.push({ t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
    }
    out.clipped = five.clipped;
    return out;
  }
  const g = CB_GRAN[tf];
  if (!g || !onCoinbase(sym)) return null;
  const span = g * 1000 * CB_MAX, out = [];
  let end = to, pages = 0;
  while (end > from && pages < CB_PAGES) {
    const start = Math.max(from, end - span);
    const rows = await call(L, 'coinbase', `${CB}/products/${coinbasePair(sym)}/candles?granularity=${g}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`, { headers: H, timeout: BARS_TIMEOUT });
    pages++;
    if (!Array.isArray(rows)) throw noteBad(L, 'coinbase', 'candles in an unknown shape');
    // [time s, low, high, open, close, volume]
    for (const r of rows) { const x = bar(stamp(tf, r[0] * 1000), r[3], r[2], r[1], r[4], r[5]); if (x && x.t >= from && x.t <= to) out.push(x); }
    end = start;
  }
  const bars = mergeBars(out);
  if (end > from) bars.clipped = true;
  return bars;
}

/** Quotes for crypto symbols → { SYM: Quote with open24 }: Coinbase's 24-hour stats, then Alpaca's latest trade (USDC). */
export async function quotes(L, env, syms, now) {
  const out = {};
  for (const s of syms.slice(0, 20)) {
    if (!onCoinbase(s)) continue;
    try {
      const j = await call(L, 'coinbase', `${CB}/products/${coinbasePair(s)}/stats`, { headers: H });
      const last = Number(j && j.last), open = Number(j && j.open);
      if (last > 0) out[s] = { symbol: s, price: last, t: now, heard: now, provider: 'coinbase', realtime: true, delayMs: 0, ...(open > 0 ? { open24: open } : {}) };
    } catch (e) { /* the next source */ }
  }
  const left = syms.filter((s) => !out[s] && baseOf(s));
  if (left.length) {
    try {
      const pairs = left.map(alpacaPair);
      const j = await call(L, 'alpaca', `${AP}/latest/trades?symbols=${encodeURIComponent(pairs.join(','))}`, { headers: apHeaders(env) });
      left.forEach((s, i) => { const tr = j && j.trades && j.trades[pairs[i]]; if (tr && tr.p > 0) out[s] = { symbol: s, price: tr.p, t: Date.parse(tr.t), heard: now, provider: 'alpaca', realtime: true, delayMs: 0 }; });
    } catch (e) { /* missing */ }
  }
  return out;
}
