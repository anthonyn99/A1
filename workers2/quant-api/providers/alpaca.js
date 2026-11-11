// Alpaca market data, free plan (paper account key; it cannot touch money).
// Read-only: only data.alpaca.markets is ever called, never the trading API.
//
// Free-plan rule: SIP (the whole market) only up to 15 minutes ago; the live
// edge comes from IEX (`feed=iex`), whose volume is a fraction of the market's.
import { call, noteBad, BARS_TIMEOUT } from '../lib/net.js';
import { bar, dailyStamp, mergeBars } from '../lib/bars.js';

const BASE = 'https://data.alpaca.markets';
const TF = { '1m': '1Min', '5m': '5Min', '15m': '15Min', '30m': '30Min', '1h': '1Hour', '1d': '1Day' };
export const SIP_LAG = 16 * 60_000;
export const has = (env) => !!(env.ALPACA_KEY && env.ALPACA_SECRET);
const headers = (env) => ({ 'APCA-API-KEY-ID': env.ALPACA_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET, accept: 'application/json' });
/** Alpaca writes class shares with a dot (BRK.B); indexes (^VIX) it does not have. */
export const canQuote = (s) => /^[A-Z][A-Z0-9.]{0,9}$/.test(s);

export async function quotes(L, env, syms, now) {
  const list = syms.filter(canQuote);
  if (!list.length) return {};
  const j = await call(L, 'alpaca', `${BASE}/v2/stocks/snapshots?symbols=${encodeURIComponent(list.join(','))}&feed=iex`, { headers: headers(env) });
  const out = {};
  for (const s of list) {
    const x = j && j[s], tr = x && x.latestTrade, q = x && x.latestQuote;
    if (!tr || !(tr.p > 0)) continue;
    out[s] = { symbol: s, price: tr.p, t: Date.parse(tr.t), heard: now, provider: 'alpaca', realtime: true, delayMs: 0,
      ...(q && q.bp > 0 ? { bid: q.bp } : {}), ...(q && q.ap > 0 ? { ask: q.ap } : {}), ...(tr.s > 0 ? { size: tr.s } : {}) };
  }
  return out;
}

async function page(L, env, sym, tf, from, to, adj, feed) {
  const out = [];
  let token = '';
  for (let i = 0; i < 10; i++) {
    const u = `${BASE}/v2/stocks/${encodeURIComponent(sym)}/bars?timeframe=${TF[tf]}&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`
      + `&limit=10000&adjustment=${adj ? 'split' : 'raw'}&feed=${feed}&sort=asc${token ? '&page_token=' + encodeURIComponent(token) : ''}`;
    const j = await call(L, 'alpaca', u, { headers: headers(env), timeout: BARS_TIMEOUT });
    if (!j || (j.bars !== null && !Array.isArray(j.bars))) throw noteBad(L, 'alpaca', 'bars in an unknown shape');
    for (const b of j.bars || []) {
      const t = Date.parse(b.t);
      const x = bar(tf === '1d' ? dailyStamp(t) : t, b.o, b.h, b.l, b.c, b.v);
      if (x) out.push(x);
    }
    token = j.next_page_token;
    if (!token) break;
  }
  return out;
}

/** Bars of a base timeframe (TF above) between `from` and `to` (ms). History
 *  comes from SIP; the newest 16 minutes, for intraday, from IEX. */
export async function bars(L, env, sym, tf, from, to, adj, now) {
  if (!TF[tf] || !canQuote(sym)) return null;
  const edge = now - SIP_LAG;
  const sip = from < edge ? await page(L, env, sym, tf, from, Math.min(to, edge), adj, 'sip') : [];
  const iex = tf !== '1d' && to > edge ? await page(L, env, sym, tf, Math.max(from, edge), to, adj, 'iex') : [];
  return mergeBars(sip, iex);
}
