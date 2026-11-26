// COPY of A1-Priv TradeHub/core/risk-book.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Neo Cortex's risk book (docs/TradeHub/quant/n4-01.md, quant-trading.md §1): the portfolio
// check every bot order passes, and the guards. Pure; the bot (A1 workers3/quant-bot, a copy
// made by tools/sync-core.mjs), the backtest and the page share it.
//
// state = { equity, peak, dayPnl, halted?, paused?, positions: [{ sym, side: 'long'|'short', qty, price, stop,
//           style: 'day'|'swing'|'invest', strategy }] }   price = the latest price (or the entry before one)
// Limits are Tony's (Control ▸ Neo Cortex, N6). Claude and Neo chat can only tighten them (tighten()).
import { FLATTEN, FLATTEN_HALF, hhmm } from './strategy.js';

export const LIMITS = Object.freeze({
  book: 5000, maxDeployed: 3000, riskMinPct: 0.25, riskMaxPct: 1.25, maxPosition: 1500, maxPositions: 6,
  dailyLossPct: 3, drawdownPct: 10, shortsAllowed: true, maxShortExposure: 1500, stopRequired: true,
  styleShare: Object.freeze({ day: 0.5, swing: 0.35, invest: 0.15 }),
});
// For each limit: does a SMALLER number make it stricter? (all of them do; shortsAllowed: false is stricter.)
const CAPS = ['book', 'maxDeployed', 'riskMinPct', 'riskMaxPct', 'maxPosition', 'maxPositions', 'dailyLossPct', 'drawdownPct', 'maxShortExposure'];

/** `proposed` applied to `hard` only where it is stricter → { limits, loosened: [field] }. */
export function tighten(hard = LIMITS, proposed = {}) {
  const out = { ...hard, styleShare: { ...hard.styleShare } }, loosened = [];
  for (const k of CAPS) {
    if (proposed[k] == null) continue;
    const v = Number(proposed[k]);
    if (Number.isFinite(v) && v >= 0 && v <= hard[k]) out[k] = v; else loosened.push(k);
  }
  if (proposed.shortsAllowed != null) { if (proposed.shortsAllowed === false) out.shortsAllowed = false; else if (!hard.shortsAllowed) loosened.push('shortsAllowed'); }
  if (proposed.stopRequired === true) out.stopRequired = true;
  else if (proposed.stopRequired === false && hard.stopRequired) loosened.push('stopRequired');
  for (const [s, v] of Object.entries(proposed.styleShare || {})) {
    if (!(s in out.styleShare)) continue;
    if (Number.isFinite(+v) && +v >= 0 && +v <= hard.styleShare[s]) out.styleShare[s] = +v; else loosened.push('styleShare.' + s);
  }
  if (out.riskMinPct > out.riskMaxPct) out.riskMinPct = out.riskMaxPct;
  return { limits: out, loosened };
}

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : null);
/** The % of the book risked at this conviction (0..1): the band's floor when conviction is unknown. */
export function riskPct(conviction, L = LIMITS) {
  const c = clamp01(conviction);
  return c == null ? L.riskMinPct : L.riskMinPct + (L.riskMaxPct - L.riskMinPct) * c;
}

/** A position's dollars at its price. */
export const notional = (p) => Math.abs(p.qty) * p.price;
/** Dollars in open positions, long and short. */
export const deployed = (state) => (state.positions || []).reduce((a, p) => a + notional(p), 0);
/** Dollars in open shorts. */
export const shortExposure = (state) => (state.positions || []).filter((p) => p.side === 'short').reduce((a, p) => a + notional(p), 0);
/** Dollars in open positions of one style. */
export const styleDeployed = (state, style) => (state.positions || []).filter((p) => p.style === style).reduce((a, p) => a + notional(p), 0);
/** Dollars lost if every stop filled (a position with no stop counts whole). */
export const openRisk = (state) => (state.positions || []).reduce((a, p) => a + (p.stop != null ? Math.abs(p.qty) * Math.abs(p.price - p.stop) : notional(p)), 0);

/** The dollars still free for a new position of this style and side, and which cap binds. */
export function room(state, { style, side }, L = LIMITS) {
  const caps = [['position', L.maxPosition], ['deployed', L.maxDeployed - deployed(state)]];
  if (style && L.styleShare[style] != null) caps.push(['style ' + style, L.styleShare[style] * L.maxDeployed - styleDeployed(state, style)]);
  if (side === 'short') caps.push(['short exposure', L.maxShortExposure - shortExposure(state)]);
  let best = caps[0];
  for (const c of caps) if (c[1] < best[1]) best = c;
  return { dollars: Math.max(0, best[1]), binding: best[0] };
}

/** Shares for an entry: the conviction's risk over the stop distance, then every cap → { shares, riskUsd, notional, capped }. */
export function size({ price, stop, conviction = null, style = 'day', side = 'long', riskPctOverride = null }, state, L = LIMITS) {
  const capped = [];
  const dist = Math.abs(price - stop);
  if (!(price > 0) || !(stop > 0) || !(dist > 0)) return { shares: 0, riskUsd: 0, notional: 0, capped: ['no valid stop'] };
  const pct = riskPctOverride != null ? Math.min(Math.max(riskPctOverride, L.riskMinPct), L.riskMaxPct) : riskPct(conviction, L);
  let shares = Math.floor(L.book * pct / 100 / dist);
  const r = room(state, { style, side }, L);
  const maxByRoom = Math.floor(r.dollars / price);
  if (maxByRoom < shares) { shares = maxByRoom; capped.push(r.binding); }
  if (shares < 1) return { shares: 0, riskUsd: 0, notional: 0, capped: capped.length ? capped : ['under one share at this risk'] };
  return { shares, riskUsd: +(shares * dist).toFixed(2), notional: +(shares * price).toFixed(2), riskPct: +pct.toFixed(4), capped };
}

