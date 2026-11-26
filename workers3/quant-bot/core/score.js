// COPY of A1-Priv TradeHub/core/score.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// A candidate setup → a signal: factors, the score, entry / stop / targets,
// expiry, the verdict (GO / WATCH / NO-GO), the size and the reasons
// (docs/TradeHub/quant/phase-05.md). Pure. Algorithms decide here; nothing
// from his trading rules is ever an input.
//
// evaluate(cand, ctx, stats?) → Signal. ctx:
//   symbol, main (the bars the detector read: 5-minute or daily), i (its bar),
//   daily (daily bars: the higher timeframe of a day setup, accumulation days,
//   the ATR percentile), levels (core/levels.js: the daily levels as of the
//   session before for a day setup, as of the bar for a swing one),
//   regime { score, label } | null, rs { rank, vsSector } | null,
//   events [{ t, ticker, high, name }] | null (null = calendar not known),
//   eventEdge (the setup's measured edge ratio on event days; 0.5 until Phase 6),
//   now (when the signal is made).
//   calibration (Phase 6, optional): the measured table (core/fit.js); it
//   gives the setup's fitted weights and its stats in the signal's regime.
// stats = { n, wins, avgWinR, avgLossR, p0, costR, bucketN?, significant? } for
// this setup and regime (or from ctx.calibration); without either the verdict
// uses the score alone.
import { sma, rsi, atr, relVolume, percentRank } from './indicators.js';
import { prepDay, BAR_MS } from './detect-day.js';
import { nyClock, nyMidnight, CLOSE, HALF_CLOSE } from './clock.js';
import { isTradingDay, addDays, nyseHalfDays } from './holidays.js';
import { toWeekly, mondayOf } from './weekly.js';

export const WEIGHTS = { trend: 0.20, momentum: 0.12, rs: 0.14, volume: 0.14, vol: 0.06, structure: 0.14, regime: 0.14, event: 0.06 };
export const FACTORS = Object.keys(WEIGHTS);
// Until Phase 6 has measured a setup: the score alone.
export const GO_SCORE = 72, NOGO_SCORE = 45;
// Once measured: expected value in R.
export const EV_GO = 0.25, N_GO = 30, SCORE_GO = 65, T1_GO = 1.2, T1_NOGO = 0.8, HOSTILE = 30, SHRINK_K = 20;
export const ZONE_BELOW = 0.15, ZONE_ABOVE = 0.10, ZONE_WIDEN = 0.2;
export const STOP_PAD = 0.25, STOP_MIN = 0.6, STOP_MAX = 2.2;
export const T1_NONE_R = 1.5, T2_NONE_R = 3;
export const DAY_HOLD_MS = 90 * 60_000, DAY_CUTOFF_MIN = 15, SWING_SESSIONS = 5;
export const RISK_CAP = 0.01, POSITION_CAP = 0.20;
export const ROOM_FULL_ATR = 3;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const DAY_MS = 86_400_000;

const serCache = new WeakMap();
/** Series over a run of bars, worked out once (cached per array). */
function series(bars) {
  let s = serCache.get(bars);
  if (s) return s;
  const c = bars.map((b) => b.c), a = atr(bars, 14);
  s = { c, s20: sma(c, 20), s50: sma(c, 50), s200: sma(c, 200), rsi: rsi(c, 14), atr: a, rv: relVolume(bars, 20),
    atrRank: percentRank(a.map((x, i) => (x == null ? null : x / c[i])), 100) };
  serCache.set(bars, s);
  return s;
}
/** The last index of `bars` that opened before `t`, or -1. */
function lastBefore(bars, t) {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t < t) lo = m + 1; else hi = m; }
  return lo - 1;
}
const weekCache = new WeakMap();
function weeklyOf(daily) { let w = weekCache.get(daily); if (!w) weekCache.set(daily, w = toWeekly(daily)); return w; }

/** How far bar i's closes and averages agree with `dir`, 0 to 1: above the
 *  20, 50 and 200 average and a rising 50 (each that is known counts). */
