// COPY of A1-Priv TradeHub/core/weekly.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Weekly bars from daily ones, shared by the levels' weekly vote, the chart
// and the swing detectors. Pure.
import { nyClock } from './clock.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;

/** The Monday ('YYYY-MM-DD') of the New York week holding bar time `t`. */
export function mondayOf(t) {
  const c = nyClock(t + 12 * HOUR), d = new Date(c.date + 'T12:00:00Z');
  return new Date(d.getTime() - ((c.dow + 6) % 7) * DAY).toISOString().slice(0, 10);
}

/** Weekly bars from daily ones: a week = Monday to Friday in New York, opened
 *  by its first day's bar (the levels' weekly vote). */
export function toWeekly(daily) {
  const out = [];
  let key = null;
  for (const b of daily || []) {
    const monday = mondayOf(b.t), last = out[out.length - 1];
    if (monday !== key) { key = monday; out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }); }
    else { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; }
  }
  return out;
}