/** Is the day over for this position? Long day trades by 15:55, shorts by 15:50 (half days 12:55 / 12:50); a spec's
 *  earlier flattenBy wins. Swing and invest positions never flatten on time. */
export function flattenDue(p, nyMinutes, { half = false, flattenBy = null } = {}) {
  if (p.style !== 'day' && p.side !== 'short') return false;
  const table = half ? FLATTEN_HALF : FLATTEN;
  let at = hhmm(p.side === 'short' ? table.short : table.long);
  const own = hhmm(flattenBy);
  if (own != null && own < at) at = own;
  return nyMinutes >= at;
}

/** The loss guards → { state: 'ok' | 'pause' | 'halt', why }. Halt wins: no new entries until Tony resumes. */
export function guard(state, L = LIMITS) {
  if (state.halted) return { state: 'halt', why: 'halted (kill switch or a drawdown halt); only Tony resumes' };
  if (state.peak > 0 && state.equity != null && state.equity <= state.peak * (1 - L.drawdownPct / 100))
    return { state: 'halt', why: `drawdown ${((1 - state.equity / state.peak) * 100).toFixed(1)}% from the peak $${state.peak.toFixed(2)} (limit ${L.drawdownPct}%)` };
  if (state.paused) return { state: 'pause', why: 'paused' };
  if (state.dayPnl != null && state.dayPnl <= -L.book * L.dailyLossPct / 100)
    return { state: 'pause', why: `today's loss $${(-state.dayPnl).toFixed(2)} reached ${L.dailyLossPct}% of the $${L.book} book` };
  return { state: 'ok', why: '' };
}

/**
 * Can this entry go out? order = { sym, side, qty, price, stop, style, strategy }; ctx = { nyMinutes, half, window,
 * flattenBy, earningsSoon } → { ok, why }. `why` is the first reason in words (it goes to the journal as a skip).
 */
export function checkEntry(o, state, L = LIMITS, ctx = {}) {
  const no = (why) => ({ ok: false, why });
  const g = guard(state, L);
  if (g.state !== 'ok') return no(g.why);
  if (o.side !== 'long' && o.side !== 'short') return no(`the side must be long or short, not ${o.side}`);
  if (!(o.qty >= 1) || !Number.isInteger(o.qty)) return no('the size is not a whole number of shares');
  if (!(o.price > 0)) return no('no price');
  const long = o.side === 'long';
  if (o.side === 'short') {
    if (!L.shortsAllowed) return no('shorts are switched off');
    if (o.style !== 'day') return no('a short is a day trade only');
  }
  if (L.stopRequired || o.style === 'day' || o.side === 'short') {
    if (!(o.stop > 0)) return no('every position needs a stop');
    if (long ? o.stop >= o.price : o.stop <= o.price) return no(`the stop ${o.stop} is on the wrong side of ${o.price}`);
  }
  const held = (state.positions || []).find((p) => p.sym === o.sym);
  if (held) return no(held.strategy === o.strategy ? `${o.sym} is already held by this strategy` : `${o.sym} is held by ${held.strategy || 'another strategy'} (one strategy per symbol)`);
  if ((state.positions || []).length >= L.maxPositions) return no(`${L.maxPositions} positions open (the cap)`);
  const n = o.qty * o.price;
  if (n > L.maxPosition + 1e-9) return no(`$${n.toFixed(2)} is over the $${L.maxPosition} per-position cap`);
  if (deployed(state) + n > L.maxDeployed + 1e-9) return no(`would deploy $${(deployed(state) + n).toFixed(2)}, over the $${L.maxDeployed} cap`);
  if (o.style && L.styleShare[o.style] != null && styleDeployed(state, o.style) + n > L.styleShare[o.style] * L.maxDeployed + 1e-9)
    return no(`over the ${o.style} share ($${(L.styleShare[o.style] * L.maxDeployed).toFixed(0)})`);
  if (o.side === 'short' && shortExposure(state) + n > L.maxShortExposure + 1e-9) return no(`over the $${L.maxShortExposure} short exposure cap`);
  if (o.stop > 0) {
    const risk = o.qty * Math.abs(o.price - o.stop), most = L.book * L.riskMaxPct / 100;
    if (risk > most + 0.005) return no(`risks $${risk.toFixed(2)}, over ${L.riskMaxPct}% of the book ($${most.toFixed(2)})`);
  }
  if (ctx.earningsSoon) return no(`${o.sym} reports earnings today or next trading day (blackout)`);
  if (ctx.nyMinutes != null) {
    const w = ctx.window;
    if (w && (ctx.nyMinutes < hhmm(w.start) || ctx.nyMinutes >= hhmm(w.end))) return no(`outside the entry window ${w.start}-${w.end}`);
    if (flattenDue({ style: o.style, side: o.side }, ctx.nyMinutes, { half: ctx.half, flattenBy: ctx.flattenBy })) return no('past the time day trades must be flat');
  }
  return { ok: true, why: '' };
}
