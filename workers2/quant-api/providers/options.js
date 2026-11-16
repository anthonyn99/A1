// CBOE's delayed option chain (15 minutes, no key), A1-Priv
// docs/TradeHub/quant/phase-13.md "Options". One call returns every contract of
// a symbol with its IV and greeks (AAPL ≈ 1.5 MB, SPY ≈ 5.6 MB); it is cut down
// here to the compact form A1-Priv TradeHub/core/options.js reads:
//   { symbol, spot, iv30, at, delayed: true,
//     expiries: [{ exp, c: [[k, bid, ask, iv, oi, vol, delta, gamma]…], p: […] }] }
// Index symbols (SPX, VIX…) are not asked: their chains are 10+ MB.
import { call, noteBad, ProviderError } from '../lib/net.js';

export const URL_OF = (sym) => `https://cdn-api.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(sym)}.json`;
export const MAX_DAYS = 120, MAX_EXPIRIES = 10, NEAR_EXPIRIES = 6, BAND = 0.3, TIMEOUT = 15000;
export const canAsk = (s) => /^[A-Z][A-Z.]{0,5}$/.test(s);
const OCC = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const DAY = 86_400_000;
const n4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

/** "AAPL261116C00275000" → { root, exp: '2026-11-16', type: 'C', k: 275 } or null. */
export function parseOcc(s) {
  const m = OCC.exec(String(s || ''));
  return m ? { root: m[1], exp: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5], k: Number(m[6]) / 1000 } : null;
}

const ymd = (d) => d.slice(2).replace(/-/g, '');
/** Is 'YYYY-MM-DD' a month's third Friday (the standard monthly expiry)? */
export const thirdFriday = (d) => { const x = new Date(d + 'T12:00:00Z'), day = x.getUTCDate(); return x.getUTCDay() === 5 && day >= 15 && day <= 21; };
/** The third Fridays after `after` up to `last` ('YYYY-MM-DD'), ascending. */
export function thirdFridays(after, last) {
  const out = [];
  for (let t = Date.parse(after.slice(0, 8) + '15T12:00:00Z'); out.length < 8; ) {
    const x = new Date(t);
    for (let d = 15; d <= 21; d++) { const s = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), d, 12)).toISOString().slice(0, 10); if (thirdFriday(s)) { if (s > after && s <= last) out.push(s); break; } }
    t = Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 15, 12);
    if (new Date(t).toISOString().slice(0, 10) > last) break;
  }
  return out;
}
/** Which expiries are kept: the NEAR_EXPIRIES nearest, then the monthlies (third
 *  Fridays) up to MAX_DAYS, at most MAX_EXPIRIES in all. */
export function pickExpiries(sorted) {
  const near = sorted.slice(0, NEAR_EXPIRIES), rest = sorted.slice(NEAR_EXPIRIES).filter(thirdFriday);
  return near.concat(rest).slice(0, MAX_EXPIRIES);
}

/** Collects kept contracts into the compact chain. Only the symbol's own root
 *  counts (SPY's chain also lists "B1SPY…" contracts, left out). */
function collector(sym, spot, now) {
  const by = new Map(), lo = spot * (1 - BAND), hi = spot * (1 + BAND);
  const today = new Date(now - 5 * 3_600_000).toISOString().slice(0, 10), last = new Date(now + MAX_DAYS * DAY).toISOString().slice(0, 10);
  return {
    /** Would contract `occ` be kept? (decided from its symbol alone) → its parts or null. */
    want(occ) { const p = parseOcc(occ); return p && p.root === sym && p.exp >= today && p.exp <= last && p.k >= lo && p.k <= hi ? p : null; },
    add(p, o) {
      let e = by.get(p.exp);
      if (!e) by.set(p.exp, (e = { exp: p.exp, c: [], p: [] }));
      (p.type === 'C' ? e.c : e.p).push([p.k, n4(o.bid), n4(o.ask), n4(o.iv), o.open_interest | 0, o.volume | 0, n4(o.delta), n4(o.gamma)]);
    },
    today, last,
    done(iv30) {
      const keep = new Set(pickExpiries([...by.keys()].sort()));
      const expiries = [...by.values()].filter((e) => keep.has(e.exp)).sort((a, b) => (a.exp < b.exp ? -1 : 1));
      for (const e of expiries) { e.c.sort((a, b) => a[0] - b[0]); e.p.sort((a, b) => a[0] - b[0]); }
      return { symbol: sym, spot, iv30: iv30 > 0 ? iv30 / 100 : null, at: now, delayed: true, expiries };
    },
  };
}

