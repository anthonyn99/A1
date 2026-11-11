// The smaller sources: Finnhub (quotes), Public.com (quotes), Tiingo (daily
// bars, the second source for history). Each is skipped when its key is not set.
// Public.com is a brokerage: only its token exchange, account lookup and
// market-data quotes are called here, never anything that trades.
import { call, noteBad, ProviderError, BARS_TIMEOUT } from '../lib/net.js';
import { bar } from '../lib/bars.js';
import { nyMidnight } from '../lib/time.js';

/* ── Finnhub: one call per symbol (free: 60 a minute) ─────────────────────── */
// At most 10 symbols a request, and 50 calls a minute per worker instance
// (best effort: instances do not share this count; the daily cap still holds).
let fhMinute = { m: 0, n: 0 };
export const finnhub = {
  has: (env) => !!env.FINNHUB_KEY,
  canQuote: (s) => /^[A-Z][A-Z0-9.]{0,9}$/.test(s),
  MAX_PER_REQUEST: 10,
  PER_MINUTE: 50,
  reset() { fhMinute = { m: 0, n: 0 }; },
  async quotes(L, env, syms, now) {
    const out = {};
    const m = Math.floor(now / 60_000);
    if (fhMinute.m !== m) fhMinute = { m, n: 0 };
    const room = Math.max(0, Math.min(this.MAX_PER_REQUEST, this.PER_MINUTE - fhMinute.n));
    if (!room) throw new ProviderError('finnhub', 'at its per-minute limit');
    const list = syms.filter(this.canQuote).slice(0, room);
    fhMinute.n += list.length;
    await Promise.all(list.map(async (s) => {
      try {
        const j = await call(L, 'finnhub', `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${encodeURIComponent(env.FINNHUB_KEY)}`);
        // An unknown symbol answers c:0, t:0.
        if (j && j.c > 0 && j.t > 0) out[s] = { symbol: s, price: j.c, t: j.t * 1000, heard: now, provider: 'finnhub', realtime: true, delayMs: 0 };
      } catch (e) { if (!(e instanceof ProviderError)) throw e; }
    }));
    return out;
  },
};

/* ── Public.com: secret → short-lived access token → account → quotes ────── */
const PUB = 'https://api.public.com';
let pubToken = null; // { token, until, accountId } kept for the isolate's life, never stored
export const publicCom = {
  has: (env) => !!env.PUBLIC_KEY,
  canQuote: (s) => /^[A-Z][A-Z0-9.]{0,9}$/.test(s),
  reset() { pubToken = null; },
  async session(L, env, now) {
    if (pubToken && pubToken.until > now + 60_000) return pubToken;
    const t = await call(L, 'public', `${PUB}/userapiauthservice/personal/access-tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ validityInMinutes: 60, secret: env.PUBLIC_KEY }) });
    if (!t || !t.accessToken) throw noteBad(L, 'public', 'no access token in the answer');
    let accountId = env.PUBLIC_ACCOUNT_ID || '';
    if (!accountId) {
      const a = await call(L, 'public', `${PUB}/userapigateway/trading/account`, { headers: { authorization: 'Bearer ' + t.accessToken } });
      accountId = a && a.accounts && a.accounts[0] && a.accounts[0].accountId;
      if (!accountId) throw noteBad(L, 'public', 'no account in the answer');
    }
    pubToken = { token: t.accessToken, until: now + 55 * 60_000, accountId };
    return pubToken;
  },
  async quotes(L, env, syms, now) {
    const list = syms.filter(this.canQuote);
    if (!list.length) return {};
    const ask = async () => {
      const s = await this.session(L, env, now);
      return call(L, 'public', `${PUB}/userapigateway/marketdata/${encodeURIComponent(s.accountId)}/quotes`, {
        method: 'POST', headers: { authorization: 'Bearer ' + s.token, 'content-type': 'application/json' },
        body: JSON.stringify({ instruments: list.map((symbol) => ({ symbol, type: 'EQUITY' })) }) });
    };
    let j;
    // A refused token (revoked, expired early): forget it and get a new one, once.
    try { j = await ask(); }
    catch (e) { if (!(e instanceof ProviderError) || ![401, 403].includes(e.status)) throw e; pubToken = null; j = await ask(); }
    const out = {};
    for (const q of (j && j.quotes) || []) {
      const sym = q && q.instrument && q.instrument.symbol;
      const price = Number(q && q.last), t = Date.parse(q && q.lastTimestamp);
      if (!sym || q.outcome !== 'SUCCESS' || !(price > 0) || !Number.isFinite(t)) continue;
      const bid = Number(q.bid), ask = Number(q.ask);
      out[sym] = { symbol: sym, price, t, heard: now, provider: 'public', realtime: true, delayMs: 0,
        ...(bid > 0 ? { bid } : {}), ...(ask > 0 ? { ask } : {}) };
    }
    return out;
  },
};

/* ── Tiingo: daily history (free: 1,000 calls a day) ──────────────────────── */
export const tiingo = {
  has: (env) => !!env.TIINGO_KEY,
  /** Daily bars. Tiingo's plain prices are raw; split-adjusting walks back from
   *  the newest bar dividing by each later split (its adj* columns would also
   *  take out dividends, which Alpaca and Yahoo here do not). */
  async bars(L, env, sym, tf, from, to, adj) {
    if (tf !== '1d') return null;
    const d = (ms) => new Date(ms).toISOString().slice(0, 10);
    const j = await call(L, 'tiingo', `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(sym.replace(/\./g, '-').toLowerCase())}/prices?startDate=${d(from)}&endDate=${d(to)}&token=${encodeURIComponent(env.TIINGO_KEY)}`,
      { timeout: BARS_TIMEOUT });
    if (!Array.isArray(j)) throw noteBad(L, 'tiingo', 'bars in an unknown shape');
    const out = [];
    let f = 1;
    for (let i = j.length - 1; i >= 0; i--) {
      const r = j[i];
      // Tiingo dates the day at 00:00 UTC (the evening before, in New York): use the date itself.
      const b = bar(nyMidnight(String(r.date).slice(0, 10)),r.open / f, r.high / f, r.low / f, r.close / f, Math.round(r.volume * f));
      if (b) out.push(adj ? b : bar(b.t, r.open, r.high, r.low, r.close, r.volume));
      if (adj && r.splitFactor > 0 && r.splitFactor !== 1) f *= r.splitFactor;
    }
    return out.reverse();
  },
};
