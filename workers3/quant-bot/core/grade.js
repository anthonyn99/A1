// COPY of A1-Priv TradeHub/core/grade.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// What happened to a signal afterwards (docs/TradeHub/quant/phase-05.md).
// Pure: the bars after the signal in, the outcome out.
//
// grade(signal, bars, now) → { status, done, triggeredAt, closedAt, mfe, mae, bars, r }
//   status  open (never entered) → triggered (entered the zone) → target1 →
//           target2 | stopped | expired
//   done    true once nothing can change any more
//   mfe/mae the best and worst excursion after the entry, in R (positive numbers)
//   r       the result in R: −1 stopped, T1's R:R at target1, T2's at target2,
//           where price stood at expiry when it expired after an entry; null
//           when it was never entered.
// The rules: entered when a bar trades inside the zone; then the first of the
// stop and T1, and a bar that spans both counts as stopped (the cautious
// reading), as does the entry bar itself touching the stop (T1 on the entry
// bar does not count: the order inside it is not known). After T1 it runs on
// to T2 until it comes back to the entry or expires. The signal's own bar and
// anything before it are never read; the window ends at `expires`.
import { BAR_MS } from './detect-day.js';

const DAY_MS = 86_400_000;
const r2 = (x) => Math.round(x * 100) / 100;

/** Grade signal `sig` on the bars after it, as of `now` (see above). */
export function grade(sig, bars, now = Infinity) {
  if (sig.horizon === 'invest') return gradeInvest(sig, bars, now);
  const long = sig.dir === 'long', sgn = long ? 1 : -1;
  const [zlo, zhi] = sig.zone, entry = sig.entry, stop = sig.stop, [t1, t2] = sig.targets;
  const R = Math.abs(entry - stop), start = sig.at + (sig.horizon === 'day' ? BAR_MS : DAY_MS);
  const out = { status: 'open', done: false, triggeredAt: null, closedAt: null, mfe: 0, mae: 0, bars: 0, r: null };
  if (!(R > 0)) return out;
  const step = sig.horizon === 'day' ? BAR_MS : DAY_MS;
  // Bars that stop short of the expiry cannot say how it ended: such a grade stays open.
  const covered = (bars || []).some((b) => b.t + step >= sig.expires);
  let lastClose = null, hit1 = false;
  const finish = (status, t, r) => {
    out.status = status; out.done = true; out.closedAt = t; out.r = r == null ? null : r2(r);
    out.mfe = r2(out.mfe); out.mae = r2(out.mae);
    return out;
  };
  for (const b of bars || []) {
    if (b.t < start) continue;
    if (b.t >= sig.expires) break;
    const hi = b.h, lo = b.l;
    if (!out.triggeredAt) {
      if (!(lo <= zhi && hi >= zlo)) continue;
      out.triggeredAt = b.t; out.status = 'triggered';
      out.bars = 1;
      out.mfe = Math.max(0, (long ? hi - entry : entry - lo) / R);
      out.mae = Math.max(0, (long ? entry - lo : hi - entry) / R);
      if (long ? lo <= stop : hi >= stop) return finish('stopped', b.t, -1);
      lastClose = b.c;
      continue;
    }
    out.bars++;
    out.mfe = Math.max(out.mfe, (long ? hi - entry : entry - lo) / R);
    out.mae = Math.max(out.mae, (long ? entry - lo : hi - entry) / R);
    lastClose = b.c;
    if (!hit1) {
      if (long ? lo <= stop : hi >= stop) return finish('stopped', b.t, -1);
      if (long ? hi >= t1 : lo <= t1) {
        hit1 = true; out.status = 'target1';
        if (long ? hi >= t2 : lo <= t2) return finish('target2', b.t, (t2 - entry) * sgn / R);
      }
      continue;
    }
    if (long ? hi >= t2 : lo <= t2) return finish('target2', b.t, (t2 - entry) * sgn / R);
    if (long ? lo <= entry : hi >= entry) return finish('target1', b.t, (t1 - entry) * sgn / R);
  }
  out.mfe = r2(out.mfe); out.mae = r2(out.mae);
  if (now < sig.expires || !covered) return out;   // still running, or the bars to the expiry are not in yet
  if (!out.triggeredAt) return finish('expired', sig.expires, null);
  if (hit1) return finish('target1', sig.expires, (t1 - entry) * sgn / R);
  return finish('expired', sig.expires, lastClose == null ? 0 : (lastClose - entry) * sgn / R);
}