export function trendOn(bars, i, dir) {
  if (!bars || i < 0 || i >= bars.length) return null;
  const s = series(bars), c = s.c[i], checks = [];
  if (s.s20[i] != null) checks.push(c > s.s20[i]);
  if (s.s50[i] != null) checks.push(c > s.s50[i]);
  if (s.s200[i] != null) checks.push(c > s.s200[i]);
  if (s.s50[i] != null && i >= 5 && s.s50[i - 5] != null) checks.push(s.s50[i] > s.s50[i - 5]);
  if (!checks.length) return null;
  const up = checks.filter(Boolean).length / checks.length;
  return dir === 'long' ? up : 1 - up;
}
/** RSI read for `dir`: 50 to 70 is best for a long, stretched and weak score lower. */
export function rsiRead(r, dir) {
  if (r == null) return 0.5;
  const x = dir === 'long' ? r : 100 - r;
  if (x < 30) return 0.1;
  if (x < 50) return 0.1 + 0.5 * (x - 30) / 20;
  if (x <= 70) return 0.6 + 0.4 * (x - 50) / 20;
  if (x <= 85) return 1 - 0.4 * (x - 70) / 15;
  return 0.6;
}

/** When a signal stops being valid: a day setup 90 minutes after its bar
 *  closes or 15 minutes before the close (15:45; 12:45 on a half day),
 *  whichever is first; a swing setup at the close of the 5th session after. */
export function expiryOf(cand) {
  const date = nyClock(cand.at + (cand.horizon === 'day' ? 0 : 12 * 3_600_000)).date;
  const closeMin = (d) => (nyseHalfDays(Number(d.slice(0, 4))).has(d) ? HALF_CLOSE : CLOSE);
  if (cand.horizon === 'day') return Math.min(cand.at + BAR_MS + DAY_HOLD_MS, nyMidnight(date) + (closeMin(date) - DAY_CUTOFF_MIN) * 60_000);
  let d = date, n = 0;
  while (n < SWING_SESSIONS) { d = addDays(d, 1); if (isTradingDay(d)) n++; }
  return nyMidnight(d) + closeMin(d) * 60_000;
}

/** Where to get in, where it is wrong, where to take profit →
 *  `{ zone: [lo, hi], entry, stop, risk, targets: [t1, t2], rr: [r1, r2] }`.
 *  `a` = the ATR of the setup's own timeframe; `vwapNow` widens a day zone.
 *  Zone: trigger − 0.15 ATR to + 0.10 ATR (mirrored for a short), widened to
 *  VWAP or the setup's level when either is within 0.2 ATR of it. Stop: the
 *  invalidation ∓ 0.25 ATR, 0.6 to 2.2 ATR from the zone's middle. T1: the
 *  nearest opposing Medium or Strong level when it is nearer than 1 R, else
 *  1.5 R; T2: the next level beyond T1, else 3 R. */
export function planOf(cand, levels, a, vwapNow = null) {
  const long = cand.dir === 'long', sgn = long ? 1 : -1, t = cand.trigger;
  let lo = long ? t - ZONE_BELOW * a : t - ZONE_ABOVE * a, hi = long ? t + ZONE_ABOVE * a : t + ZONE_BELOW * a;
  for (const x of [vwapNow, cand.structure && cand.structure.ref]) {
    if (x == null || !Number.isFinite(x)) continue;
    if (x < lo && lo - x <= ZONE_WIDEN * a) lo = x;
    if (x > hi && x - hi <= ZONE_WIDEN * a) hi = x;
  }
  const entry = (lo + hi) / 2;
  const inv = cand.structure && Number.isFinite(cand.structure.invalid) ? cand.structure.invalid : entry - sgn * STOP_MIN * a;
  const raw = (entry - (inv - sgn * STOP_PAD * a)) * sgn;
  const risk = Math.min(STOP_MAX * a, Math.max(STOP_MIN * a, raw));
  const stop = entry - sgn * risk;
  // Opposing Medium and Strong levels beyond the zone, nearest first.
  const edge = (l) => (long ? (l.lo == null ? l.price : l.lo) : (l.hi == null ? l.price : l.hi));
  const ahead = [...((levels && levels.supports) || []), ...((levels && levels.resistances) || [])]
    .filter((l) => l.rank !== 'Weak')
    .map((l) => ({ l, p: edge(l), d: (edge(l) - entry) * sgn }))
    .filter((x) => x.p * sgn > (long ? hi : -lo))
    .sort((x, y) => x.d - y.d);
  let t1, next;
  if (ahead.length && ahead[0].d < risk) { t1 = ahead[0].p; next = ahead[1]; }
  else { t1 = entry + sgn * T1_NONE_R * risk; next = ahead.find((x) => x.d > T1_NONE_R * risk); }
  const t2 = next ? next.p : entry + sgn * T2_NONE_R * risk;
  return { zone: [lo, hi], entry, stop, risk, targets: [t1, t2], rr: [(t1 - entry) * sgn / risk, (t2 - entry) * sgn / risk] };
}

