// COPY of A1-Priv TradeHub/core/pivots.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Swing highs and lows, and grouping them into lines and zones: the raw
// material of levels.js. Pure.

/** Confirmed swing points → `[{ i, t, type: 'high'|'low', price, v, known }]`,
 *  oldest first. Bar `i` is a swing high when its high is above the `left`
 *  bars before it and not below the `right` bars after it (a low likewise).
 *  It is only known once those `right` bars exist: `known = i + right`. */
export function pivots(bars, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < bars.length - right; i++) {
    const h = bars[i].h, l = bars[i].l;
    let hi = true, lo = true;
    for (let j = i - left; j < i; j++) { if (bars[j].h >= h) hi = false; if (bars[j].l <= l) lo = false; }
    for (let j = i + 1; j <= i + right && (hi || lo); j++) { if (bars[j].h > h) hi = false; if (bars[j].l < l) lo = false; }
    if (hi) out.push({ i, t: bars[i].t, type: 'high', price: h, v: bars[i].v, known: i + right });
    if (lo) out.push({ i, t: bars[i].t, type: 'low', price: l, v: bars[i].v, known: i + right });
  }
  return out;
}

export const ZONE_MAX = 5;   // cluster(): a group never grows wider than 5 × tol (0.75 ATR at the usual tol)

// Tony 2026-11-22 ("make it WAY smarter: a box where it is a zone, a line where a line is enough, even when a few sit
// close together"): structure() replaces the B11 merge (every close neighbour joined into a box). Swing points are spread
// into a price density (log price, each a bump BW ATRs wide at its own bar's volatility, taller for a bigger turn); each
// peak of that density is one level, two peaks join only when the dip between them is shallow (VALLEY), and a level is a
// LINE when its touches agree within LINE_SPREAD ATR, else a ZONE (box) over the middle 80% of its touches, never wider
// than ZONE_CAP (wider splits at its widest gap). Neighbours that touch (GAP) are judged again as one.
// Measured walk-forward on 16 tickers x 10 years (docs/TradeHub/quant/levels-smart.md).
export const BW = 0.15, VALLEY = 0.7, LINE_SPREAD = 0.3, ZONE_CAP = 1.2, GAP = 0.25, MIN_PROM = 0.75, PROM_BARS = 10;

/** How big a turn swing point `p` was, in ATRs at its own bar: the smaller of the move into it and the move out of it
 *  (PROM_BARS bars each way, up to bar `last`). */
export function prominence(p, bars, A, last = bars.length - 1) {
  const a = A[p.i];
  if (!a) return 0;
  let after = 0, before = 0;
  for (let j = p.i + 1; j <= Math.min(last, p.i + PROM_BARS); j++) after = Math.max(after, p.type === 'high' ? p.price - bars[j].l : bars[j].h - p.price);
  for (let j = Math.max(0, p.i - PROM_BARS); j < p.i; j++) before = Math.max(before, p.type === 'high' ? p.price - bars[j].l : bars[j].h - p.price);
  return Math.min(after, before) / a;
}

const quantile = (s, q) => { const x = (s.length - 1) * q, a = Math.floor(x), b = Math.ceil(x); return s[a] + (s[b] - s[a]) * (x - a); };

/** Swing points → levels `[{ kind: 'line'|'zone', price, lo, hi, pivots }]`, lowest first (see above). `A` = ATR series
 *  over `bars`; `aNow`/`priceNow` = today's ATR and price (touching neighbours are judged at no less than today's
 *  volatility, as they read on today's chart). A swing point under MIN_PROM ATRs is noise and left out, except in the
 *  last 3 bars, where the move out of it has not happened yet. */
