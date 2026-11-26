// COPY of A1-Priv TradeHub/core/gate.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// The Neo Gate (docs/TradeHub/quant/n4-03.md): "Neo confirms and edits". Every spec the
// strategist proposes is re-tested by code, clamped to Tony's hard limits with each edit
// logged, and passed or refused by the pass gate with its numbers. Pure; the research
// runner (tools/strat) and the bot (N4) run the same file.
//
//   clampSpec(spec, limits, ctx) → { spec, edits: [{ field, from, to, why }], refused: [why] }
//   passGate(report, gate)       → { pass, reasons: [why] }   report from tools/strat/backtest.mjs
//   deflatedSharpe(returns, { trials, srVariance }) → probability 0..1 the true Sharpe beats the best of `trials` nulls
//   correlation(a, b)            → Pearson of two [[t, r]] daily return series on their common days (null under 20)
import { checkStrategy, withDefaults, isStop, isTime, BOT_MAX_SYMBOLS, BOT_RISK_BAND, STRATEGY_V2 } from './strategy.js';
import { LIMITS } from './risk-book.js';

export const GATE = Object.freeze({ minTrades: 30, minPF: 1.2, maxDD: 0.15, minDSR: 0.5, maxCorr: 0.7, minOverlap: 20 });
export const DEFAULT_STOP = Object.freeze({ stop: 'atr', value: 1.5 }), DEFAULT_SWING_HOLD = 10;
const EULER = 0.5772156649015329;

