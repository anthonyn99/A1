// COPY of A1-Priv TradeHub/core/levels.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Ranked supports and resistances. Swing points (pivots.js) are grouped into
// lines and zones (structure(): a line where the touches agree, a box where they spread), each is scored 0 to 100 on how often and how hard price
// turned there, and they are numbered outward from the current price. Pure.
import { atr, sma, relVolume, vwap } from './indicators.js';
import { pivots, cluster, structure } from './pivots.js';
import { gaps, priorLevels } from './prior-levels.js';

export { pivots, cluster, priorLevels };

export const TOL_ATR = 0.15;                    // two prices within 0.15 ATR are the same level
// How levels are found (lines vs zones): core/pivots.js structure(), Tony 2026-11-22. Which to keep: each side keeps its
// NEAR nearest, always the extreme swing of the window (MU's 1,100 double top and 1,255 high, B11), then the strongest.
export const NEAR = 2;
export const STRONG = 66, MEDIUM = 40;
// Each part's weight in a level's score (scoreLevel). Phase 6's levels check
// (core/levelcheck.js) measures whether Strong holds more often than Medium and
// Medium than Weak; a retune changes these and is recorded in quant-plan.md §0.
export const LEVEL_WEIGHTS = { touches: 25, reaction: 20, volume: 15, recency: 15, timeframes: 15, confluence: 10, breaks: -15 };
export const LEVEL_PARTS = Object.keys(LEVEL_WEIGHTS);
/** A score from a level's parts and `w`: `Σ wₖ·partₖ`, kept within 0 to 100. */
export const scoreFromParts = (parts, w = LEVEL_WEIGHTS) => Math.max(0, Math.min(100, LEVEL_PARTS.reduce((s, k) => s + w[k] * (parts[k] || 0), 0)));
export const TIMEFRAMES = ['intraday', 'daily', 'weekly'];
const REACT_BARS = 5, REACT_CAP = 3, VOL_CAP = 2.5, RECENCY = 120, GAP_BARS = 120;

/** Strong (≥66), Medium (40 to 65) or Weak (<40). */
export const rankOf = (score) => (score >= STRONG ? 'Strong' : score >= MEDIUM ? 'Medium' : 'Weak');

/** The round number nearest `p`: steps of 1 under 20, 5 under 100, 10 under 500, 50 under 2000, else 100. */
export function roundNumber(p) {
  const step = p < 20 ? 1 : p < 100 ? 5 : p < 500 ? 10 : p < 2000 ? 50 : 100;
  return Math.round(p / step) * step;
}

// The swing points of a level that were already confirmed at bar i.
const knownAt = (level, i) => level.pivots.filter((p) => (p.known == null ? p.i : p.known) <= i);

/** A level's role at bar `i` and how often it has been broken → `{ role, breaks }`.
 *  It starts as resistance when its first swing point is a high, support when
 *  a low; two closes in a row beyond it by `tol` are a clean break, which
 *  flips the role and counts once. Null role while none of its points is confirmed. */
export function roleOf(level, { bars, tol, i = bars.length - 1 }) {
  const first = knownAt(level, i)[0];
  if (!first) return { role: null, breaks: 0 };
  let role = first.type === 'high' ? 'resistance' : 'support', breaks = 0, run = 0;
  for (let j = first.i + 1; j <= i; j++) {
    const c = bars[j].c, beyond = role === 'resistance' ? c > level.hi + tol : c < level.lo - tol;
    run = beyond ? run + 1 : 0;
    if (run >= 2) { role = role === 'resistance' ? 'support' : 'resistance'; breaks++; run = 0; }
  }
  return { role, breaks };
}

/** Score a level 0 to 100 → `{ score, rank, role, breaks, parts, why }`:
 *  `25·touches + 20·reaction + 15·volume + 15·recency + 15·timeframes + 10·confluence − 15·breaks`,
 *  each term scaled 0 to 1: touches `min(n,5)/5`; reaction = the average move
 *  away within 5 bars of a touch, in ATRs, capped at 3, `/3`; volume = the
 *  average relative volume at the touches, capped at 2.5, `/2.5`; recency =
 *  `exp(−barsSinceLastTouch/120)`; timeframes = `ctx.tfShare`; confluence = 1
 *  when `ctx.confluence` names anything; breaks `min(n,3)/3`.
 *  `ctx`: `{ bars, atr, relVol, tol, tfShare, confluence, i }` (`atr` and
 *  `relVol` are series over `bars`; `i` = the current bar, the last by
 *  default; only swing points confirmed by bar `i` count). */
