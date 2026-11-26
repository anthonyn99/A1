// COPY of A1-Priv TradeHub/core/metrics.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Every number a backtest reports (docs/TradeHub/quant/phase-06.md, "Results"),
// worked out by code from the trades and the equity curve; never written by
// the AI. Pure; the bootstrap draws from a seeded generator.
//
// Formulas (the golden test checks them against pandas, tools/quant-golden.py):
//   returns     r_i = v_i / v_{i−1} − 1 on the daily curve (an intraday curve
//               is sampled at each New York day's last point first)
//   CAGR        (v_end / v_0)^(1 / years) − 1, years = (t_end − t_0) / 365.25 days
//   drawdown    v / running max(v) − 1; max drawdown = its minimum
//   Sharpe      mean(r) / sd(r) · √252 (sample sd, no risk-free rate)
//   Sortino     mean(r) / √mean(min(r, 0)²) · √252
//   Calmar      CAGR / |max drawdown|
import { nyClock } from './clock.js';
import { rng, bootstrapMean } from './fit.js';

export const PERIODS = 252, YEAR_MS = 365.25 * 86_400_000, OOS_SHARE = 0.3, SMALL = 30, RESAMPLES = 1000;

/** At most `max` points of a curve: every k-th and the last (k chosen so the last never makes it max + 1). */
export function thinCurve(c, max) {
  if (!c || c.length <= max) return c || [];
  const k = Math.ceil(c.length / (max - 1));
  return c.filter((p, i) => i % k === 0 || i === c.length - 1);
}

/** The curve with one point per New York day (its last), for an intraday run. */
export function dailyCurve(equity, intraday = false) {
  if (!intraday) return equity;
  const out = [];
  let day = '';
  for (const p of equity) { const d = nyClock(p[0]).date; if (d === day) out[out.length - 1] = p; else { out.push(p); day = d; } }
  return out;
}
/** Period returns of a curve [[t, v]]. */
export const returnsOf = (eq) => eq.slice(1).map((p, i) => p[1] / eq[i][1] - 1);
/** Total return. */
export const totalReturn = (eq) => (eq.length > 1 ? eq[eq.length - 1][1] / eq[0][1] - 1 : null);
/** CAGR (see the top). */
export function cagr(eq) {
  if (eq.length < 2) return null;
  const years = (eq[eq.length - 1][0] - eq[0][0]) / YEAR_MS, g = eq[eq.length - 1][1] / eq[0][1];
  return years > 0 && g > 0 ? Math.pow(g, 1 / years) - 1 : null;
}
/** Max drawdown → `{ dd, peakT, troughT, recoveredT, length }`; `length` = points
 *  from the peak to the recovery (or to the end when it never recovered). */
export function maxDrawdown(eq) {
  let peak = -Infinity, peakI = 0, best = { dd: 0, peakT: null, troughT: null, recoveredT: null, length: 0 }, bestPeak = 0;
  eq.forEach(([t, v], i) => {
    if (v > peak) { peak = v; peakI = i; }
    const dd = v / peak - 1;
    if (dd < best.dd) { best = { dd, peakT: eq[peakI][0], troughT: t, recoveredT: null, length: 0 }; bestPeak = peakI; }
  });
  if (best.troughT != null) {
    const top = eq[bestPeak][1];
    let k = eq.findIndex((p) => p[0] > best.troughT && p[1] >= top);
    best.recoveredT = k >= 0 ? eq[k][0] : null;
    best.length = (k >= 0 ? k : eq.length - 1) - bestPeak;
  }
  return best;
}
/** The drawdown at every point: [[t, v / max − 1]]. */
export function underwater(eq) { let m = -Infinity; return eq.map(([t, v]) => { m = Math.max(m, v); return [t, v / m - 1]; }); }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
/** Sharpe (see the top); null under 2 returns or with no variation. */
export function sharpe(r) {
  if (r.length < 2) return null;
  const m = mean(r), sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1));
  return sd > 0 ? m / sd * Math.sqrt(PERIODS) : null;
}
/** Sortino (see the top); null with no losing period. */
export function sortino(r) {
  if (!r.length) return null;
  const dd = Math.sqrt(r.reduce((s, x) => s + Math.min(x, 0) ** 2, 0) / r.length);
  return dd > 0 ? mean(r) / dd * Math.sqrt(PERIODS) : null;
}
/** Calmar. */
export const calmar = (g, dd) => (g != null && dd < 0 ? g / Math.abs(dd) : null);

/** Returns by month or year → `[{ key, y, m?, r }]`: each period's last value
 *  over the one before it (the first over the curve's start). */