/** The eight factors, each 0 to 1 for the candidate's direction, with what
 *  they were read from (`detail`, for the reasons). */
export function factorsOf(cand, ctx, plan, expires) {
  const long = cand.dir === 'long', day = cand.horizon === 'day', detail = {};
  let own, k, higher, hk;
  const daily = ctx.daily || (day ? null : ctx.main);
  if (day) {
    const p = prepDay(ctx.main);
    own = p.bars; k = p.at[ctx.i];
    higher = daily; hk = daily ? lastBefore(daily, nyMidnight(nyClock(cand.at).date)) : -1;
    detail.rv = p.rvol[k];
  } else {
    own = ctx.main; k = ctx.i;
    const wk = weeklyOf(own), monday = mondayOf(cand.at);
    higher = wk; hk = -1;
    for (let j = wk.length - 1; j >= 0; j--) if (mondayOf(wk[j].t) < monday) { hk = j; break; }
    detail.rv = series(own).rv[k];
  }
  const dk = day ? hk : k;   // the last daily bar known when the signal is made

  const tOwn = trendOn(own, k, cand.dir), tHi = trendOn(higher, hk, cand.dir);
  const trend = tOwn == null && tHi == null ? 0.5 : tOwn == null ? tHi : tHi == null ? tOwn : 0.6 * tOwn + 0.4 * tHi;

  const so = series(own), a = so.atr[k];
  const rocA = k >= 10 && a ? (so.c[k] - so.c[k - 10]) / a : null;
  const r1 = rocA == null ? 0.5 : clamp01(0.5 + (long ? rocA : -rocA) / 4);
  detail.rsi = so.rsi[k];
  const momentum = 0.5 * r1 + 0.5 * rsiRead(so.rsi[k], cand.dir);

  const rs0 = ctx.rs || {}, sec = rs0.vsSector == null ? null : clamp01(0.5 + rs0.vsSector / 0.10);
  let rsUp = rs0.rank != null ? 0.7 * rs0.rank / 100 + 0.3 * (sec == null ? 0.5 : sec) : sec == null ? null : sec;
  detail.rank = rs0.rank;
  const rs = rsUp == null ? 0.5 : long ? rsUp : 1 - rsUp;

  const rvPart = detail.rv == null ? 0.5 : clamp01((detail.rv - 0.5) / 1.5);
  let acc = 0, dist = 0;
  if (daily && dk > 0) for (let j = Math.max(1, dk - 19); j <= dk; j++) {
    if (daily[j].v > daily[j - 1].v) { if (daily[j].c > daily[j - 1].c) acc++; else if (daily[j].c < daily[j - 1].c) dist++; }
  }
  detail.acc = acc; detail.dist = dist;
  const ad = clamp01(0.5 + (acc - dist) / 10);
  const volume = 0.6 * rvPart + 0.4 * (long ? ad : 1 - ad);

  const pr = daily && dk >= 0 ? series(daily).atrRank[dk] : null;
  detail.atrRank = pr;
  const vol = pr == null ? 0.5 : 1 - clamp01((Math.abs(pr - 0.5) - 0.2) / 0.3);

  // Room to the next opposing STRONG level, in the setup's ATRs.
  const sgn = long ? 1 : -1, atrNow = plan.risk && a ? a : null;
  let room = null;
  for (const l of [...((ctx.levels && ctx.levels.supports) || []), ...((ctx.levels && ctx.levels.resistances) || [])]) {
    if (l.rank !== 'Strong' || !atrNow) continue;
    const e = long ? (l.lo == null ? l.price : l.lo) : (l.hi == null ? l.price : l.hi), d = (e - plan.entry) * sgn;
    if (d > 0 && (room == null || d / atrNow < room)) room = d / atrNow;
  }
  detail.room = room;
  const structure = room == null ? 1 : clamp01(room / ROOM_FULL_ATR);

  const rg = ctx.regime && Number.isFinite(ctx.regime.score) ? ctx.regime.score : null;
  detail.regime = ctx.regime || null;
  const regime = rg == null ? 0.5 : long ? rg / 100 : 1 - rg / 100;

  let event = 0.5;
  if (Array.isArray(ctx.events)) {
    const from = cand.at + (day ? BAR_MS : DAY_MS);
    const hit = ctx.events.find((e) => e && e.high && (!e.ticker || e.ticker === ctx.symbol) && e.t >= from && e.t <= expires);
    detail.event = hit ? hit.name || 'a high-impact catalyst' : null;
    event = hit ? (Number.isFinite(ctx.eventEdge) ? ctx.eventEdge : 0.5) : 1;
  } else detail.event = undefined;

  return { factors: { trend, momentum, rs, volume, vol, structure, regime, event }, detail, atr: a };
}

