// COPY of A1-Priv TradeHub/core/indicators.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Indicators. Pure maths on bars `{t,o,h,l,c,v}` (oldest first) or on a plain
// list of numbers. Every series comes back the same length as its input, with
// `null` until there is enough history, and value `i` never reads past bar
// `i`. Returns and rates are fractions (0.05 = 5%); nothing is rounded here.
import { nyDays } from './clock.js';

const nulls = (n) => new Array(n).fill(null);

/** Simple moving average: mean of the last `n` values. */
export function sma(v, n) {
  const out = nulls(v.length);
  let sum = 0, bad = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] == null) bad++; else sum += v[i];
    if (i >= n) { if (v[i - n] == null) bad--; else sum -= v[i - n]; }
    if (i >= n - 1 && bad === 0) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average: seeded with the SMA of the first `n` values,
 *  then `e += k·(x − e)` with `k = 2/(n+1)` (pass `k` to change it). It starts
 *  at the first run of `n` values with no null among them; a null after that
 *  leaves the average where it was. */
export function ema(v, n, k = 2 / (n + 1)) {
  const out = nulls(v.length);
  let s = 0;
  for (let i = 0; i < v.length && i < s + n; i++) if (v[i] == null) s = i + 1;
  if (s + n > v.length) return out;
  let e = 0;
  for (let i = s; i < s + n; i++) e += v[i];
  e /= n;
  out[s + n - 1] = e;
  for (let i = s + n; i < v.length; i++) {
    if (v[i] != null) e += k * (v[i] - e);
    out[i] = e;
  }
  return out;
}

/** Wilder's smoothing: `(prev·(n−1) + x)/n`, an EMA with `k = 1/n`. */
export const wilder = (v, n) => ema(v, n, 1 / n);

/** RSI (Wilder): `100 − 100/(1 + avgGain/avgLoss)`, both Wilder-smoothed. */
export function rsi(c, n = 14) {
  const g = nulls(c.length), l = nulls(c.length);
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g[i] = d > 0 ? d : 0;
    l[i] = d < 0 ? -d : 0;
  }
  const ag = wilder(g, n), al = wilder(l, n);
  return ag.map((x, i) => (x == null ? null : al[i] === 0 ? (x === 0 ? 50 : 100) : 100 - 100 / (1 + x / al[i])));
}

/** True range: `max(h−l, |h−prevClose|, |l−prevClose|)`; null on the first bar. */
export function trueRange(bars) {
  const out = nulls(bars.length);
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    out[i] = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  }
  return out;
}

/** ATR (Wilder): Wilder-smoothed true range; first value at bar `n`. */
export const atr = (bars, n = 14) => wilder(trueRange(bars), n);

/** ADX (Wilder) → `{ adx, plusDI, minusDI }`: `DI = 100·W(±DM)/W(TR)`,
 *  `DX = 100·|+DI − −DI|/(+DI + −DI)`, `ADX = W(DX)`; W = Wilder's smoothing. */
export function adx(bars, n = 14) {
  const N = bars.length, pdm = nulls(N), mdm = nulls(N);
  for (let i = 1; i < N; i++) {
    const up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
  }
  const tr = wilder(trueRange(bars), n), p = wilder(pdm, n), m = wilder(mdm, n);
  const plusDI = nulls(N), minusDI = nulls(N), dx = nulls(N);
  for (let i = 0; i < N; i++) {
    if (tr[i] == null) continue;
    plusDI[i] = tr[i] ? 100 * p[i] / tr[i] : 0;
    minusDI[i] = tr[i] ? 100 * m[i] / tr[i] : 0;
    const s = plusDI[i] + minusDI[i];
    dx[i] = s ? 100 * Math.abs(plusDI[i] - minusDI[i]) / s : 0;
  }
  return { adx: wilder(dx, n), plusDI, minusDI };
}

/** Bollinger bands → `{ mid, upper, lower, width }`: `mid = SMA(n)`,
 *  `upper/lower = mid ± k·σ` (population σ of the window), `width = (upper − lower)/mid`. */
export function bollinger(c, n = 20, k = 2) {
  const N = c.length, mid = sma(c, n), upper = nulls(N), lower = nulls(N), width = nulls(N);
  for (let i = n - 1; i < N; i++) {
    if (mid[i] == null) continue;
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) ss += (c[j] - mid[i]) ** 2;
    const sd = Math.sqrt(ss / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
    width[i] = mid[i] ? (upper[i] - lower[i]) / mid[i] : null;
  }
  return { mid, upper, lower, width };
}

/** Session VWAP: cumulative `Σ(tp·v)/Σv`, `tp = (h+l+c)/3`, starting again at
 *  each session start. `sessionStart(bar, prevBar)` says where one begins; by
 *  default a new New York date. Null while the session has no volume. */