export function periodReturns(eq, kind = 'month') {
  const out = [];
  let key = null, prev = eq.length ? eq[0][1] : null, last = null;
  for (const [t, v] of eq) {
    const d = nyClock(t).date, k = kind === 'year' ? d.slice(0, 4) : d.slice(0, 7);
    if (k !== key) { if (key != null) { out.push(row(key, last / prev - 1)); prev = last; } key = k; }
    last = v;
  }
  if (key != null) out.push(row(key, last / prev - 1));
  function row(k, r) { return { key: k, y: Number(k.slice(0, 4)), m: kind === 'year' ? null : Number(k.slice(5, 7)), r }; }
  return out;
}
/** The rolling 12-month return at each point: v_t / v_(the last point a year or more before) − 1. */
export function rolling12(eq) {
  const out = [];
  let j = 0;
  for (let i = 0; i < eq.length; i++) {
    while (j + 1 < i && eq[j + 1][0] <= eq[i][0] - YEAR_MS) j++;
    if (eq[i][0] - eq[j][0] >= YEAR_MS - 5 * 86_400_000) out.push([eq[i][0], eq[i][1] / eq[j][1] - 1]);
  }
  return out;
}

/** The trades' numbers → `{ n, wins, losses, winRate, avgWin, avgLoss, avgWinR,
 *  avgLossR, profitFactor, expectancy, expectancyR, nR, avgBars, best, worst,
 *  longestLosing, small }` (money in dollars; R only over trades with a stop). */