/** `100 · Σ wᵢ·fᵢ`. */
export const scoreOf = (f, w = WEIGHTS) => 100 * FACTORS.reduce((s, k) => s + w[k] * (Number.isFinite(f[k]) ? f[k] : 0.5), 0);

/** GO / WATCH / NO-GO → `{ verdict, ev, p, n, backtested }`.
 *  With `stats`: `p = (wins + 20·p₀)/(n + 20)`, `EV = p·avgWinR − (1−p)·avgLossR − costR`;
 *  GO = EV ≥ 0.25 R, n ≥ 30 in the signal's regime bucket, an edge the
 *  calibration found significant, score ≥ 65, T1 ≥ 1.2 R and a regime that is not
 *  hostile; NO-GO = EV < 0, a hostile regime (under 30 for a long, over 70 for
 *  a short), score < 45 or T1 < 0.8 R; WATCH between.
 *  Without it ("not yet backtested"): GO = score ≥ 72 and T1 ≥ 1.2 R; NO-GO =
 *  score < 45, a hostile regime or T1 < 0.8 R; WATCH between. */
export function verdictOf({ score, rr, regimeScore, dir }, stats = null) {
  const hostile = Number.isFinite(regimeScore) && (dir === 'long' ? regimeScore < HOSTILE : regimeScore > 100 - HOSTILE);
  const t1 = rr ? rr[0] : 0;
  if (stats && stats.n > 0) {
    const p0 = Number.isFinite(stats.p0) ? stats.p0 : stats.wins / stats.n;
    const p = (stats.wins + SHRINK_K * p0) / (stats.n + SHRINK_K);
    const ev = p * stats.avgWinR - (1 - p) * stats.avgLossR - (stats.costR || 0);
    // A regime bucket with under 30 past signals, or an edge not told apart from chance, never makes GO.
    const sample = Number.isFinite(stats.bucketN) ? stats.bucketN : stats.n;
    const verdict = ev < 0 || hostile || score < NOGO_SCORE || t1 < T1_NOGO ? 'NO-GO'
      : ev >= EV_GO && sample >= N_GO && stats.significant !== false && score >= SCORE_GO && t1 >= T1_GO ? 'GO' : 'WATCH';
    return { verdict, ev, p, n: stats.n, backtested: true };
  }
  const verdict = score < NOGO_SCORE || hostile || t1 < T1_NOGO ? 'NO-GO' : score >= GO_SCORE && t1 >= T1_GO ? 'GO' : 'WATCH';
  return { verdict, ev: null, p: null, n: 0, backtested: false };
}