export function vwap(bars, { sessionStart } = {}) {
  const out = nulls(bars.length);
  const day = sessionStart ? null : nyDays(bars.map((b) => b.t)).day;
  let pv = 0, vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i > 0 && (sessionStart ? sessionStart(b, bars[i - 1]) : day[i] !== day[i - 1])) { pv = 0; vol = 0; }
    const v = volOf(b);
    pv += (b.h + b.l + b.c) / 3 * v;
    vol += v;
    if (vol > 0) out[i] = pv / vol;
  }
  return out;
}

/** VWAP anchored at bar `i0`: `Σ(tp·v)/Σv` from `i0` on; null before it. */
export function anchoredVwap(bars, i0) {
  const out = nulls(bars.length);
  let pv = 0, vol = 0;
  for (let i = Math.max(0, i0); i < bars.length; i++) {
    const b = bars[i], v = volOf(b);
    pv += (b.h + b.l + b.c) / 3 * v;
    vol += v;
    if (vol > 0) out[i] = pv / vol;
  }
  return out;
}
/** A bar's volume for weighting (VWAPs): none when it is not known (BV: Yahoo's lumps never pull a VWAP).
 *  One exchange's volume still weighs the newest minutes' prices against each other, and is re-read. */
export const volOf = (b) => (b.vx === 'none' ? 0 : b.v);

/** Rate of change: `c_t / c_{t−n} − 1`. */
export function roc(c, n) {
  return c.map((x, i) => (i < n || !c[i - n] ? null : x / c[i - n] - 1));
}

/** MACD → `{ macd, signal, hist }`: `macd = EMA(fast) − EMA(slow)`,
 *  `signal = EMA(macd, sig)`, `hist = macd − signal`. */
export function macd(c, fast = 12, slow = 26, sig = 9) {
  const f = ema(c, fast), s = ema(c, slow);
  const line = s.map((x, i) => (x == null || f[i] == null ? null : f[i] - x));
  const signal = ema(line, sig);
  return { macd: line, signal, hist: signal.map((x, i) => (x == null ? null : line[i] - x)) };
}

/** The average volume of the last `n` WHOLE bars (BV: a bar marked `vx`, one exchange's volume or none
 *  known, is left out of every average and gets null itself, so a partial bar never reads as quiet). */
export function volAvgWhole(bars, n = 20) {
  const out = nulls(bars.length), q = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].vx) continue;
    q.push(bars[i].v); sum += bars[i].v;
    if (q.length > n) sum -= q.shift();
    if (q.length === n) out[i] = sum / n;
  }
  return out;
}

/** Relative volume, daily: `v / average(v, n)` over whole bars (the window includes the bar itself);
 *  null on a bar whose volume is partial or not known (BV). `floor: true` (rules and detectors): a
 *  partial bar gets its ratio anyway, a FLOOR (one exchange's volume is never more than the market's), so
 *  "relative volume ≥ 2" fires only when it is surely true; unknown volume is still null. */
export function relVolume(bars, n = 20, { floor = false } = {}) {
  const avg = volAvgWhole(bars, n);
  let last = null;
  return avg.map((a, i) => { if (a) last = a; const vx = bars[i].vx; return vx === 'none' ? null : !vx ? (a ? bars[i].v / a : null) : floor && last ? bars[i].v / last : null; });
}

/** Relative volume, intraday: `v / mean(v at the same minute of day over the
 *  last n sessions, this one included)`, so the open and the close are
 *  compared with other opens and closes. */
export function relVolumeIntraday(bars, n = 20, { floor = false } = {}) {
  const out = nulls(bars.length), { minute } = nyDays(bars.map((b) => b.t)), seen = new Map();
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].vx) {   // BV: partial or unknown volume is never counted; a partial bar is rated as a floor when asked
      const q0 = floor && bars[i].vx !== 'none' ? seen.get(minute[i]) : null;
      if (q0 && q0.length === n) { let s0 = 0; for (const x of q0) s0 += x; if (s0 > 0) out[i] = bars[i].v * n / s0; }
      continue;
    }
    let q = seen.get(minute[i]);
    if (!q) seen.set(minute[i], q = []);
    q.push(bars[i].v);
    if (q.length > n) q.shift();
    if (q.length === n) {
      let s = 0;
      for (const x of q) s += x;
      if (s > 0) out[i] = bars[i].v * n / s;
    }
  }
  return out;
}

/** Percent rank: the share (0 to 1) of the previous `n` values below the current one. */
export function percentRank(v, n) {
  const out = nulls(v.length);
  for (let i = n; i < v.length; i++) {
    if (v[i] == null) continue;
    let below = 0, ok = true;
    for (let j = i - n; j < i; j++) { if (v[j] == null) { ok = false; break; } if (v[j] < v[i]) below++; }
    if (ok) out[i] = below / n;
  }
  return out;
}