export const INVEST_MARKS = { m1: 21, m3: 63, m6: 126 };
/**
 * An accumulation tranche (horizon 'invest', Phase 7) graded at 1, 3 and 6
 * months → the grade above plus `{ m1, m3, m6 }`: bought at the next day's
 * open; each mark = the close that many sessions in, over the entry; stopped
 * on a close under its invalidation (`stop`, the reversal low), or at once
 * when the next open is already under it (r = −1); done at 6
 * months (`expired`, r = the 6-month move in R) or when stopped (r = its close in R).
 */
export function gradeInvest(sig, bars, now = Infinity) {
  const out = { status: 'open', done: false, triggeredAt: null, closedAt: null, mfe: 0, mae: 0, bars: 0, r: null, m1: null, m3: null, m6: null };
  const after = (bars || []).filter((b) => b.t > sig.at && b.t <= now);
  if (!after.length) return out;
  const entry = after[0].o, R = entry - sig.stop;
  if (!(entry > 0)) return out;
  out.status = 'triggered'; out.triggeredAt = after[0].t;
  // The next open gapped under the invalidation: the plan is void before it starts (−1 R, as a stop at the entry).
  if (!(R > 0)) return Object.assign(out, { status: 'stopped', done: true, closedAt: after[0].t, bars: 1, r: -1 });
  for (let k = 0; k < after.length && k < INVEST_MARKS.m6; k++) {
    const b = after[k];
    out.bars = k + 1;
    out.mfe = Math.max(out.mfe, (b.h - entry) / R); out.mae = Math.max(out.mae, (entry - b.l) / R);
    for (const [m, n] of Object.entries(INVEST_MARKS)) if (k === n - 1) out[m] = Math.round((b.c / entry - 1) * 1e4) / 1e4;
    if (b.c < sig.stop) { Object.assign(out, { status: 'stopped', done: true, closedAt: b.t, r: r2((b.c - entry) / R) }); break; }
    if (k === INVEST_MARKS.m6 - 1) Object.assign(out, { status: 'expired', done: true, closedAt: b.t, r: r2((b.c - entry) / R) });
  }
  out.mfe = r2(out.mfe); out.mae = r2(out.mae);
  return out;
}

/** Per setup: `{ setup, n, wins, hitRate, avgWinR, avgLossR, ev, byRegime: {label: {...same}} }`,
 *  over graded signals that were entered (`r` known), most signals first. */
export function scorecard(signals) {
  const make = () => ({ n: 0, wins: 0, winR: 0, lossR: 0, losses: 0, sumR: 0 });
  const add = (s, r) => { s.n++; s.sumR += r; if (r > 0) { s.wins++; s.winR += r; } else { s.losses++; s.lossR += -r; } };
  const done = (s) => ({ n: s.n, wins: s.wins, hitRate: s.n ? s.wins / s.n : null, avgWinR: s.wins ? s.winR / s.wins : null, avgLossR: s.losses ? s.lossR / s.losses : null, ev: s.n ? s.sumR / s.n : null });
  const by = new Map();
  for (const x of signals || []) {
    if (!x || !x.done || x.r == null || !Number.isFinite(x.r)) continue;
    if (!by.has(x.setup)) by.set(x.setup, { all: make(), reg: new Map() });
    const e = by.get(x.setup), key = x.regime || 'Unknown';
    add(e.all, x.r);
    if (!e.reg.has(key)) e.reg.set(key, make());
    add(e.reg.get(key), x.r);
  }
  return [...by].map(([setup, e]) => ({ setup, ...done(e.all), byRegime: Object.fromEntries([...e.reg].map(([k, s]) => [k, done(s)])) }))
    .sort((a, b) => b.n - a.n || a.setup.localeCompare(b.setup));
}
