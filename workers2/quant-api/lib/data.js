// The data gateway's two chains: quotes and bars, each falling through its
// providers in order until every symbol (or every stretch of history) is
// answered. A provider that fails, is at its cap or has no key is passed
// over and named in `tried`. Nothing old is ever served in place of an answer.
import * as alpaca from '../providers/alpaca.js';
import * as yahoo from '../providers/yahoo.js';
import { finnhub, publicCom, tiingo } from '../providers/others.js';
import { ProviderError } from './net.js';
import { BASE_TF, INTRADAY, mergeBars, toTimeframe, within } from './bars.js';

/* ── quotes ─────────────────────────────────────────────────────────────── */
export const QUOTE_CHAIN = [
  { name: 'alpaca', has: alpaca.has, quotes: alpaca.quotes },
  { name: 'public', has: publicCom.has, quotes: (L, e, s, n) => publicCom.quotes(L, e, s, n) },
  { name: 'finnhub', has: finnhub.has, quotes: (L, e, s, n) => finnhub.quotes(L, e, s, n) },
  { name: 'yahoo', has: () => true, quotes: yahoo.quotes },
];
export const MAX_SYMBOLS = 60;

/** Upper-case, de-duplicated, valid symbols (A-Z 0-9 . - ^ =), at most 60. */
export function parseSymbols(s) {
  const list = [...new Set(String(s || '').toUpperCase().split(',').map((x) => x.trim()).filter(Boolean))];
  if (list.some((x) => !/^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/.test(x))) throw Object.assign(new Error('a symbol is not valid'), { status: 400 });
  if (list.length > MAX_SYMBOLS) throw Object.assign(new Error('at most ' + MAX_SYMBOLS + ' symbols'), { status: 400 });
  return list;
}

/** { quotes: {SYM: Quote}, missing: {SYM: [tried]}, tried: [{provider, error}] } */
export async function getQuotes(L, env, syms, now) {
  const quotes = {}, tried = [];
  for (const p of QUOTE_CHAIN) {
    const left = syms.filter((s) => !quotes[s]);
    if (!left.length) break;
    if (!p.has(env)) { tried.push({ provider: p.name, error: 'no key' }); continue; }
    try {
      const got = await p.quotes(L, env, left, now);
      for (const s of left) if (got[s]) quotes[s] = got[s];
      const n = left.filter((s) => got[s]).length;
      tried.push({ provider: p.name, answered: n });
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      tried.push({ provider: p.name, error: e.message });
    }
  }
  const missing = {};
  for (const s of syms) if (!quotes[s]) missing[s] = tried.map((t) => t.provider);
  return { quotes, missing, tried };
}

/* ── bars ───────────────────────────────────────────────────────────────── */
// Alpaca's history starts in 2016; older daily bars come from Yahoo.
export const ALPACA_START = Date.UTC(2016, 0, 4);
const BARS = {
  alpaca: { has: alpaca.has, bars: alpaca.bars },
  yahoo: { has: () => true, bars: yahoo.bars },
  tiingo: { has: tiingo.has, bars: (L, e, s, tf, f, t, a) => tiingo.bars(L, e, s, tf, f, t, a) },
};
const CHAIN = { intraday: ['alpaca', 'yahoo'], daily: ['alpaca', 'yahoo', 'tiingo'], old: ['yahoo', 'tiingo'] };

/** One stretch of history from the first provider in `names` that answers. */
async function stretch(L, env, names, sym, tf, from, to, adj, now, tried) {
  for (const n of names) {
    const p = BARS[n];
    if (!p.has(env)) { tried.push({ provider: n, error: 'no key' }); continue; }
    try {
      const b = await p.bars(L, env, sym, tf, from, to, adj, now);
      if (!b) { tried.push({ provider: n, error: 'does not serve ' + tf }); continue; }
      if (!b.length && n !== names[names.length - 1]) { tried.push({ provider: n, error: 'no bars' }); continue; }
      tried.push({ provider: n, answered: b.length });
      return { bars: b, provider: n, clipped: !!b.clipped };
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      tried.push({ provider: n, error: e.message });
    }
  }
  return null;
}

/** { symbol, tf, bars, provider, complete, tried } or null when nobody answered. */
export async function getBars(L, env, sym, tf, from, to, adj, now) {
  const base = BASE_TF[tf] || tf, tried = [];
  const parts = [];
  if (INTRADAY.has(base)) {
    const s = await stretch(L, env, CHAIN.intraday, sym, base, from, to, adj, now, tried);
    if (s) parts.push(s);
    else return null;
  } else {
    // Older than Alpaca's start: Yahoo, then Tiingo. From then on: Alpaca first.
    if (from < ALPACA_START) {
      const s = await stretch(L, env, CHAIN.old, sym, base, from, Math.min(to, ALPACA_START - 1), adj, now, tried);
      parts.push(s || { failed: true });
    }
    if (to >= ALPACA_START) {
      const s = await stretch(L, env, CHAIN.daily, sym, base, Math.max(from, ALPACA_START), to, adj, now, tried);
      parts.push(s || { failed: true });
    }
    if (!parts.some((p) => p.bars)) return null;
  }
  // History from before Alpaca's start that Yahoo served is checked against Tiingo.
  let check = null;
  if (!INTRADAY.has(base) && from < ALPACA_START && parts[0] && parts[0].provider === 'yahoo' && tiingo.has(env)) {
    try { check = { by: 'tiingo', ...compareReturns(parts[0].bars, await tiingo.raw(L, env, sym, from, Math.min(to, ALPACA_START - 1))) }; }
    catch (e) { if (!(e instanceof ProviderError)) throw e; check = { by: 'tiingo', error: e.message }; }
  }
  const ok = parts.filter((p) => p.bars);
  // Trim the base bars first, so a week or month that began before `from` still comes out.
  const bars = toTimeframe(within(mergeBars(...ok.map((p) => p.bars)), from, to), tf);
  return {
    symbol: sym, tf, bars,
    provider: [...new Set(ok.map((p) => p.provider))].join('+'),
    complete: ok.length === parts.length && !ok.some((p) => p.clipped),
    tried,
    ...(check ? { check } : {}),
  };
}

export const CHECK_TOL = 0.01, CHECK_LIST = 20;
/** Yahoo's old daily bars against Tiingo's raw closes, by DAILY RETURN (a
 *  return does not change with split adjustment, so the two need not be
 *  adjusted alike). A day is compared when both sources have it and the day
 *  before, and Tiingo shows no split that day. → `{ days, mismatches: [{ t,
 *  yahoo, tiingo }] (at most 20), more }`, returns as fractions; a mismatch
 *  differs by more than 1 point. */
export function compareReturns(yahooBars, raw) {
  const tb = new Map((raw || []).map((r, i) => [r.t, { ...r, prev: i ? raw[i - 1] : null }]));
  let days = 0, more = 0;
  const mismatches = [];
  for (let i = 1; i < (yahooBars || []).length; i++) {
    const y0 = yahooBars[i - 1], y1 = yahooBars[i], t1 = tb.get(y1.t);
    if (!t1 || !t1.prev || t1.prev.t !== y0.t || t1.split !== 1 || !(y0.c > 0) || !(t1.prev.c > 0)) continue;
    days++;
    const ry = y1.c / y0.c - 1, rt = t1.c / t1.prev.c - 1;
    if (Math.abs(ry - rt) > CHECK_TOL) { if (mismatches.length < CHECK_LIST) mismatches.push({ t: y1.t, yahoo: ry, tiingo: rt }); else more++; }
  }
  return { days, mismatches, more };
}