export function tradeStats(trades) {
  const n = trades.length, w = trades.filter((t) => t.pnl > 0), l = trades.filter((t) => t.pnl <= 0);
  const sum = (a, f) => a.reduce((s, t) => s + f(t), 0);
  const withR = trades.filter((t) => Number.isFinite(t.r)), wR = withR.filter((t) => t.r > 0), lR = withR.filter((t) => t.r <= 0);
  let run = 0, longest = 0;
  for (const t of [...trades].sort((a, b) => a.exitT - b.exitT)) { run = t.pnl <= 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  const gw = sum(w, (t) => t.pnl), gl = -sum(l, (t) => t.pnl);
  const by = (f) => (n ? trades.reduce((a, b) => (f(b) > f(a) ? b : a)) : null);
  return {
    n, wins: w.length, losses: l.length, winRate: n ? w.length / n : null,
    avgWin: w.length ? gw / w.length : null, avgLoss: l.length ? -gl / l.length : null,
    avgWinR: wR.length ? sum(wR, (t) => t.r) / wR.length : null, avgLossR: lR.length ? sum(lR, (t) => t.r) / lR.length : null,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : null,
    expectancy: n ? sum(trades, (t) => t.pnl) / n : null, expectancyR: withR.length ? sum(withR, (t) => t.r) / withR.length : null, nR: withR.length,
    avgBars: n ? sum(trades, (t) => t.bars) / n : null,
    best: by((t) => t.ret), worst: by((t) => -t.ret), longestLosing: longest, small: n < SMALL,
  };
}
/** Trades grouped by `keyOf` → `[{ key, n, pnl, winRate, expectancyR, small }]`, most profit first. */
export function breakdown(trades, keyOf) {
  const m = new Map();
  for (const t of trades) { const k = keyOf(t) == null ? 'Unknown' : String(keyOf(t)); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
  return [...m].map(([key, list]) => { const s = tradeStats(list); return { key, n: s.n, pnl: list.reduce((a, t) => a + t.pnl, 0), winRate: s.winRate, expectancyR: s.expectancyR, small: s.small }; })
    .sort((a, b) => b.pnl - a.pnl || a.key.localeCompare(b.key));
}
/** A bootstrap 95% interval of a mean → [lo, hi] (fit.js bootstrapMean, the scorecard's). */
function ciMean(xs, random, B) {
  if (xs.length < 2 || !(B > 0)) return [null, null];
  const b = bootstrapMean(xs, { resamples: B, random });
  return [b.lo, b.hi];
}
/** A bootstrap 95% interval of CAGR from the daily returns resampled → [lo, hi]. */
function ciCagr(r, years, random, B) {
  if (r.length < 20 || !(years > 0) || !(B > 0)) return [null, null];
  const out = new Float64Array(B), n = r.length;
  for (let b = 0; b < B; b++) { let lg = 0; for (let i = 0; i < n; i++) lg += Math.log1p(r[(random() * n) | 0]); out[b] = Math.exp(lg / years) - 1; }
  out.sort();
  return [out[Math.round(0.025 * (B - 1))], out[Math.round(0.975 * (B - 1))]];
}

/** Curve numbers of one stretch (rebased) → `{ total, cagr, dd, sharpe, sortino, calmar, days }`. */
function curveNumbers(eq) {
  const r = returnsOf(eq), g = cagr(eq), dd = maxDrawdown(eq);
  return { total: totalReturn(eq), cagr: g, dd: dd.dd, ddLength: dd.length, sharpe: sharpe(r), sortino: sortino(r), calmar: calmar(g, dd.dd), days: eq.length };
}

/**
 * Everything the results show →
 *   { curve, bench, hold, trades, exposure, monthly, yearly, rolling, underwater,
 *     bySymbol, bySector, byRegime, byYear, ci: { expectancyR, expectancy, cagr },
 *     inSample, outOfSample, holdsUp, splitT, verdict, notes }
 *   run      simulate()'s result; bench, hold = [[t, v]] on the same times
 *   intraday whether the curve is intraday (sampled to days for the ratios)
 */
export function metrics(run, { bench = [], hold = [], intraday = false, seed = 7, resamples = RESAMPLES, benchName = 'SPY' } = {}) {
  const eq = dailyCurve(run.equity, intraday), bq = dailyCurve(bench, intraday), hq = dailyCurve(hold, intraday);
  const random = rng(seed), r = returnsOf(eq), years = eq.length > 1 ? (eq[eq.length - 1][0] - eq[0][0]) / YEAR_MS : 0;
  const trades = tradeStats(run.trades);
  const exposed = run.exposure.length ? run.exposure.filter((x) => x[1] > 0).length / run.exposure.length : null;
  const splitT = eq.length ? eq[0][0] + (1 - OOS_SHARE) * (eq[eq.length - 1][0] - eq[0][0]) : null;
  const cut = (c, a, b) => c.filter((p) => p[0] >= a && p[0] <= b);
  const ins = curveNumbers(cut(eq, -Infinity, splitT)), outs = curveNumbers(cut(eq, splitT, Infinity));
  const insT = tradeStats(run.trades.filter((t) => t.entryT < splitT)), outT = tradeStats(run.trades.filter((t) => t.entryT >= splitT));
  const curve = curveNumbers(eq), benchN = curveNumbers(bq), holdN = curveNumbers(hq);
  const holdsUp = outT.n === 0 ? null : (outs.cagr == null || outs.cagr > 0) && (outT.expectancyR == null ? outT.expectancy > 0 : outT.expectancyR > 0);
  const year = (t) => nyClock(t).date.slice(0, 4);
  const out = {
    curve, bench: benchN, hold: holdN, benchName, years, trades, exposure: exposed,
    monthly: periodReturns(eq, 'month'), yearly: periodReturns(eq, 'year'), benchYearly: periodReturns(bq, 'year'),
    rolling: rolling12(eq), underwater: underwater(eq),
    bySymbol: breakdown(run.trades, (t) => t.symbol), bySector: breakdown(run.trades, (t) => t.sector),
    byRegime: breakdown(run.trades, (t) => t.regime), byYear: breakdown(run.trades, (t) => year(t.entryT)),
    ci: {
      expectancyR: ciMean(run.trades.filter((t) => Number.isFinite(t.r)).map((t) => t.r), random, resamples),
      expectancy: ciMean(run.trades.map((t) => t.pnl), random, resamples),
      cagr: ciCagr(r, years, random, resamples),
    },
    inSample: { ...ins, trades: insT }, outOfSample: { ...outs, trades: outT }, splitT, holdsUp,
  };
  out.verdict = verdictLine(out);
  return out;
}

const p1 = (x) => (Math.abs(x * 100) >= 10 ? Math.abs(x * 100).toFixed(0) : Math.abs(x * 100).toFixed(1));
/** The one-line plain verdict, written by code from the numbers. */
export function verdictLine(m) {
  const parts = [];
  if (m.curve.cagr != null && m.bench.cagr != null) {
    const d = m.curve.cagr - m.bench.cagr;
    const ddWord = m.curve.dd > m.bench.dd ? 'a shallower' : m.curve.dd < m.bench.dd ? 'a deeper' : 'the same';
    parts.push(`${d >= 0 ? 'Beat' : 'Trailed'} ${m.benchName} by ${p1(d)}% a year with ${ddWord} drawdown`);
  } else if (m.curve.total != null) parts.push(`${m.curve.total >= 0 ? 'Made' : 'Lost'} ${p1(m.curve.total)}% in all`);
  parts.push(`${m.trades.n} trade${m.trades.n === 1 ? '' : 's'}${m.trades.small ? ' (a small sample)' : ''}`);
  if (m.holdsUp != null) parts.push(m.holdsUp ? 'holds up out of sample' : 'does not hold up out of sample');
  return parts.join('; ') + '.';
}

/** Is the result fragile? `base` and `nudged` = [{ label, dir, cagr, expectancyR }]:
 *  fragile when a ±20% nudge turns a positive expectancy negative or halves CAGR. */
export function fragility(base, nudged) {
  const bad = nudged.filter((x) => (base.expectancyR > 0 && x.expectancyR != null && x.expectancyR <= 0) || (base.cagr > 0 && x.cagr != null && x.cagr < base.cagr / 2));
  return { fragile: bad.length > 0, culprits: [...new Set(bad.map((x) => x.label))] };
}