/** CBOE's JSON (parsed) → the compact chain: the 6 nearest expiries and the monthlies
 *  within 120 days (at most 10), strikes within ±30% of spot, each side by strike. */
export function compactChain(j, now = Date.now()) {
  const d = j && j.data;
  const spot = d && Number(d.current_price);
  if (!d || !Array.isArray(d.options) || !(spot > 0)) return null;
  const c = collector(String(d.symbol || '').replace(/^_/, ''), spot, now);
  for (const o of d.options) { const p = o && c.want(o.option); if (p) c.add(p, o); }
  return c.done(Number(d.iv30));
}

/**
 * The same from CBOE's raw text, without parsing all of it: SPY's 5.6 MB chain
 * takes ~30 ms to JSON.parse and ~7 ms just to step through (a free Worker has
 * 10 ms of CPU). CBOE lists contracts by expiry, so this reads the 6 nearest
 * expiries from the top, then jumps (one native indexOf each) to each monthly
 * expiry and reads only that run; each kept contract's few fields are read in
 * place. The same result as compactChain (tested).
 */
export function compactText(text, sym, now = Date.now()) {
  const t = String(text || ''), tail = t.slice(Math.max(0, t.lastIndexOf('"current_price"')));
  const num = (key) => { const m = new RegExp('"' + key + '"\\s*:\\s*(-?[\\d.]+)').exec(tail); return m ? Number(m[1]) : NaN; };
  const spot = num('current_price');
  if (!(spot > 0)) return null;
  const c = collector(sym, spot, now), KEY = '"option":', seen = [];
  // Read contracts from position `i` while `go(p)` says so (p = the contract's parts, own root only) → where it stopped.
  const read = (i, go) => {
    for (i = t.indexOf(KEY, i); i >= 0; i = t.indexOf(KEY, i + 1)) {
      const q0 = t.indexOf('"', i + KEY.length), q1 = t.indexOf('"', q0 + 1);
      if (q0 < 0 || q1 < 0) return -1;
      const p = parseOcc(t.slice(q0 + 1, q1));
      if (!p || p.root !== sym || p.exp < c.today) continue;
      if (!go(p)) return i;
      const b = t.indexOf('}', q1);
      if (b < 0) return -1;
      if (p.k < spot * (1 - BAND) || p.k > spot * (1 + BAND) || p.exp > c.last) { i = b; continue; }
      // The few fields needed, read in place (flat object, no nesting): no JSON.parse per contract.
      const f = (key) => { const k = t.indexOf('"' + key + '"', q1); if (k < 0 || k > b) return NaN; let s = t.indexOf(':', k) + 1; while (t.charCodeAt(s) === 32) s++; return parseFloat(t.slice(s, s + 24)); };
      c.add(p, { bid: f('bid'), ask: f('ask'), iv: f('iv'), open_interest: f('open_interest'), volume: f('volume'), delta: f('delta'), gamma: f('gamma') });
      i = b;
    }
    return -1;
  };
  // The nearest expiries, from the top.
  let pos = read(0, (p) => { if (!seen.includes(p.exp)) { if (seen.length >= NEAR_EXPIRIES || p.exp > c.last) return false; seen.push(p.exp); } return true; });
  // Then each monthly after them, by a jump to its first contract.
  const lastNear = seen[seen.length - 1];
  if (pos >= 0 && lastNear) {
    for (const d of thirdFridays(lastNear, c.last)) {
      if (seen.length >= MAX_EXPIRIES) break;
      const j = t.indexOf('"' + sym + ymd(d), pos);
      if (j < 0) continue;
      seen.push(d);
      const stop = read(t.lastIndexOf(KEY, j), (p) => p.exp === d);
      if (stop < 0) break;
      pos = stop;
    }
  }
  return c.done(num('iv30'));
}

/** Fetch and compact one symbol's chain (one CBOE call through the ledger). */
export async function chain(L, sym, now = Date.now()) {
  if (!canAsk(sym)) throw new ProviderError('cboe', 'not a symbol CBOE lists options for here');
  const text = await call(L, 'cboe', URL_OF(sym), { timeout: TIMEOUT, text: true });
  const c = compactText(text, sym, now);
  if (!c || !c.expiries.length) throw noteBad(L, 'cboe', 'no options in the chain');
  return c;
}