/** The regime bucket the calibration is kept by: on (score ≥ 50: Risk-on uptrend,
 *  Constructive), neutral (35 to 50: Choppy), off (under 35: Risk-off, Capitulation). */
export const bucketOf = (score) => (!Number.isFinite(score) ? null : score >= 50 ? 'on' : score >= 35 ? 'neutral' : 'off');
export const BUCKETS = ['on', 'neutral', 'off'];

/** verdictOf's stats for `setup` from calibration `cal` in the regime scored
 *  `regimeScore`: that bucket's measured n, wins, average win and loss (net of
 *  costs, so costR = 0), the setup's own hit rate as the prior p₀, and
 *  `bucketN` (a bucket with no history falls back to the setup as a whole,
 *  with bucketN 0, so it can never make GO). Null when the setup was not measured. */
export function calStats(cal, setup, regimeScore) {
  const s = cal && cal.setups && cal.setups[setup];
  if (!s || !s.all || !(s.all.n > 0)) return null;
  const b = bucketOf(regimeScore), cell = b && s[b] && s[b].n > 0 ? s[b] : null, row = cell || s.all;
  return { n: row.n, wins: row.wins, avgWinR: row.avgWinR || 0, avgLossR: row.avgLossR || 0, p0: s.all.wins / s.all.n, costR: 0,
    bucketN: cell ? cell.n : 0, significant: !!row.significant };
}
/** The setup's fitted factor weights from `cal`, or null (the defaults stand). */
export function calWeights(cal, setup) {
  const w = cal && cal.weights && cal.weights[setup];
  return w && FACTORS.every((k) => Number.isFinite(w[k])) ? capWeights(w) : null;
}

// No single factor may carry more than this share of a score (Tony, 2026-11-13:
// the first fits gave one factor 0.80 to 0.86, so one input decided the score).
export const WEIGHT_CAP = 0.35;
/** Weights with none above WEIGHT_CAP: each excess is shared by the factors still
 *  under the cap, in proportion to their DEFAULT weights (a fitted 0 gets some
 *  back too), so the weights still sum to what they did. */
export function capWeights(w, cap = WEIGHT_CAP) {
  const out = { ...w };
  for (let pass = 0; pass < FACTORS.length; pass++) {
    const over = FACTORS.filter((k) => out[k] > cap + 1e-12);
    if (!over.length) break;
    let excess = 0;
    for (const k of over) { excess += out[k] - cap; out[k] = cap; }
    const room = FACTORS.filter((k) => out[k] < cap - 1e-12), base = room.reduce((s, k) => s + WEIGHTS[k], 0);
    if (!room.length || !(base > 0)) break;
    for (const k of room) out[k] += excess * WEIGHTS[k] / base;
  }
  return out;
}

/** The size, shown and never acted on → `{ risk, shares, capped, assumed }` or null.
 *  `risk = account · min(0.5·kelly, 1%)`, `kelly = (p·b − (1−p))/b`,
 *  `b = avgWinR/avgLossR`; before a setup is measured the 1% cap is used
 *  (`assumed`). Shares = risk / |entry − stop|, at most 20% of the account. */
export function sizeOf({ entry, stop, account, stats = null, p = null }) {
  if (!(account > 0) || !(Math.abs(entry - stop) > 0)) return null;
  let frac = RISK_CAP, assumed = true;
  if (stats && p != null && stats.avgLossR > 0) {
    const b = stats.avgWinR / stats.avgLossR, kelly = b > 0 ? (p * b - (1 - p)) / b : 0;
    frac = Math.max(0, Math.min(0.5 * kelly, RISK_CAP)); assumed = false;
  }
  const risk = account * frac;
  let shares = Math.floor(risk / Math.abs(entry - stop));
  const most = Math.floor(POSITION_CAP * account / entry), capped = shares > most;
  if (capped) shares = most;
  return { risk, shares, capped, assumed };
}