export function scoreLevel(level, ctx) {
  const { bars, tol, tfShare = 1 / 3, confluence = [] } = ctx, i = ctx.i == null ? bars.length - 1 : ctx.i;
  const ps = knownAt(level, i), n = ps.length;
  if (!n) return { score: 0, rank: rankOf(0), role: null, breaks: 0, parts: {}, why: [] };
  let react = 0, reacts = 0, vol = 0, vols = 0;
  for (const p of ps) {
    const a = ctx.atr[p.i], end = Math.min(p.i + REACT_BARS, i);
    if (a && end > p.i) {
      let far = p.price;
      for (let j = p.i + 1; j <= end; j++) far = p.type === 'high' ? Math.min(far, bars[j].l) : Math.max(far, bars[j].h);
      react += Math.abs(far - p.price) / a; reacts++;
    }
    const rv = ctx.relVol[p.i];
    if (rv != null) { vol += rv; vols++; }
  }
  const lastTouch = ps[n - 1].i, { role, breaks } = roleOf(level, { bars, tol, i });
  const reaction = reacts ? react / reacts : 0, volume = vols ? vol / vols : 1;
  const parts = {
    touches: Math.min(n, 5) / 5,
    reaction: Math.min(reaction, REACT_CAP) / REACT_CAP,
    volume: Math.min(volume, VOL_CAP) / VOL_CAP,
    recency: Math.exp(-(i - lastTouch) / RECENCY),
    timeframes: tfShare,
    confluence: confluence.length ? 1 : 0,
    breaks: Math.min(breaks, 3) / 3,
  };
  const score = scoreFromParts(parts);
  const why = [
    n + (n === 1 ? ' touch' : ' touches'),
    'turned ' + reaction.toFixed(1) + ' ATR away',
    'volume ' + volume.toFixed(1) + '× usual',
    'last touched ' + (i - lastTouch) + ' bars ago',
  ];
  if (ctx.seen && ctx.seen.length) why.push('seen on ' + ctx.seen.join(', '));
  if (confluence.length) why.push('at ' + confluence.join(', '));
  if (breaks) why.push('broken ' + breaks + (breaks === 1 ? ' time' : ' times'));
  return { score, rank: rankOf(score), role, breaks, parts, why };
}

// Is any of `sorted` (ascending prices) inside lo..hi?
function anyWithin(sorted, lo, hi) {
  let a = 0, b = sorted.length;
  while (a < b) { const m = (a + b) >> 1; if (sorted[m] < lo) a = m + 1; else b = m; }
  return a < sorted.length && sorted[a] <= hi;
}

/** Ranked levels → `{ supports, resistances, tol, atr }`, each list numbered
 *  outward from `price` (S1 and R1 nearest), each level
 *  `{ name, kind: 'line'|'zone', price, lo, hi, score, rank, touches, lastTouch, breaks, why, pts }`
 *  (`lo`/`hi` only on a zone; `lastTouch` = that bar's time).
 *  A level under `price` is a support and one over it a resistance; with
 *  price inside it, its history decides (see `roleOf`).
 *  `barsByTf` = `{ intraday, daily, weekly }`, any of them; levels are found
 *  on daily bars (else intraday, else weekly) with `tol = 0.15·ATR14`, and the
 *  other timeframes only vote on whether they see each one. `price` defaults
 *  to the last close. `opts`: `{ left, right, max }` (swing width; levels per side, 8). */