export function structure(piv, bars, A, aNow, priceNow) {
  const last = bars.length - 1, pts = [];
  for (const p of piv) {
    const pr = prominence(p, bars, A, last);
    if (pr < MIN_PROM && p.i < last - 3) continue;
    const r = (A[p.i] || aNow) / p.price;
    pts.push({ p, x: Math.log(p.price), s: BW * r, r, w: 1 + Math.min(pr, 3) / 3 });
  }
  if (!pts.length) return [];
  pts.sort((u, v) => u.x - v.x);
  // The density on a grid fine enough for the narrowest bump.
  const x0 = pts[0].x - 4 * pts[0].s, x1 = pts[pts.length - 1].x + 4 * pts[pts.length - 1].s;
  let smin = Infinity;
  for (const q of pts) smin = Math.min(smin, q.s);
  const step = Math.max(smin / 3, (x1 - x0) / 6000), G = Math.ceil((x1 - x0) / step) + 1, d = new Float64Array(G);
  for (const q of pts) {
    const g0 = Math.max(0, Math.floor((q.x - 3 * q.s - x0) / step)), g1 = Math.min(G - 1, Math.ceil((q.x + 3 * q.s - x0) / step));
    for (let g = g0; g <= g1; g++) { const z = (x0 + g * step - q.x) / q.s; d[g] += q.w * Math.exp(-0.5 * z * z); }
  }
  const valley = (a, b) => { let v = Infinity, at = a; for (let g = a; g <= b; g++) if (d[g] < v) { v = d[g]; at = g; } return [v, at]; };
  let peaks = [];
  for (let g = 1; g < G - 1; g++) if (d[g] > d[g - 1] && d[g] >= d[g + 1]) peaks.push(g);
  if (!peaks.length) peaks = [d.indexOf(Math.max(...d))];
  // Shallow dips go first: the two peaks become one (the taller stands for both).
  for (;;) {
    let best = -1, bestR = 0;
    for (let k = 0; k + 1 < peaks.length; k++) {
      const r = valley(peaks[k], peaks[k + 1])[0] / Math.min(d[peaks[k]], d[peaks[k + 1]]);
      if (r >= VALLEY && r > bestR) { bestR = r; best = k; }
    }
    if (best < 0) break;
    peaks.splice(best, 2, d[peaks[best]] >= d[peaks[best + 1]] ? peaks[best] : peaks[best + 1]);
  }
  // Each swing point belongs to the peak on its side of the deepest point of each dip.
  const cuts = [];
  for (let k = 0; k + 1 < peaks.length; k++) cuts.push(x0 + valley(peaks[k], peaks[k + 1])[1] * step);
  const buckets = peaks.map(() => []);
  let c = 0;
  for (const q of pts) { while (c < cuts.length && q.x > cuts[c]) c++; buckets[c].push(q); }

  // One bucket → one level, line or zone (or two, split at the widest gap, when too wide for one zone).
  const make = (qs, floor, out) => {
    const xs = qs.map((q) => q.x), rel = Math.max(floor, qs.reduce((t, q) => t + q.r, 0) / qs.length);
    const lo = qs.length >= 5 ? quantile(xs, 0.1) : xs[0], hi = qs.length >= 5 ? quantile(xs, 0.9) : xs[xs.length - 1];
    const width = (Math.exp(hi) - Math.exp(lo)) / (Math.exp((lo + hi) / 2) * rel);   // in ATRs at that price
    if (width > ZONE_CAP && qs.length >= 2) {
      let gi = 1, gw = -1;
      for (let k = 1; k < qs.length; k++) if (qs[k].x - qs[k - 1].x > gw) { gw = qs[k].x - qs[k - 1].x; gi = k; }
      make(qs.slice(0, gi), floor, out); make(qs.slice(gi), floor, out);
      return out;
    }
    const prices = qs.map((q) => q.p.price), tot = qs.reduce((t, q) => t + q.w, 0);
    const g = { kind: 'line', price: 0, lo: prices[0], hi: prices[prices.length - 1], pivots: qs.map((q) => q.p).sort((u, v) => u.i - v.i), qs };
    if (width <= LINE_SPREAD) {
      // A line at the weighted median of its touches: the price they agree on.
      let acc = 0;
      for (const q of qs) { acc += q.w; if (acc >= tot / 2) { g.price = q.p.price; break; } }
    } else {
      g.kind = 'zone'; g.lo = Math.exp(lo); g.hi = Math.exp(hi);
      g.price = Math.min(g.hi, Math.max(g.lo, qs.reduce((t, q) => t + q.p.price * q.w, 0) / tot));
    }
    out.push(g);
    return out;
  };
  let out = [];
  for (const b of buckets) if (b.length) make(b, 0, out);
  // Touching neighbours that fit one zone become one level, judged again.
  const relNow = aNow / priceNow;
  for (let again = true; again;) {
    again = false;
    out.sort((u, v) => u.lo - v.lo);
    for (let k = 0; k + 1 < out.length; k++) {
      const u = out[k], v = out[k + 1], rel = Math.max((u.qs[0].r + v.qs[0].r) / 2, relNow), mid = (u.hi + v.lo) / 2;
      if (v.lo - u.hi > GAP * rel * mid || Math.max(u.hi, v.hi) - u.lo > ZONE_CAP * rel * mid) continue;
      const made = make([...u.qs, ...v.qs].sort((a, b) => a.x - b.x), rel, []);
      if (made.length === 1) { out.splice(k, 2, made[0]); again = true; break; }
    }
  }
  for (const g of out) delete g.qs;
  return out.sort((u, v) => u.lo - v.lo);
}

/** Group swing points by price → `[{ kind: 'line'|'zone', price, lo, hi, pivots }]`,
 *  lowest first. A point joins the group below it when it is within `tol` of
 *  that group's highest point (and the group stays under `maxWidth`). A group
 *  narrower than `tol` is a line, wider is a zone; `price` = the mean of its
 *  points weighted by their bar's volume. */
export function cluster(pivotList, tol, maxWidth = ZONE_MAX * tol, ref = null) {
  // B11: with `ref` (the price `tol` was worked out at), tol and maxWidth scale with price, so a stock that went
  // from 60 to 1,200 is not grouped at 60 with a tolerance made for 1,200 (MU's 61-144 "zone").
  const k = (x) => (ref > 0 ? x / ref : 1);
  const sorted = [...pivotList].sort((a, b) => a.price - b.price || a.i - b.i), groups = [];
  let g = null;
  for (const p of sorted) {
    if (g && p.price - g[g.length - 1].price <= tol * k(p.price) && p.price - g[0].price <= maxWidth * k(g[0].price)) g.push(p);
    else groups.push(g = [p]);
  }
  return groups.map((ps) => {
    const lo = ps[0].price, hi = ps[ps.length - 1].price;
    let pv = 0, vol = 0, sum = 0;
    for (const p of ps) { pv += p.price * (p.v || 0); vol += p.v || 0; sum += p.price; }
    return {
      kind: hi - lo < tol * k(lo) ? 'line' : 'zone',
      price: vol > 0 ? pv / vol : sum / ps.length,
      lo, hi,
      pivots: ps.sort((a, b) => a.i - b.i),
    };
  });
}