const PHRASE = {
  trend: (good, dir) => (good ? (dir === 'long' ? 'above its rising averages' : 'below its falling averages') : (dir === 'long' ? 'below its averages' : 'above its averages')),
  momentum: (good, dir, d) => (good ? 'momentum behind it' : 'momentum against it') + (d.rsi == null ? '' : ` (RSI ${Math.round(d.rsi)})`),
  rs: (good, dir, d) => (d.rank == null ? 'relative strength not known' : (good ? (dir === 'long' ? 'stronger' : 'weaker') : (dir === 'long' ? 'weaker' : 'stronger')) + ` than SPY (rank ${Math.round(d.rank)})`),
  volume: (good, dir, d) => (d.rv == null ? (good ? 'accumulation behind it' : 'distribution against it') : (good ? '' : 'light ') + `volume ${d.rv.toFixed(1)}× usual`),
  vol: (good) => (good ? 'volatility in its normal range' : 'volatility at an extreme'),
  structure: (good, dir, d) => (d.room == null ? 'no strong level in the way' : good ? `${d.room.toFixed(1)} ATR of room to the next strong level` : `a strong level ${d.room.toFixed(1)} ATR ahead`),
  regime: (good, dir, d) => (d.regime ? `regime ${d.regime.label} (${Math.round(d.regime.score)})${good ? '' : ' is against it'}` : 'regime not known'),
  event: (good, dir, d) => (d.event === undefined ? 'catalysts not known' : good ? 'no high-impact catalyst before it expires' : `${d.event} falls inside the window`),
};
/** The three strongest factors and the weakest, as plain phrases. */
export function whyOf(f, detail, dir) {
  const order = FACTORS.slice().sort((a, b) => f[b] - f[a] || FACTORS.indexOf(a) - FACTORS.indexOf(b));
  const pick = [...order.slice(0, 3), order[order.length - 1]];
  return pick.map((k) => PHRASE[k](f[k] >= 0.5, dir, detail));
}

/** A small stable hash (cyrb53) → base-36 text. */
export function hash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/** The ledger id: the same symbol, setup and bar always give the same id. */
export const signalId = (symbol, setup, at) => 's' + hash(String(symbol).toUpperCase() + '|' + setup + '|' + at);

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

/** A candidate → the whole signal. */
export function evaluate(cand, ctx, stats = null) {
  const day = cand.horizon === 'day';
  let a, vwapNow = null;
  if (day) { const p = prepDay(ctx.main), k = p.at[ctx.i]; a = p.atr[k]; vwapNow = p.vwap[k]; }
  else a = series(ctx.main).atr[ctx.i];
  if (!a) return null;
  const plan = planOf(cand, ctx.levels, a, vwapNow), expires = expiryOf(cand);
  const { factors, detail } = factorsOf(cand, ctx, plan, expires);
  const cal = ctx.calibration || null, regimeScore = ctx.regime ? ctx.regime.score : null;
  const score = scoreOf(factors, calWeights(cal, cand.setup) || WEIGHTS);
  const st = stats || calStats(cal, cand.setup, regimeScore);
  const v = verdictOf({ score, rr: plan.rr, regimeScore, dir: cand.dir }, st);
  return {
    id: signalId(ctx.symbol, cand.setup, cand.at), symbol: String(ctx.symbol).toUpperCase(),
    setup: cand.setup, horizon: cand.horizon, dir: cand.dir, at: cand.at,
    trigger: r4(cand.trigger), zone: plan.zone.map(r4), entry: r4(plan.entry), stop: r4(plan.stop),
    targets: plan.targets.map(r4), rr: plan.rr.map(r2), risk: r4(plan.risk), atr: r4(a), expires,
    score: Math.round(score * 10) / 10, factors: Object.fromEntries(FACTORS.map((k) => [k, r2(factors[k])])),
    verdict: v.verdict, ev: r2(v.ev), p: r2(v.p), n: v.n, backtested: v.backtested,
    edge: st && v.backtested ? { avgWinR: r2(st.avgWinR), avgLossR: r2(st.avgLossR), significant: st.significant !== false } : null,
    why: whyOf(factors, detail, cand.dir), notes: cand.notes || [],
    regime: ctx.regime ? ctx.regime.label || null : null,
    created: ctx.now == null ? null : ctx.now, status: 'open',
  };
}
