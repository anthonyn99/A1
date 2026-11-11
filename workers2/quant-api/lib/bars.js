// Bars in the worker: one shape ({t,o,h,l,c,v}, oldest first, as A1-Priv
// TradeHub/core/contracts.js), whichever provider served them.
//
// Daily bars are stamped 00:00 New York of their trading day whatever the
// provider says (Alpaca stamps midnight, Yahoo the 09:30 open), so two sources
// join without doubles. Weekly and monthly bars are built here from daily
// ones, and 4-hour bars from hourly ones (buckets 04:00, 08:00, 12:00, 16:00
// New York), so every provider gives the same buckets.
import { nyClock, nyDate, nyMidnight } from './time.js';

export const TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mo'];
export const INTRADAY = new Set(['1m', '5m', '15m', '30m', '1h', '4h']);
/** The timeframe a provider is asked for, before aggregation here. */
export const BASE_TF = { '4h': '1h', '1w': '1d', '1mo': '1d' };

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** A bar from loose fields, or null when any price is missing. */
export function bar(t, o, h, l, c, v) {
  if ([t, o, h, l, c].some((x) => num(x) === null)) return null;
  return { t, o, h, l, c, v: num(v) === null || v < 0 ? 0 : v };
}

export const dailyStamp = (t) => nyMidnight(nyDate(t));

/** Sort, and keep the LAST bar given for a time (later sources win). */
export function mergeBars(...lists) {
  const m = new Map();
  for (const list of lists) for (const b of list || []) if (b) m.set(b.t, b);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/** Group bars by `keyOf(t)` into one bar each (first open, highest high,
 *  lowest low, last close, summed volume), stamped with the group's key. */
export function aggregate(bars, keyOf) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const k = keyOf(b.t);
    if (!cur || cur.t !== k) { cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; out.push(cur); continue; }
    if (b.h > cur.h) cur.h = b.h;
    if (b.l < cur.l) cur.l = b.l;
    cur.c = b.c; cur.v += b.v;
  }
  return out;
}
/** The Monday of the New York week holding `t` (daily bars are New York midnights). */
export function weekKey(t) {
  const d = nyDate(t), dow = nyClock(t).dow;
  const [y, m, dd] = d.split('-').map(Number);
  const monday = new Date(Date.UTC(y, m - 1, dd - ((dow + 6) % 7)));
  return nyMidnight(monday.toISOString().slice(0, 10));
}
export const monthKey = (t) => nyMidnight(nyDate(t).slice(0, 8) + '01');
export function fourHourKey(t) {
  const c = nyClock(t);
  const start = Math.max(240, 240 + Math.floor((c.minutes - 240) / 240) * 240);
  return nyMidnight(c.date) + start * 60_000;
}
/** Bars of `base` turned into `tf` (only the pairs in BASE_TF). */
export function toTimeframe(bars, tf) {
  if (tf === '1w') return aggregate(bars, weekKey);
  if (tf === '1mo') return aggregate(bars, monthKey);
  if (tf === '4h') return aggregate(bars, fourHourKey);
  return bars;
}

/** Undo split adjustment: `splits` = [{ t, ratio }] (ratio = new shares per
 *  old, 4 for a 4-for-1). Every bar before a split is multiplied back. */
export function unsplit(bars, splits) {
  if (!splits || !splits.length) return bars;
  return bars.map((b) => {
    let f = 1;
    for (const s of splits) if (b.t < s.t && s.ratio > 0) f *= s.ratio;
    return f === 1 ? b : { t: b.t, o: b.o * f, h: b.h * f, l: b.l * f, c: b.c * f, v: Math.round(b.v / f) };
  });
}

export const within = (bars, from, to) => bars.filter((b) => b.t >= from && b.t <= to);