export function levels(barsByTf, price, opts = {}) {
  const tfs = barsByTf || {}, { left = 3, right = 3, max = 8 } = opts;
  const main = ['daily', 'intraday', 'weekly'].find((k) => tfs[k] && tfs[k].length), bars = main ? tfs[main] : [];
  const empty = { supports: [], resistances: [], tol: null, atr: null };
  const A = atr(bars, 14);
  let a = null;
  for (let i = A.length - 1; i >= 0 && a == null; i--) a = A[i];
  if (!a) return empty;
  const tol = TOL_ATR * a, last = bars.length - 1;
  if (price == null) price = bars[last].c;

  const others = TIMEFRAMES.filter((k) => k !== main && tfs[k] && tfs[k].length)
    .map((k) => ({ k, prices: pivots(tfs[k], left, right).map((p) => p.price).sort((x, y) => x - y) }));

  // What else sits at a price: moving averages, today's VWAP, open gaps.
  // The averages are the daily ones, so without daily bars there are none.
  const marks = [], closes = (tfs.daily || []).map((b) => b.c);
  for (const n of [20, 50, 200]) { const m = sma(closes, n)[closes.length - 1]; if (m != null) marks.push(['MA' + n, m]); }
  if (tfs.intraday && tfs.intraday.length) { const v = vwap(tfs.intraday); if (v[v.length - 1] != null) marks.push(['VWAP', v[v.length - 1]]); }
  for (const g of gaps(tfs.daily || [], GAP_BARS)) if (!g.filled && g.hi - g.lo >= tol) marks.push(['gap edge', g.lo], ['gap edge', g.hi]);

  const ctx = { bars, atr: A, relVol: relVolume(bars, 20), tol, i: last };
  const supports = [], resistances = [];
  const piv = pivots(bars, left, right);
  for (const g of structure(piv, bars, A, a, price)) {
    const lo = g.lo - tol, hi = g.hi + tol;
    const seen = [main, ...others.filter((o) => anyWithin(o.prices, lo, hi)).map((o) => o.k)];
    const confluence = [...new Set(marks.filter(([, p]) => p >= lo && p <= hi).map(([name]) => name))];
    const round = roundNumber(g.price);
    if (round >= lo && round <= hi) confluence.push('round number ' + round);
    // What is drawn: a zone's box, a line's price (its touches may sit a little either side of it).
    const bot = g.kind === 'zone' ? g.lo : g.price, top = g.kind === 'zone' ? g.hi : g.price;
    const s = scoreLevel(g, { ...ctx, tfShare: seen.length / TIMEFRAMES.length, confluence, seen });
    const level = {
      kind: g.kind, price: g.price, score: s.score, rank: s.rank,
      touches: g.pivots.length, lastTouch: g.pivots[g.pivots.length - 1].t, breaks: s.breaks, why: s.why, parts: s.parts,
      // Tony 2026-11-21: where price turned at it ([time, price, 'high'|'low'] each), for the Levels card's full chart.
      pts: g.pivots.map((p) => [p.t, p.price, p.type]),
      // How far price is from it: 0 inside a zone.
      dist: price > top ? price - top : price < bot ? bot - price : 0,
    };
    if (g.kind === 'zone') { level.lo = g.lo; level.hi = g.hi; }
    // Below price it holds price up, above it caps it; with price inside it, its history decides.
    const role = price > top ? 'support' : price < bot ? 'resistance' : s.role;
    (role === 'support' ? supports : resistances).push(level);
  }
  // Which to keep (B11): the NEAR nearest each way, then the strongest, and the side's extreme swing of the window
  // (the highest high above price, the lowest low below it) always, so a major top or bottom is never crowded out.
  const pick = (list, extreme) => {
    const byDist = list.slice().sort((x, y) => x.dist - y.dist || y.score - x.score);
    const keep = new Set(byDist.slice(0, Math.min(NEAR, max)));
    // A level's touches may sit a little outside what is drawn: the extreme is matched against all of them.
    const span = (l) => { const ps = l.pts.map((x) => x[1]).concat(l.kind === 'zone' ? [l.lo, l.hi] : [l.price]); return [Math.min(...ps), Math.max(...ps)]; };
    const ext = extreme != null ? list.find((l) => { const [lo, hi] = span(l); return extreme >= lo - tol && extreme <= hi + tol; }) : null;
    if (ext && keep.size < max) keep.add(ext);
    for (const l of list.slice().sort((x, y) => y.score - x.score || x.dist - y.dist)) { if (keep.size >= max) break; keep.add(l); }
    return byDist.filter((l) => keep.has(l));
  };
  const highs = piv.filter((p) => p.type === 'high' && p.price > price), lows = piv.filter((p) => p.type === 'low' && p.price < price);
  const top = highs.length ? Math.max(...highs.map((p) => p.price)) : null, bottom = lows.length ? Math.min(...lows.map((p) => p.price)) : null;
  const number = (list, letter, extreme) => pick(list, extreme).map(({ dist, ...l }, k) => ({ name: letter + (k + 1), ...l }));
  return { supports: number(supports, 'S', bottom), resistances: number(resistances, 'R', top), tol, atr: a };
}