/* ── statistics ─────────────────────────────────────────────────────────── */
/** The standard normal CDF (Abramowitz-Stegun 7.1.26 through erf; |error| < 1.5e-7). */
export function normCdf(x) {
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
/** The standard normal quantile (Acklam's rational approximation; |error| < 1.2e-9). */
export function normInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * The deflated Sharpe ratio (Bailey and López de Prado, 2014) of per-period returns, as a probability: how likely
 * the true Sharpe is above the best a `trials`-many search would find by luck. Per-period (not annualised) Sharpe;
 * skew and kurtosis from the returns; `srVariance` = the variance of the Sharpe across the variants tried (unknown →
 * 1 / (T − 1), the null's). null under 10 returns or with no variation.
 */
export function deflatedSharpe(r, { trials = 1, srVariance = null } = {}) {
  const T = r.length;
  if (T < 10) return null;
  const m = r.reduce((s, x) => s + x, 0) / T, sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (T - 1));
  if (!(sd > 0)) return null;
  const sr = m / sd;
  const skew = r.reduce((s, x) => s + ((x - m) / sd) ** 3, 0) / T, kurt = r.reduce((s, x) => s + ((x - m) / sd) ** 4, 0) / T;
  const n = Math.max(1, Math.round(trials)), v = srVariance != null ? srVariance : 1 / (T - 1);
  const sr0 = n === 1 ? 0 : Math.sqrt(v) * ((1 - EULER) * normInv(1 - 1 / n) + EULER * normInv(1 - 1 / (n * Math.E)));
  const den = 1 - skew * sr + (kurt - 1) / 4 * sr * sr;
  if (!(den > 0)) return null;
  return normCdf((sr - sr0) * Math.sqrt(T - 1) / Math.sqrt(den));
}

/** Pearson correlation of two [[t, value]] series on the times both have; null under `minOverlap` common points. */
export function correlation(a, b, { minOverlap = GATE.minOverlap } = {}) {
  const mb = new Map(b);
  const xs = [], ys = [];
  for (const [t, v] of a) if (mb.has(t) && Number.isFinite(v) && Number.isFinite(mb.get(t))) { xs.push(v); ys.push(mb.get(t)); }
  if (xs.length < minOverlap) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/* ── the clamp ──────────────────────────────────────────────────────────── */
/**
 * `spec` brought inside the hard limits → { spec, edits, refused }. Every change is an edit with a reason in words;
 * what cannot be fixed by an edit (both sides, no symbols left, an unsupported indicator) is refused with
 * checkStrategy's reasons. ctx = { today, earningsWithin(sym, tradingDays) → bool } (the blackout through the longest hold).
 */
export function clampSpec(raw, L = LIMITS, ctx = {}) {
  // Defaults first ("do whatever is best" for what the strategist left out), then the limits. ctx.today fills `to`.
  const spec = withDefaults({ ...JSON.parse(JSON.stringify(raw || {})), v: STRATEGY_V2 }, { today: ctx.today || null }).spec, edits = [];
  if (raw && raw.v !== STRATEGY_V2) edits.push({ field: 'v', from: raw.v ?? null, to: STRATEGY_V2, why: 'the bot runs v2 strategies' });
  const edit = (field, from, to, why) => edits.push({ field, from, to, why });
  if (spec.side === 'short' && spec.horizon !== 'day') {
    edit('horizon', spec.horizon, 'day', 'a short is a day trade only (your rule)');
    spec.horizon = 'day';
    if (!spec.timeframe || spec.timeframe === '1d') { edit('timeframe', spec.timeframe, '5m', 'a day trade needs intraday bars'); spec.timeframe = '5m'; }
  }
  if (spec.side === 'short' && L.shortsAllowed === false) return { spec, edits, refused: ['shorts are switched off'] };
  spec.exit = spec.exit && Array.isArray(spec.exit.any) ? spec.exit : { any: [] };
  if (!spec.exit.any.some(isStop)) { spec.exit.any.unshift({ ...DEFAULT_STOP }); edit('exit.stop', null, '1.5 ATR', 'every position has a stop resting at the broker'); }
  if (spec.horizon === 'swing' && !spec.exit.any.some(isTime)) { spec.exit.any.push({ bars: DEFAULT_SWING_HOLD }); edit('exit.time', null, `${DEFAULT_SWING_HOLD} bars`, 'a swing needs a longest hold'); }
  const lo = Math.max(L.riskMinPct, BOT_RISK_BAND.min), hi = Math.min(L.riskMaxPct, BOT_RISK_BAND.max);
  const s = spec.sizing || {};
  if (s.kind === 'conviction') {
    const nmin = Math.min(Math.max(+s.min || lo, lo), hi), nmax = Math.min(Math.max(+s.max || hi, nmin), hi);
    if (nmin !== s.min || nmax !== s.max) { edit('sizing', `${s.min}-${s.max}%`, `${nmin}-${nmax}%`, `risk per trade stays inside your ${lo}-${hi}% band`); spec.sizing = { kind: 'conviction', min: nmin, max: nmax }; }
  } else if (s.kind === 'fixedRisk' && s.value >= lo && s.value <= hi) {
    // inside the band: kept
  } else {
    edit('sizing', s.kind ? `${s.kind} ${s.value ?? ''}`.trim() : null, `conviction ${lo}-${hi}%`, 'the bot sizes by measured conviction inside your band');
    spec.sizing = { kind: 'conviction', min: lo, max: hi };
  }
  if (!(Number.isInteger(spec.maxPositions) && spec.maxPositions <= L.maxPositions)) {
    edit('maxPositions', spec.maxPositions ?? null, Math.min(L.maxPositions, Number.isInteger(spec.maxPositions) ? spec.maxPositions : L.maxPositions), `at most ${L.maxPositions} positions`);
    spec.maxPositions = Math.min(L.maxPositions, Number.isInteger(spec.maxPositions) && spec.maxPositions > 0 ? spec.maxPositions : L.maxPositions);
  }
  if (spec.earningsBlackout !== true) { if (spec.earningsBlackout === false) edit('earningsBlackout', false, true, 'no new entry into earnings (your rule)'); spec.earningsBlackout = true; }
  if (spec.rebalance && spec.rebalance !== 'none') { edit('rebalance', spec.rebalance, 'none', 'the bot does not rebalance'); spec.rebalance = 'none'; }
  const u = spec.universe || {};
  let syms = Array.isArray(u.symbols) ? [...new Set(u.symbols.map((x) => String(x).toUpperCase()))] : [];
  if (syms.length > BOT_MAX_SYMBOLS) { edit('universe', syms.length + ' symbols', BOT_MAX_SYMBOLS + ' symbols', `at most ${BOT_MAX_SYMBOLS} symbols`); syms = syms.slice(0, BOT_MAX_SYMBOLS); }
  if (ctx.earningsWithin) {
    const hold = spec.horizon === 'day' ? 1 : spec.horizon === 'swing' ? ((spec.exit.any.find(isTime) || {}).bars || DEFAULT_SWING_HOLD) : 20;
    const dropped = syms.filter((x) => ctx.earningsWithin(x, hold));
    if (dropped.length) { edit('universe', dropped.join(', '), 'dropped', `earnings inside the ${hold}-day hold`); syms = syms.filter((x) => !dropped.includes(x)); }
  }
  spec.universe = { symbols: syms };
  const chk = checkStrategy(spec, { bot: true });
  return { spec, edits, refused: chk.ok ? [] : chk.errors };
}

/* ── the pass gate ──────────────────────────────────────────────────────── */
/**
 * report = { trades, profitFactor, oosExpectancy, oosCagr, maxDD (negative), fragile, dsr, maxCorr } → { pass, reasons }.
 * Each failed rule is one reason with the number that failed it.
 */
export function passGate(rep, G = GATE) {
  const why = [];
  const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));
  if (!(rep.trades >= G.minTrades)) why.push(`${rep.trades ?? 0} trades, under the ${G.minTrades} needed`);
  if (!(rep.oosExpectancy > 0) || (rep.oosCagr != null && !(rep.oosCagr > 0))) why.push(`not profitable out of sample after costs (expectancy ${f2(rep.oosExpectancy)})`);
  if (!(rep.profitFactor >= G.minPF)) why.push(`profit factor ${f2(rep.profitFactor)}, under ${G.minPF}`);
  if (!(Math.abs(rep.maxDD ?? 1) <= G.maxDD)) why.push(`drawdown ${(Math.abs(rep.maxDD ?? 1) * 100).toFixed(1)}%, over ${G.maxDD * 100}%`);
  if (rep.fragile) why.push('fragile: a nearby setting stops it working');
  if (!(rep.dsr >= G.minDSR)) why.push(`deflated Sharpe ${f2(rep.dsr)}, under ${G.minDSR} for the variants tried`);
  if (rep.maxCorr != null && rep.maxCorr > G.maxCorr) why.push(`${f2(rep.maxCorr)} correlated with an active strategy (over ${G.maxCorr})`);
  return { pass: !why.length, reasons: why };
}
